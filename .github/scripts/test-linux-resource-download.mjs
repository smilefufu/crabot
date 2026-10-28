// Build-time regression only; the packaged interpreter runs stdlib tests.
import path from 'node:path'
import { access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import product from '../../scripts/lib/product-runtime.cjs'
import { runBounded } from '../../scripts/lib/run-bounded.mjs'
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const runtime = product.loadProductRuntime(repository, { required: true })
const tests = path.join(repository, 'scripts/scrapling/__tests__')
await access(path.join(tests, 'test_build.py'))
await runBounded(runtime.executables.python, ['-I', '-B', '-m', 'unittest', 'discover', '-s', tests, '-p', 'test_build.py'],
  { cwd: repository, timeout: 60_000 })
