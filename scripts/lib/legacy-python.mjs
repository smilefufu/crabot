// Read-only takeover planning. Runs only our sealed/bundled Python with site
// loading and bytecode writes disabled, never the old interpreter or pip.
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import identity from './process-identity.cjs'
import product from './product-runtime.cjs'

export async function inspectLegacyPythonEnvironment({ root, dataDir }) {
  const unavailable = () => Object.assign(new Error('无法安全检查旧 Python 依赖，未执行旧环境或改动数据；请保留现有部署。'), { code: 'CRABOT_LEGACY_PYTHON_INSPECTION' })
  if (!identity.isOwnedDirectory(dataDir)) throw unavailable()
  root = realpathSync(root); dataDir = realpathSync(dataDir)
  const runtime = product.loadProductRuntime(root, { required: true, full: true })
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|LANG|LC_.*)$/i.test(key)))
  let result
  try {
    const { stdout } = await promisify(execFile)(runtime.executables.python, ['-I', '-S', '-B', '-X', 'utf8',
      path.join(root, 'scripts/desktop/inspect-legacy-python.py'), dataDir, runtime.manifest.versions.python],
    { env, timeout: 120_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true })
    result = JSON.parse(stdout)
  } catch { throw unavailable() }
  if (result?.schema_version !== 1 || result.observation_only !== true || !['absent', 'observed'].includes(result.status)
    || !Array.isArray(result.packages) || result.packages.length > 4096
    || result.status === 'observed' && (!/^[a-f0-9]{64}$/.test(result.fingerprint) || typeof result.same_python_minor !== 'boolean')) throw unavailable()
  return result
}
