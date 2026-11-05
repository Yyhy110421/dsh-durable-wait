/**
 * dsh-durable-wait 宿主半身。
 *
 * 工具：wait_create / wait_list / wait_cancel
 * 设置页：/durable-wait/settings
 *
 * 只观察文件与进程，不杀进程、不改目标文件。条件成立后由插件叫醒原会话。
 */
import { join } from 'node:path'
import { createEngine } from './engine.js'
import { KINDS, KIND_META } from './core.js'

export const name = 'durable-wait'
export const inject = ['tools', 'systemPrompt', 'webServer']

function dshHome() {
  return process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || process.cwd(), '.dsh')
}

function dataFile(name) {
  return join(dshHome(), 'data', name)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 1024 * 1024) {
        reject(new Error('请求体过大'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(raw))
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

export function apply(ctx, config) {
  let agentsService = null
  try {
    ctx.inject(['agents'], (agentCtx) => {
      agentsService = agentCtx.agents
    })
  } catch (error) {
    console.warn('[durable-wait] agents service unavailable:', error && error.message)
  }

  const engine = createEngine({
    config,
    stateFile: dataFile('durable-wait.json'),
    settingsFile: dataFile('durable-wait-settings.json'),
    getAgents: () => agentsService,
  })

  const createTool = {
    name: 'wait_create',
    description:
      '持久等待：登记一个条件后立即返回，条件成立时插件会自动叫醒本会话，不需要 sleep 或反复轮询。' +
      '支持文件出现（file-exists）、文件修改（file-changed）、进程退出（process-exit）。' +
      '适合等构建产物、下载完成、日志变化、子进程结束。只读系统，不杀进程、不改目标文件。',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: KINDS,
          description: 'file-exists | file-changed | process-exit',
        },
        path: {
          type: 'string',
          description: '文件/目录的绝对路径；file-exists、file-changed 必填。',
        },
        pid: {
          type: 'integer',
          minimum: 1,
          description: '要等待退出的进程 ID；process-exit 必填。',
        },
        note: {
          type: 'string',
          description: '可选备注，叫醒时会带上；不要写密码、验证码或密钥。',
        },
        timeoutMinutes: {
          type: 'integer',
          minimum: 1,
          maximum: 1440,
          description: '超时分钟数，默认 30，最长 1440。',
        },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          wait: { type: 'object', additionalProperties: true },
          message: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render: (args, value) => {
        const result = value && typeof value === 'object' ? value : {}
        return [{ type: 'text', text: typeof result.message === 'string' ? result.message : (result.error || '等待已登记。') }]
      },
    },
    timeoutMs: 30000,
    async execute(rawArgs, exec) {
      try {
        return engine.create(rawArgs, exec)
      } catch (error) {
        return { ok: false, error: String(error && error.message ? error.message : error) }
      }
    },
  }

  const listTool = {
    name: 'wait_list',
    description:
      '列出当前持久等待：进行中、已触发、已取消、已超时的条目，含剩余时间与叫醒状态。' +
      '用在创建等待后确认，或排查为什么没有叫醒。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          waits: { type: 'array', items: { type: 'object', additionalProperties: true } },
          active: { type: 'number' },
          total: { type: 'number' },
          settings: { type: 'object', additionalProperties: true },
          pollSeconds: { type: 'number' },
          error: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render: (args, value) => {
        const result = value && typeof value === 'object' ? value : {}
        const waits = Array.isArray(result.waits) ? result.waits : []
        if (waits.length === 0) return [{ type: 'text', text: '当前没有持久等待。' }]
        const lines = waits.map((wait) => {
          const status = wait.status || 'unknown'
          const tail = status === 'active' ? '剩余 ' + Math.ceil((wait.remainingMs || 0) / 60000) + ' 分钟' : wait.delivery || status
          return '- [' + status + '] ' + wait.kindLabel + ' ' + wait.target + '（' + tail + '）'
        })
        return [{ type: 'text', text: '持久等待：\n' + lines.join('\n') }]
      },
    },
    timeoutMs: 30000,
    async execute() {
      try {
        return engine.list()
      } catch (error) {
        return { ok: false, error: String(error && error.message ? error.message : error) }
      }
    },
  }

  const cancelTool = {
    name: 'wait_cancel',
    description: '取消一条还在进行中的持久等待。已触发、已超时或已取消的条目不能取消。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'wait_create 返回的等待 ID。' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          wait: { type: 'object', additionalProperties: true },
          message: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render: (args, value) => {
        const result = value && typeof value === 'object' ? value : {}
        return [{ type: 'text', text: typeof result.message === 'string' ? result.message : (result.error || '等待已取消。') }]
      },
    },
    timeoutMs: 30000,
    async execute(rawArgs) {
      try {
        const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
        return engine.cancel(args.id)
      } catch (error) {
        return { ok: false, error: String(error && error.message ? error.message : error) }
      }
    },
  }

  ctx.tools.register(createTool)
  ctx.tools.register(listTool)
  ctx.tools.register(cancelTool)

  try {
    ctx.systemPrompt.section({
      name: 'tool:durable-wait',
      order: 152,
      text:
        '要等外部事件时，不要用 sleep 或反复轮询：先调用 wait_create 登记（文件出现、文件修改、进程退出），然后结束当前轮次。' +
        '条件成立后插件会自动叫醒会话；被【守候】消息叫醒时，先 wait_list 确认状态，再继续原任务。' +
        '不要重复创建同一个等待；只读系统，不杀进程。',
    })
  } catch (error) {
    console.warn('[durable-wait] system prompt section unavailable:', error && error.message)
  }

  try {
    ctx.inject(['webServer'], (sctx) => {
      const webServer = sctx.webServer
      if (webServer === undefined || typeof webServer.register !== 'function') return

      webServer.register({
        kind: 'exact',
        path: '/durable-wait/settings',
        handler: async (req, res) => {
          if (req.method === 'GET') {
            const state = engine.list()
            sendJson(res, 200, {
              ok: true,
              settings: state.settings,
              waits: state.waits,
              active: state.active,
              total: state.total,
              pollSeconds: state.pollSeconds,
              kinds: KINDS.map((id) => ({
                id,
                label: KIND_META[id].label,
                description: KIND_META[id].description,
              })),
            })
            return
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          try {
            const raw = await readBody(req)
            const patch = JSON.parse(raw || '{}')
            const settings = engine.saveSettings(patch)
            sendJson(res, 200, { ok: true, settings })
          } catch (error) {
            sendJson(res, 400, { ok: false, error: String(error && error.message ? error.message : error) })
          }
        },
      })

      webServer.register({
        kind: 'exact',
        path: '/durable-wait/cancel',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          try {
            const raw = await readBody(req)
            const body = JSON.parse(raw || '{}')
            const result = engine.cancel(body.id)
            sendJson(res, result.ok ? 200 : 400, result)
          } catch (error) {
            sendJson(res, 400, { ok: false, error: String(error && error.message ? error.message : error) })
          }
        },
      })
    })
  } catch (error) {
    console.warn('[durable-wait] web settings unavailable:', error && error.message)
  }

  try {
    ctx.on('dispose', () => engine.stop())
  } catch {
    // 旧版 Cordis 没有 dispose 事件时忽略；进程退出会清掉定时器。
  }

  engine.start()
}
