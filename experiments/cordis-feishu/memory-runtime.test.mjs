import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const require = createRequire(import.meta.url)
const { default: ModuleManager } = require('../../crabot-core/dist/index.js')
const { RuntimeRpcError } = require('../../crabot-core/node_modules/crabot-shared')
const identity = require('../../scripts/lib/process-identity.cjs')
const repo = fileURLToPath(new URL('../..', import.meta.url))
const python = process.env.CORDIS_MEMORY_PYTHON || path.join(repo, 'crabot-memory/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
async function waitFor(read) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  throw new Error('Memory pipe startup timed out')
}

test('real Python Memory uses only a managed binary pipe, keeps authorization and persists data across restart', { timeout: 30_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-memory-pipe-'))
  const bootstrap = path.join(directory, 'bootstrap.py')
  await fs.writeFile(bootstrap, `
import runpy, socket, sys
sys.path.insert(0, ${JSON.stringify(path.join(repo, 'crabot-memory'))})
def forbidden(*args, **kwargs):
    raise AssertionError('Memory fixture must not use TCP or external models')
socket.socket.bind = forbidden
socket.socket.connect = forbidden
runpy.run_module('src.main', run_name='__main__')
`)
  const mm = new ModuleManager({ port: 19339, port_range: { range_start: 24201, range_end: 24210 },
    shutdown_timeout: 3, health_check_interval: 3600, modules: [{ module_id: 'memory-default', module_type: 'memory',
      entry: `"${python}" "${bootstrap}"`, cwd: path.join(repo, 'crabot-memory'), auto_start: false, start_priority: 15,
      env: { DATA_DIR: directory, CRABOT_MEMORY_DATA_DIR: path.join(directory, 'memory'),
        CRABOT_MODULE_MANAGER_URL: 'http://localhost:19339', CRABOT_ADMIN_ENDPOINT: 'http://localhost:19339' },
    }],
  }, directory, { transport: 'ipc' })
  const validations = []
  mm.methodHandlers.set('verify_memory_access', (params, context) => {
    validations.push({ params, metadata: context })
    if (context.authorizationBearer !== 'synthetic-runtime') throw new RuntimeRpcError('FORBIDDEN', 'remote-secret-must-not-leak')
    return { verified: true }
  })
  mm.methodHandlers.set('get_memory_config', () => ({ config: { llm: { api_key: 'synthetic-key', base_url: 'https://invalid.example/v1', model: 'synthetic-model' } } }))
  const context = { actor_kind: 'master_private', memory_enabled: true }
  let savedId
  const content = 'binary-记忆\n'.repeat(20000)
  try {
    await mm.start()
    for (let generation = 0; generation < 2; generation++) {
      await mm.handleStartModule({ module_id: 'memory-default' })
      const runtime = await waitFor(() => mm.modules.get('memory-default').status === 'running' ? mm.modules.get('memory-default') : undefined)
      await waitFor(async () => (await mm.sendToModule(runtime.port, 'get_status', {})).configured ? true : undefined)
      assert.deepEqual(identity.listListeningTcpPorts(runtime.pid), [])
      const child = mm.processes.get('memory-default')
      const peer = mm.runtimePeers.get(child)
      const call = (method, params, bearer = 'synthetic-runtime') => peer.call({ target: runtime.port, source: 'forged-source-is-not-identity', method, params,
        ...(bearer ? { metadata: { authorizationBearer: bearer } } : {}) }, 5000)
      await assert.rejects(call('list_entries', { access_context: context }, null), { code: 'UNAUTHORIZED' })
      await assert.rejects(call('list_entries', { access_context: context }, 'wrong-bearer'), error => error.code === 'FORBIDDEN' && !error.message.includes('remote-secret'))
      if (generation === 0) {
        const result = await call('write_short_term', { access_context: context, content, keywords: ['binary'],
          source: { type: 'manual' }, visibility: 'private', scopes: [] })
        savedId = result.memory.id
      }
      const found = await call('search_short_term', { access_context: context, limit: 5 })
      assert.equal(found.results[0].id, savedId)
      assert.equal(found.results[0].content, content)
      const ordinary = await call('search_short_term', { access_context: { actor_kind: 'conversation', memory_enabled: true }, limit: 5 })
      assert.deepEqual(ordinary.results, [])
      await mm.stopModuleProcess('memory-default', 'shutdown')
      assert.equal(child.exitCode, 0)
      assert.equal(runtime.status, 'stopped')
    }
    assert.ok(validations.length >= 6)
    assert.ok(validations.every(call => !JSON.stringify(call.params).includes('synthetic-runtime')))
  } finally {
    await mm.stop()
    await fs.rm(directory, { recursive: true, force: true })
  }
})
