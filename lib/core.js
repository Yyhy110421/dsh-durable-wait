/**
 * dsh-durable-wait 的纯逻辑层：参数校验、快照、条件判断、公开视图。
 *
 * 这里不碰 DSH 服务，也不写文件，方便单测。
 */
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export const KINDS = ['file-exists', 'file-changed', 'process-exit']

export const KIND_META = {
  'file-exists': {
    label: '文件出现',
    verb: '出现',
    description: '等待某个文件或目录被创建。',
  },
  'file-changed': {
    label: '文件修改',
    verb: '被修改',
    description: '等待某个文件内容或修改时间发生变化；创建时不存在也算。',
  },
  'process-exit': {
    label: '进程退出',
    verb: '退出',
    description: '等待某个进程结束。只观察，不杀进程。',
  },
}

export const DEFAULT_SETTINGS = {
  defaultTimeoutMinutes: 30,
  pollSeconds: 2,
  autoWake: true,
  maxWaits: 50,
  keepDays: 7,
}

function clampInt(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

export function normalizeSettings(input) {
  const value = input && typeof input === 'object' ? input : {}
  return {
    defaultTimeoutMinutes: clampInt(
      value.defaultTimeoutMinutes,
      DEFAULT_SETTINGS.defaultTimeoutMinutes,
      1,
      1440,
    ),
    pollSeconds: clampInt(value.pollSeconds, DEFAULT_SETTINGS.pollSeconds, 2, 60),
    autoWake: value.autoWake !== false,
    maxWaits: clampInt(value.maxWaits, DEFAULT_SETTINGS.maxWaits, 1, 200),
    keepDays: clampInt(value.keepDays, DEFAULT_SETTINGS.keepDays, 1, 90),
  }
}

export function normalizeNote(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, 500)
}

export function validateCreate(args, settings) {
  const value = args && typeof args === 'object' ? args : {}
  const kind = typeof value.kind === 'string' ? value.kind.trim() : ''
  if (!KINDS.includes(kind)) {
    return { ok: false, error: 'kind 必须是 file-exists、file-changed 或 process-exit。' }
  }

  const timeoutMinutes =
    value.timeoutMinutes === undefined
      ? settings.defaultTimeoutMinutes
      : clampInt(value.timeoutMinutes, settings.defaultTimeoutMinutes, 1, 1440)

  if (kind === 'process-exit') {
    const pid = Number(value.pid)
    if (!Number.isInteger(pid) || pid <= 0) {
      return { ok: false, error: 'process-exit 需要正整数 pid。' }
    }
    return {
      ok: true,
      value: {
        kind,
        pid,
        path: '',
        note: normalizeNote(value.note),
        timeoutMinutes,
      },
    }
  }

  const rawPath = typeof value.path === 'string' ? value.path.trim() : ''
  if (rawPath === '') {
    return { ok: false, error: kind + ' 需要 path。' }
  }
  if (!isAbsolute(rawPath)) {
    return { ok: false, error: 'path 必须是绝对路径，例如 C:\\Users\\me\\out.log。' }
  }
  return {
    ok: true,
    value: {
      kind,
      pid: 0,
      path: rawPath,
      note: normalizeNote(value.note),
      timeoutMinutes,
    },
  }
}

export function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error && error.code === 'EPERM') return true
    return false
  }
}

/**
 * 读取一次目标快照。
 * 文件类只关心存在性、mtime 和大小；进程类只关心是否还活着。
 */
export function readSnapshot(wait) {
  if (wait.kind === 'process-exit') {
    return { alive: isPidAlive(wait.pid) }
  }
  try {
    const stat = statSync(wait.path)
    return { exists: true, mtimeMs: stat.mtimeMs, size: stat.size }
  } catch (error) {
    if (error && error.code === 'ENOENT') return { exists: false }
    throw error
  }
}

/**
 * 条件是否已经成立。
 * file-changed：基线不存在时，文件出现即成立；基线存在时，mtime 或大小变化才成立。
 */
export function conditionMet(wait, snapshot) {
  if (wait.kind === 'file-exists') return snapshot.exists === true
  if (wait.kind === 'file-changed') {
    if (snapshot.exists !== true) return false
    const baseline = wait.baseline && typeof wait.baseline === 'object' ? wait.baseline : {}
    if (baseline.exists !== true) return true
    return snapshot.mtimeMs !== baseline.mtimeMs || snapshot.size !== baseline.size
  }
  if (wait.kind === 'process-exit') return snapshot.alive !== true
  return false
}

export function targetLabel(wait) {
  if (wait.kind === 'process-exit') return 'PID ' + wait.pid
  return wait.path
}

export function publicWait(wait, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now()
  const remainingMs =
    wait.status === 'active' && typeof wait.expiresAt === 'string'
      ? Math.max(0, Date.parse(wait.expiresAt) - now)
      : 0
  return {
    id: wait.id,
    kind: wait.kind,
    kindLabel: KIND_META[wait.kind] ? KIND_META[wait.kind].label : wait.kind,
    target: targetLabel(wait),
    note: wait.note || '',
    status: wait.status,
    createdAt: wait.createdAt,
    expiresAt: wait.expiresAt,
    firedAt: wait.firedAt || '',
    cancelledAt: wait.cancelledAt || '',
    expiredAt: wait.expiredAt || '',
    delivery: wait.delivery || '',
    deliveryNote: wait.deliveryNote || '',
    deliveryError: wait.deliveryError || '',
    remainingMs,
    detail: wait.detail || '',
  }
}

export function describeWait(wait) {
  const meta = KIND_META[wait.kind]
  if (!meta) return wait.id
  return meta.label + '：' + targetLabel(wait)
}
