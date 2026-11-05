import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import {
  conditionMet,
  isPidAlive,
  normalizeSettings,
  readSnapshot,
  validateCreate,
} from '../lib/core.js'

const root = mkdtempSync(join(tmpdir(), 'durable-wait-test-'))
try {
  const settings = normalizeSettings({})
  assert.equal(settings.defaultTimeoutMinutes, 30)
  assert.equal(settings.pollSeconds, 2)
  assert.equal(settings.autoWake, true)
  assert.equal(settings.maxWaits, 50)
  assert.equal(normalizeSettings({ pollSeconds: 1 }).pollSeconds, 2)
  assert.equal(normalizeSettings({ pollSeconds: 99 }).pollSeconds, 60)

  const relative = validateCreate({ kind: 'file-exists', path: 'out.log' }, settings)
  assert.equal(relative.ok, false)
  assert.ok(relative.error.includes('绝对路径'))

  const missing = join(root, 'out.log')
  const fileWait = { kind: 'file-exists', path: missing }
  assert.equal(readSnapshot(fileWait).exists, false)
  assert.equal(conditionMet(fileWait, readSnapshot(fileWait)), false)
  writeFileSync(missing, 'hello', 'utf8')
  assert.equal(conditionMet(fileWait, readSnapshot(fileWait)), true)

  const changed = { kind: 'file-changed', path: missing, baseline: readSnapshot(fileWait) }
  assert.equal(conditionMet(changed, readSnapshot(changed)), false)
  writeFileSync(missing, 'hello world', 'utf8')
  assert.equal(conditionMet(changed, readSnapshot(changed)), true)

  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' })
  assert.ok(child.pid > 0)
  assert.equal(isPidAlive(child.pid), true)
  const processWait = { kind: 'process-exit', pid: child.pid }
  assert.equal(conditionMet(processWait, readSnapshot(processWait)), false)
  child.kill()
  await new Promise((resolve) => child.once('exit', resolve))
  assert.equal(isPidAlive(child.pid), false)
  assert.equal(conditionMet(processWait, readSnapshot(processWait)), true)

  console.log('manual: all core checks passed')
} finally {
  rmSync(root, { recursive: true, force: true })
}
