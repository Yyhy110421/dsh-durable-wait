/**
 * dsh-durable-wait 引擎：持久状态、轮询、条件成立后叫醒会话。
 *
 * 设计约束：
 * - 只读系统：文件 stat + process.kill(pid, 0)，不杀进程、不写目标文件。
 * - 状态落盘：DSH 重启后等待仍在。
 * - 只恢复一次：会话不在线时尝试 agents.resume 一次，失败标 undelivered，不循环重试。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  KIND_META,
  conditionMet,
  describeWait,
  normalizeSettings,
  publicWait,
  readSnapshot,
  targetLabel,
  validateCreate,
} from './core.js'

function atomicWrite(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function pickAgentOptions(value) {
  const source = value && typeof value === 'object' ? value : {}
  const result = {}
  for (const key of ['provider', 'model', 'reasoningEffort']) {
    if (typeof source[key] === 'string' && source[key] !== '') result[key] = source[key]
  }
  return result
}

export function createEngine(options) {
  const config = normalizeSettings(options.config)
  const stateFile = options.stateFile
  const settingsFile = options.settingsFile
  const getAgents = typeof options.getAgents === 'function' ? options.getAgents : () => null
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const logger = options.logger || console

  let settings = normalizeSettings({ ...config, ...(readJson(settingsFile) || {}) })
  let waits = loadWaits()
  let timer = null
  let ticking = false
  let stopped = false

  function loadWaits() {
    const parsed = readJson(stateFile)
    const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.waits) ? parsed.waits : []
    return list
      .filter((item) => item && typeof item === 'object' && typeof item.id === 'string')
      .map((item) => ({
        ...item,
        note: typeof item.note === 'string' ? item.note : '',
        status: typeof item.status === 'string' ? item.status : 'active',
        delivery: typeof item.delivery === 'string' ? item.delivery : 'none',
      }))
      .slice(0, 200)
  }

  function persist() {
    atomicWrite(stateFile, JSON.stringify({ version: 1, waits }, null, 2) + '\n')
  }

  function persistSettings() {
    atomicWrite(settingsFile, JSON.stringify(settings, null, 2) + '\n')
  }

  function getSettings() {
    return { ...settings }
  }

  function saveSettings(patch) {
    settings = normalizeSettings({ ...settings, ...(patch && typeof patch === 'object' ? patch : {}) })
    persistSettings()
    return getSettings()
  }

  function activeCount() {
    return waits.filter((wait) => wait.status === 'active').length
  }

  function newId() {
    return 'wait-' + Date.now().toString(36) + '-' + randomBytes(4).toString('hex')
  }

  function sessionContext(exec) {
    const agent = exec && exec.agent ? exec.agent : null
    const header = agent && agent.session && agent.session.header ? agent.session.header : {}
    const sessionId =
      (typeof header.id === 'string' && header.id) ||
      (agent && typeof agent.id === 'string' ? agent.id : '')
    const cwd = typeof header.cwd === 'string' ? header.cwd : ''
    const agentPreset = typeof header.agentPreset === 'string' ? header.agentPreset : ''
    const live = sessionId ? getAgents()?.get?.(sessionId) : null
    const agentOptions = pickAgentOptions(live && live.options ? live.options : agent && agent.options)
    return { sessionId, cwd, agentPreset, agentOptions }
  }

  function create(args, exec) {
    const checked = validateCreate(args, settings)
    if (!checked.ok) return { ok: false, error: checked.error }
    const input = checked.value

    if (activeCount() >= settings.maxWaits) {
      return { ok: false, error: '最多同时保留 ' + settings.maxWaits + ' 条等待，请先取消旧的等待。' }
    }

    const context = sessionContext(exec)
    if (context.sessionId === '') {
      return { ok: false, error: '无法确定当前会话 ID，不能登记等待。' }
    }

    let baseline
    try {
      baseline = readSnapshot({
        kind: input.kind,
        path: input.path,
        pid: input.pid,
      })
    } catch (error) {
      return { ok: false, error: '读取目标状态失败：' + String(error && error.message ? error.message : error) }
    }

    const nowMs = now()
    const wait = {
      id: newId(),
      kind: input.kind,
      path: input.path,
      pid: input.pid,
      note: input.note,
      status: 'active',
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + input.timeoutMinutes * 60000).toISOString(),
      baseline,
      sessionId: context.sessionId,
      cwd: context.cwd,
      agentPreset: context.agentPreset,
      agentOptions: context.agentOptions,
      delivery: 'pending',
      resumeAttempted: false,
      deliveryAttempts: 0,
    }

    const already = conditionMet(wait, baseline)
    if (already) {
      wait.status = 'fired'
      wait.firedAt = wait.createdAt
      wait.delivery = 'none'
      wait.detail = '创建等待时条件已经满足，没有额外叫醒。'
    }

    waits.unshift(wait)
    persist()

    const meta = KIND_META[wait.kind]
    const message = already
      ? '条件已经满足：' + describeWait(wait) + '。没有登记新的唤醒。'
      : '已登记' + (meta ? meta.label : '等待') + '：' + targetLabel(wait) + '。条件成立时会自动叫醒本会话，不需要轮询。'

    return { ok: true, wait: publicWait(wait, nowMs), message }
  }

  function list() {
    const nowMs = now()
    return {
      ok: true,
      waits: waits.map((wait) => publicWait(wait, nowMs)),
      active: activeCount(),
      total: waits.length,
      settings: getSettings(),
      pollSeconds: settings.pollSeconds,
    }
  }

  function cancel(id) {
    const target = typeof id === 'string' ? id.trim() : ''
    const wait = waits.find((item) => item.id === target)
    if (!wait) return { ok: false, error: '找不到等待：' + target }
    if (wait.status !== 'active') {
      return { ok: false, error: '等待当前状态是 ' + wait.status + '，只能取消 active 的等待。' }
    }
    wait.status = 'cancelled'
    wait.cancelledAt = new Date(now()).toISOString()
    wait.delivery = 'none'
    persist()
    return { ok: true, wait: publicWait(wait, now()), message: '已取消等待：' + describeWait(wait) }
  }

  function wakeText(wait) {
    const meta = KIND_META[wait.kind]
    const lines = [
      '【守候】你之前登记的等待已经满足。',
      '',
      '等待 ID：' + wait.id,
      '条件：' + (meta ? meta.label : wait.kind) + ' — ' + targetLabel(wait),
    ]
    if (wait.note) lines.push('备注：' + wait.note)
    lines.push('成立时间：' + (wait.firedAt || ''))
    lines.push('')
    lines.push('请继续原任务。不要重复创建同一个等待；如果还要等下一次，再新建一条。')
    return lines.join('\n')
  }

  function messageFor(wait) {
    return {
      id: 'durable-wait-' + wait.id + '-' + Date.now().toString(36),
      role: 'user',
      content: [{ type: 'text', text: wakeText(wait) }],
      source: { kind: 'user' },
    }
  }

  function markDelivered(wait, note) {
    wait.delivery = 'delivered'
    wait.deliveryAt = new Date(now()).toISOString()
    wait.deliveryNote = note || ''
    wait.deliveryError = ''
    persist()
    return 'delivered'
  }

  function markUndelivered(wait, error) {
    wait.delivery = 'undelivered'
    wait.deliveryAt = new Date(now()).toISOString()
    wait.deliveryError = String(error && error.message ? error.message : error).slice(0, 500)
    persist()
    return 'undelivered'
  }

  async function attemptDelivery(wait) {
    const service = getAgents()
    if (!service || typeof service.get !== 'function') {
      return markUndelivered(wait, 'agents 服务不可用')
    }

    const live = service.get(wait.sessionId)
    if (live) {
      if (live.status && live.status !== 'idle') {
        wait.deliveryNote = '会话正在忙（' + live.status + '），等空闲后再叫醒。'
        return 'pending'
      }
      try {
        wait.deliveryAttempts = (wait.deliveryAttempts || 0) + 1
        await live.followup(messageFor(wait))
        return markDelivered(wait, '已在当前在线会话中叫醒。')
      } catch (error) {
        return markUndelivered(wait, 'followup 失败：' + String(error && error.message ? error.message : error))
      }
    }

    if (wait.resumeAttempted) {
      return markUndelivered(wait, '会话不在线，且恢复已经尝试过一次。')
    }
    if (typeof service.resume !== 'function') {
      return markUndelivered(wait, '会话不在线，agents.resume 不可用。')
    }

    wait.resumeAttempted = true
    try {
      const handle = await service.resume({
        resumeSessionId: wait.sessionId,
        ...(wait.agentOptions || {}),
      })
      const agent = handle && handle.agent ? handle.agent : handle
      if (!agent || typeof agent.followup !== 'function') {
        return markUndelivered(wait, 'resume 返回的对象没有 followup。')
      }
      await agent.followup(messageFor(wait))
      markDelivered(wait, '已恢复会话并叫醒。')
      const dispose = () => {
        try {
          if (handle && typeof handle.dispose === 'function') handle.dispose()
        } catch (error) {
          logger.warn('[durable-wait] dispose failed:', error && error.message)
        }
      }
      if (typeof agent.whenIdle === 'function') {
        Promise.resolve(agent.whenIdle()).then(dispose).catch(dispose)
      }
      return 'delivered'
    } catch (error) {
      return markUndelivered(wait, 'resume 失败：' + String(error && error.message ? error.message : error))
    }
  }

  async function tick() {
    if (ticking || stopped) return
    ticking = true
    let changed = false
    try {
      const nowMs = now()
      for (const wait of waits) {
        if (wait.status === 'active') {
          const expiresAt = Date.parse(wait.expiresAt)
          if (Number.isFinite(expiresAt) && expiresAt <= nowMs) {
            wait.status = 'expired'
            wait.expiredAt = new Date(nowMs).toISOString()
            wait.delivery = 'none'
            changed = true
            continue
          }

          let snapshot
          try {
            snapshot = readSnapshot(wait)
          } catch (error) {
            wait.lastError = String(error && error.message ? error.message : error)
            changed = true
            continue
          }

          if (conditionMet(wait, snapshot)) {
            wait.status = 'fired'
            wait.firedAt = new Date(nowMs).toISOString()
            wait.delivery = settings.autoWake ? 'pending' : 'none'
            wait.deliveryNote = settings.autoWake ? '条件已成立，等待叫醒。' : '自动叫醒已关闭。'
            changed = true
          }
        }

        if (wait.status === 'fired' && wait.delivery === 'pending' && settings.autoWake) {
          const outcome = await attemptDelivery(wait)
          if (outcome !== 'pending') changed = true
        }
      }

      const keepBefore = waits.length
      const cutoff = nowMs - settings.keepDays * 86400000
      waits = waits.filter((wait) => {
        if (wait.status === 'active') return true
        if (wait.status === 'fired' && wait.delivery === 'pending') return true
        const stamp = wait.firedAt || wait.cancelledAt || wait.expiredAt || wait.createdAt
        const time = Date.parse(stamp)
        return !Number.isFinite(time) || time >= cutoff
      })
      if (waits.length !== keepBefore) changed = true
      if (waits.length > 200) {
        waits = waits.slice(0, 200)
        changed = true
      }
    } finally {
      if (changed) persist()
      ticking = false
    }
  }

  function start() {
    if (timer !== null || stopped) return
    timer = setInterval(() => {
      void tick()
    }, settings.pollSeconds * 1000)
    if (typeof timer.unref === 'function') timer.unref()
    setTimeout(() => {
      void tick()
    }, 800).unref?.()
  }

  function stop() {
    stopped = true
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  return {
    create,
    list,
    cancel,
    tick,
    start,
    stop,
    getSettings,
    saveSettings,
    publicWaits: () => waits.map((wait) => publicWait(wait, now())),
  }
}
