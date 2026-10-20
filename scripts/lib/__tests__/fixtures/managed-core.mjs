import { writeFileSync, appendFileSync } from 'node:fs'
import { runManagedCore } from '../../managed-core.mjs'
import identity from '../../process-identity.cjs'

// Trace only the fixture-owned child identity. Registration can fail before the
// production controller has a chance to flush a diagnostic to its test pipes.
const inspect = identity.inspectProcess
let delayed = false
identity.inspectProcess = pid => {
  if (pid === process.pid) return inspect(pid)
  if (!delayed && Number(process.env.TEST_REGISTER_DELAY) > 0) {
    delayed = true
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.TEST_REGISTER_DELAY))
  }
  const forced = process.env.TEST_FORCE_REGISTRATION_FAILURE === '1'
  const report = value => {
    if (process.env.TEST_IDENTITY_REPORT) writeFileSync(process.env.TEST_IDENTITY_REPORT, JSON.stringify({ pid, forced, ...value }))
  }
  try {
    const observed = inspect(pid), returned = forced && observed ? { ...observed, parent: -1 } : observed
    report({ observed, returned }); return returned
  } catch (error) { report({ error: { code: error.code, message: error.message } }); throw error }
}
await runManagedCore({
  root: process.env.TEST_CORE_ROOT, dataDir: process.env.TEST_DATA_DIR,
  mmPort: Number(process.env.TEST_PORT), env: process.env,
  stdio: ['ignore', 'inherit', 'inherit'], cleanup: code => process.exit(code), log: message => {
    if (process.env.TEST_CONTROLLER_LOG) appendFileSync(process.env.TEST_CONTROLLER_LOG, message)
    process.stdout.write(message)
  },
})
