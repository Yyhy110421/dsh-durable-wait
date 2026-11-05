import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine } from '../lib/engine.js'

const root = mkdtempSync(join(tmpdir(), 'durable-wait-engine-'))
const stateFile = join(root, 'state.json')
const settingsFile = join(root, 'settings.json')

function makeExec(sessionId = 'session-1') {
  return {
    agent: {
      session: { header: { id: sessionId, cwd: root, agentPreset: 'default' } },
      options: { provider: 'test-provider', model: 'test-model', reasoningEffort: 'high' },
    },
  }
}

try {
  const deliveries = []
  const resumes = []
  let live = {
    status: 'running',
    options: { provider: 'test-provider', model: 'test-model', reasoningEffort: 'high' },
    followup: async (message) => deliveries.push(message),
  }
  const service = {
    get: (id) => (id === 'session-1' ? live : undefined),
    resume: async (options) => {
      resumes.push(options)
      return {
        agent: {
          followup: async (message) => deliveries.push(message),
          whenIdle: async () => {},
        },
        dispose: () => {},
      }
    },
  }

  const engine = createEngine({
    config: {
      defaultTimeoutMinutes: 30,
      pollSeconds: 2,
      autoWake: true,
      maxWaits: 50,
      keepDays: 7,
    },
    stateFile,
    settingsFile,
    getAgents: () => service,
  })

  const target = join(root, 'build.done')
  const created = engine.create({ kind: 'file-exists', path: target, note: '等构建' }, makeExec())
  assert.equal(created.ok, true)
  assert.equal(created.wait.status, 'active')
  assert.equal(created.wait.target, target)

  const listed = engine.list()
  assert.equal(listed.active, 1)
  assert.equal(listed.total, 1)
  assert.equal(listed.waits[0].note, '等构建')

  writeFileSync(target, 'ok', 'utf8')
  await engine.tick()
  let current = engine.list().waits[0]
  assert.equal(current.status, 'fired')
  assert.equal(current.delivery, 'pending')
  assert.equal(deliveries.length, 0, '会话忙时不能插队叫醒')

  live.status = 'idle'
  await engine.tick()
  current = engine.list().waits[0]
  assert.equal(current.delivery, 'delivered')
  assert.equal(deliveries.length, 1)
  assert.ok(deliveries[0].content[0].text.includes('【守候】'))
  assert.ok(deliveries[0].content[0].text.includes('等构建'))
  assert.equal(deliveries[0].source.kind, 'user')

  const cancelled = engine.create({ kind: 'file-exists', path: join(root, 'never') }, makeExec())
  assert.equal(cancelled.ok, true)
  const cancelResult = engine.cancel(cancelled.wait.id)
  assert.equal(cancelResult.ok, true)
  assert.equal(cancelResult.wait.status, 'cancelled')
  assert.equal(engine.cancel(cancelled.wait.id).ok, false)

  const dead = engine.create({ kind: 'process-exit', pid: 999999 }, makeExec())
  assert.equal(dead.ok, true)
  assert.equal(dead.wait.status, 'fired')
  assert.equal(dead.wait.delivery, 'none')

  // 会话离线：resume 一次，成功叫醒。
  const offlineTarget = join(root, 'offline.done')
  live = undefined
  const offline = engine.create({ kind: 'file-exists', path: offlineTarget }, makeExec())
  assert.equal(offline.ok, true)
  writeFileSync(offlineTarget, 'ok', 'utf8')
  await engine.tick()
  const offlineState = engine.list().waits.find((item) => item.id === offline.wait.id)
  assert.equal(offlineState.delivery, 'delivered')
  assert.equal(resumes.length, 1)
  assert.equal(resumes[0].resumeSessionId, 'session-1')
  assert.equal(resumes[0].provider, 'test-provider')
  assert.equal(resumes[0].model, 'test-model')

  // 会话离线且 resume 失败：只尝试一次，之后标 undelivered，不循环。
  const failingEngine = createEngine({
    config: { defaultTimeoutMinutes: 30, pollSeconds: 2, autoWake: true, maxWaits: 50, keepDays: 7 },
    stateFile: join(root, 'failing-state.json'),
    settingsFile: join(root, 'failing-settings.json'),
    getAgents: () => ({
      get: () => undefined,
      resume: async () => {
        throw new Error('resume refused')
      },
    }),
  })
  const failTarget = join(root, 'fail.done')
  const failing = failingEngine.create({ kind: 'file-exists', path: failTarget }, makeExec())
  writeFileSync(failTarget, 'ok', 'utf8')
  await failingEngine.tick()
  let failedState = failingEngine.list().waits.find((item) => item.id === failing.wait.id)
  assert.equal(failedState.delivery, 'undelivered')
  assert.ok(failedState.deliveryError.includes('resume refused'))
  await failingEngine.tick()
  failedState = failingEngine.list().waits.find((item) => item.id === failing.wait.id)
  assert.equal(failedState.delivery, 'undelivered')

  const saved = engine.saveSettings({ pollSeconds: 5, autoWake: false })
  assert.equal(saved.pollSeconds, 5)
  assert.equal(saved.autoWake, false)
  assert.equal(engine.getSettings().pollSeconds, 5)

  console.log('plugin: all engine checks passed')
} finally {
  rmSync(root, { recursive: true, force: true })
}
