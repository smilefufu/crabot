import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, openSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import product from './product-runtime.cjs'
import { inspectInstance, identity } from './instance-runtime.mjs'
import { probeMmHealthy } from './mm-probe.mjs'

// Caller owns the lifecycle lock and has completed initialization/migrations.
// The detached controller outlives this caller, including an Electron crash.
export async function launchBackgroundCore({ root, dataDir, env, mmPort, webPort, log = () => {} }) {
  const current = inspectInstance(dataDir)
  if (current.state !== 'stopped') throw new Error('Crabot is already running; attach or stop it first')
  const runtime = product.loadProductRuntime(root, { required: env.CRABOT_PRODUCT_REQUIRED === '1' })
  if (process.versions.electron && !runtime) throw new Error('Desktop requires the standalone product Node runtime')
  const node = runtime?.executables.node ?? process.execPath
  const logs = join(dataDir, 'logs'); mkdirSync(logs, { recursive: true })
  const bootLog = join(logs, 'supervisor.boot.log')
  const fd = openSync(bootLog, 'a')
  let child
  try {
    child = spawn(node, [join(root, 'scripts', 'supervisor.mjs')], {
      detached: true, stdio: ['ignore', fd, fd], env: {
        ...env, CRABOT_SUPERVISOR_DATA_DIR: dataDir,
        CRABOT_SUPERVISOR_MM_ENTRY: join(root, 'crabot-core', 'dist', 'main.js'),
      },
    })
    await once(child, 'spawn')
  } finally { closeSync(fd) }
  const controller = identity.inspectProcess(child.pid)
  child.unref()
  log('Starting in background; waiting for MM and Admin (up to 30s)...')
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (!identity.sameProcess(controller, identity.inspectProcess(child.pid))) {
      throw Object.assign(new Error(`Background controller exited; diagnostics: ${bootLog}`), { code: 'CRABOT_START_FAILED' })
    }
    const state = inspectInstance(dataDir)
    if (state.record?.controller.pid === child.pid && state.record.mm && await probeMmHealthy(mmPort)) {
      try {
        const response = await fetch(`http://127.0.0.1:${webPort}/health`, { signal: AbortSignal.timeout(1500) })
        if (response.ok) return { record: state.record, ready: true }
      } catch { /* health is a separate observation, never process-ownership proof */ }
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw Object.assign(new Error(`Startup health is not ready after 30s; controller ${child.pid} remains discoverable. Diagnostics: ${bootLog}`), { code: 'CRABOT_START_TIMEOUT' })
}
