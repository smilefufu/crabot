import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { createInstanceRuntime, readOwnStartingRuntime, recordMmProcess, clearInstanceRuntime } from './instance-runtime.mjs'
import { createSupervisorShutdownController } from './supervisor-shutdown.mjs'

// A controller owns one concrete MM child. CLI/GUI adapters decide presentation and when to launch.
export async function runManagedCore({ root, dataDir, mmPort, env, stdio, cleanup, log = () => {}, adoptGeneration }) {
  root = realpathSync(root); dataDir = realpathSync(dataDir)
  const record = adoptGeneration === undefined ? createInstanceRuntime({ root, dataDir, mmPort })
    : readOwnStartingRuntime({ root, dataDir, mmPort, generation: adoptGeneration })
  const childEnv = { ...env, DATA_DIR: dataDir, CRABOT_INSTANCE_GENERATION: record.generation }
  delete childEnv.CRABOT_CLI_LOCK_HELD
  const mm = spawn(process.execPath, [join(root, 'crabot-core', 'dist', 'main.js')], {
    cwd: join(root, 'crabot-core'), stdio: [...stdio, 'ipc'],
    env: childEnv,
  })
  const shutdown = createSupervisorShutdownController({
    mm, log,
    requestShutdown: () => {
      if (mm.connected) mm.send({ type: 'crabot-shutdown', generation: record.generation }, () => {})
    },
    cleanup: code => {
      // A crash retains evidence for precise orphan recovery, including the generation.
      try { if (code === 0) clearInstanceRuntime(dataDir, record.generation) }
      catch (error) { log(`[controller] runtime evidence retained: ${error.message}\n`); code = 1 }
      cleanup(code)
    },
  })
  let finished = false
  const finish = code => { if (!finished) { finished = true; shutdown.handleMmExit(code) } }
  mm.on('exit', (code, signal) => { log(`[controller] MM exited code=${code} signal=${signal}\n`); finish(code ?? 1) })
  mm.on('error', error => { log(`[controller] MM spawn failed: ${error.message}\n`); finish(1) })
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => shutdown.handleSignal(signal))
  try {
    await once(mm, 'spawn')
    recordMmProcess(dataDir, record.generation, mm.pid)
  } catch (error) {
    // Spawn succeeded but ownership could not be recorded: stop only this concrete child handle.
    if (mm.exitCode === null && mm.signalCode === null) mm.kill('SIGKILL')
    finish(1); throw error
  }
  return { mm, record }
}
