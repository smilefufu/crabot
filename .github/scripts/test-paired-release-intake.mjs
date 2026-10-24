// The test uses the verified candidate's Python; no host/PATH fallback.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runBounded } from '../../scripts/lib/run-bounded.mjs'
import product from '../../scripts/lib/product-runtime.cjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const runtime = product.loadProductRuntime(path.resolve(process.argv[2]), { required: true, full: true })
await runBounded(runtime.executables.python, ['-I', '-B', path.join(root, 'scripts/desktop/__tests__/extract-paired-release.test.py')], { timeout: 60000 })
await runBounded(process.execPath, ['--test', 'crabot-desktop/tests/release-intake.test.mjs'], {
  cwd: root, env: { ...process.env, CRABOT_TEST_PYTHON: runtime.executables.python, CRABOT_TEST_RUNTIME_CORE: runtime.root }, timeout: 240000,
})
await runBounded(process.execPath, ['--test', '--test-name-pattern=^signed complete release intake reaches actual online preparation', 'scripts/lib/__tests__/desktop-payload.test.mjs'], {
  cwd: root, env: { ...process.env, CRABOT_TEST_PYTHON: runtime.executables.python, CRABOT_TEST_RUNTIME_CORE: runtime.root }, timeout: 60000,
})
