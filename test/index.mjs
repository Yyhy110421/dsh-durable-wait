import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

const root = mkdtempSync(join(tmpdir(), 'durable-wait-index-'))
try {
  const tools = new Map()
  const routes = new Map()
  const sections = []
  let dispose = null
  let agentService = null

  const ctx = {
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
      },
    },
    inject(services, callback) {
      if (services.includes('agents')) {
        agentService = {
          get: () => ({
            status: 'idle',
            followup: async () => {},
            options: { provider: 'p', model: 'm' },
          }),
        }
        callback({ agents: agentService })
        return
      }
      if (services.includes('webServer')) {
        callback({
          webServer: {
            register(route) {
              routes.set(route.path, route)
            },
          },
        })
      }
    },
    on(event, callback) {
      if (event === 'dispose') dispose = callback
    },
  }

  apply(ctx, {})
  assert.ok(tools.has('wait_create'))
  assert.ok(tools.has('wait_list'))
  assert.ok(tools.has('wait_cancel'))
  assert.equal(routes.has('/durable-wait/settings'), true)
  assert.equal(routes.has('/durable-wait/cancel'), true)
  assert.equal(sections.length, 1)

  const exec = { agent: { session: { header: { id: 'session-index', cwd: root } } } }
  const created = await tools.get('wait_create').execute({ kind: 'file-exists', path: join(root, 'never') }, exec)
  assert.equal(created.ok, true)
  assert.equal(created.wait.status, 'active')

  const listed = await tools.get('wait_list').execute({}, exec)
  assert.equal(listed.ok, true)
  assert.equal(listed.active, 1)

  const cancelled = await tools.get('wait_cancel').execute({ id: created.wait.id }, exec)
  assert.equal(cancelled.ok, true)
  assert.equal(cancelled.wait.status, 'cancelled')

  if (dispose) dispose()
  console.log('index: all registration checks passed')
} finally {
  rmSync(root, { recursive: true, force: true })
}
