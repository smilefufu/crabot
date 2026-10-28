import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import identity from '../../scripts/lib/process-identity.cjs'
import { probeKnownProcessExit } from '../../scripts/lib/known-process-exit.cjs'

test('actual native login warning is presented after service recovery and maintenance finalization', { timeout: 30000 }, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-login-recovery-')))
  const env = { ...process.env }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'DATA_DIR', 'CRABOT_HOME', 'CRABOT_DEV']) delete env[key]
  const child = spawn(createRequire(import.meta.url)('electron'), [fileURLToPath(new URL('./login-startup-recovery.cjs', import.meta.url)), root],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', observed, exited = false
  child.stdout.on('data', bytes => { output = (output + bytes).slice(-16384) })
  child.stderr.on('data', () => { /* The fixture exports fixed stdout markers only. */ })
  const end = once(child, 'exit').then(value => { exited = true; return value })
  try {
    const deadline = Date.now() + 10000
    while (!output.includes('BEFORE_WARNING') && !exited && Date.now() < deadline) {
      observed ??= identity.inspectProcess(child.pid)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.ok(output.includes('BEFORE_WARNING'), 'Finite native warning actor did not reach its dialog')
    assert.ok(output.includes('RECOVERY_CAN_CONTINUE'), 'The native notice blocked the actual controller before its service step')
    assert.ok(output.includes('RECOVERY_FINALIZED'), 'The native notice blocked maintenance settlement')
    assert.ok(output.indexOf('RECOVERY_FINALIZED') < output.indexOf('BEFORE_WARNING'))
    console.log('CRABOT_LOGIN_RECOVERY_NOTICE ' + JSON.stringify({ platform: process.platform, actual_electron: true,
      actual_controller: true, finalized_before_native_notice: true, business_service_started: false, os_settings_changed: false }))
  } finally {
    if (!exited && observed && identity.sameProcess(observed, identity.inspectProcess(child.pid))) identity.terminateKnownProcess(observed)
    let timer
    try { await Promise.race([end, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Finite dialog actor exit unknown')), 5000) })]) }
    finally { clearTimeout(timer) }
    const deadline = Date.now() + 5000
    while (observed && probeKnownProcessExit([observed]).state !== 'stopped' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
    if (observed) assert.equal(probeKnownProcessExit([observed]).state, 'stopped')
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
