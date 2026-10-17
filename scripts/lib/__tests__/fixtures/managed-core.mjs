import { runManagedCore } from '../../managed-core.mjs'
await runManagedCore({
  root: process.env.TEST_CORE_ROOT, dataDir: process.env.TEST_DATA_DIR,
  mmPort: Number(process.env.TEST_PORT), env: process.env,
  stdio: ['ignore', 'inherit', 'inherit'], cleanup: code => process.exit(code),
})
