import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { prepareCoreEnvironment, applyStartupMigrations } from '../../scripts/lib/core-preparation.mjs'
import { acquireStartupLock, releaseCliLock } from '../../scripts/lib/cli-lock.mjs'

const require = createRequire(import.meta.url)
const { default: ModuleManager } = require('../../crabot-core/dist/index.js')
const { buildCoreModules } = require('../../crabot-core/dist/core-modules.js')
const identity = require('../../scripts/lib/process-identity.cjs')
const repo = fileURLToPath(new URL('../..', import.meta.url))
async function freePort() {
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
async function waitFor(read) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const result = await read()
    if (result !== undefined) return result
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw new Error('Real core assembly startup timed out')
}

test('real Core/Admin/Agent/Memory assembly runs with only Admin Web listening', { timeout: 60_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-full-ipc-'))
  const workspace = path.join(directory, 'workspace')
  await fs.mkdir(workspace)
  const web = await freePort()
  const lock = await acquireStartupLock(directory, 'cordis-full-instance-test')
  const prepared = prepareCoreEnvironment({ root: repo, dataDir: directory, loadInstallationEnv: false,
    source: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`,
      CRABOT_ADMIN_PASSWORD: 'synthetic-test-only', CRABOT_DEV: 'true', CRABOT_PRODUCT_REQUIRED: '0' } })
  try { await applyStartupMigrations(repo, directory, prepared.env) }
  catch (error) { releaseCliLock(lock); throw error }
  const modules = buildCoreModules({ crabotRoot: repo, adminDir: path.join(repo, 'crabot-admin'), agentDir: path.join(repo, 'crabot-agent'),
    memoryDir: path.join(repo, 'crabot-memory'), dataDir: directory, workspaceDir: workspace, isDev: false, port: 19339,
    adminRpcPort: '19340', adminWebPort: String(web), mmEndpoint: 'http://localhost:19339', adminEndpoint: 'http://localhost:19340',
    memoryPython: process.env.CORDIS_MEMORY_PYTHON || path.join(repo, 'crabot-memory/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    productRuntime: false, newApiToken: '',
  })
  for (const definition of modules) {
    definition.env = { ...definition.env, CRABOT_ADMIN_WEB_HOST: '127.0.0.1', CRABOT_HOME: repo,
      PATH: prepared.env.PATH, CRABOT_JWT_SECRET: prepared.env.CRABOT_JWT_SECRET,
      ...(definition.module_id === 'admin-web' ? { CRABOT_ADMIN_PASSWORD: 'synthetic-test-only' } : {}) }
  }
  const mm = new ModuleManager({ port: 19339, port_range: { range_start: 24301, range_end: 24310 }, modules,
    health_check_interval: 3600, shutdown_timeout: 30,
  }, directory, { transport: 'ipc' })
  let passed = false
  try {
    await mm.start()
    releaseCliLock(lock)
    await waitFor(() => {
      for (const runtime of mm.modules.values()) if (runtime.status === 'error' || runtime.status === 'schema_mismatch') throw new Error(`${runtime.module_id} startup ${runtime.status}; logs: ${directory}`)
      return [...mm.modules.values()].every(runtime => runtime.status === 'running') ? true : undefined
    })
    const response = await fetch(`http://127.0.0.1:${web}/api/auth/me`)
    assert.equal(response.status, 401)
    assert.equal((await response.json()).error, 'Unauthorized')
    const listeners = []
    assert.deepEqual(identity.listListeningTcpPorts(process.pid), [])
    for (const runtime of mm.modules.values()) {
      if (runtime.module_id !== 'memory-default') assert.equal(identity.inspectProcess(runtime.pid).executable, process.execPath)
      const ports = identity.listListeningTcpPorts(runtime.pid)
      if (runtime.module_id === 'admin-web') assert.deepEqual(ports, [web])
      else assert.deepEqual(ports, [])
      listeners.push(...ports)
      assert.ok(['healthy', 'degraded'].includes((await mm.sendToModule(runtime.port, 'health', {})).status))
    }
    assert.deepEqual(listeners, [web])
    passed = true
  } finally {
    releaseCliLock(lock)
    const children = [...mm.processes.values()]
    await mm.stop()
    if (passed) for (const child of children) {
      assert.equal(child.exitCode, 0, `Core child did not exit normally; logs: ${directory}`)
      assert.equal(child.signalCode, null)
    }
    if (passed) await fs.rm(directory, { recursive: true, force: true })
    else console.log('Retained failed fixture diagnostics:', directory)
  }
})
