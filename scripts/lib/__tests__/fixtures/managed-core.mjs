import { runManagedCore } from '../../managed-core.mjs'
import identity from '../../process-identity.cjs'

// Force the interval where the fake server is listening but its controller has
// not finished persisting the MM identity, independent of CPU/runner scheduling.
if (Number(process.env.TEST_REGISTER_DELAY) > 0) {
  const inspect = identity.inspectProcess
  let delayed = false
  identity.inspectProcess = pid => {
    if (pid !== process.pid && !delayed) {
      delayed = true
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.TEST_REGISTER_DELAY))
    }
    return inspect(pid)
  }
}
await runManagedCore({
  root: process.env.TEST_CORE_ROOT, dataDir: process.env.TEST_DATA_DIR,
  mmPort: Number(process.env.TEST_PORT), env: process.env,
  stdio: ['ignore', 'inherit', 'inherit'], cleanup: code => process.exit(code), log: message => process.stdout.write(message),
})
