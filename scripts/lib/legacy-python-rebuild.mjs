// Explicit takeover preparation only. The original environment and default
// selection stay untouched; the surrounding transaction owns the final switch.
import { promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { runBounded } from './run-bounded.mjs'
import { inspectLegacyPythonEnvironment, inspectPythonEnvironment } from './legacy-python.mjs'
import { cliLockToken } from './cli-lock.mjs'
import { inspectInstance } from './instance-runtime.mjs'
import management from './desktop-management.cjs'
import identity from './process-identity.cjs'
import product from './product-runtime.cjs'
import python from './product-python-env.cjs'

const normalize = name => name.toLowerCase().replace(/[-_.]+/g, '-')
const fail = (code = 'CRABOT_LEGACY_PYTHON_REBUILD_UNVERIFIED') => Object.assign(new Error(
  '旧 Python 依赖尚不能确认已恢复；原环境和准备目录保留，未切换默认环境。'), { code })
const cancelled = signal => { if (signal?.aborted) throw fail('CRABOT_PREPARATION_CANCELLED') }
const bootstrap = JSON.parse(readFileSync(new URL('../desktop/legacy-python-bootstrap.json', import.meta.url), 'utf8'))

export function planLegacyPythonRebuild(observation) {
  if (observation?.status !== 'observed' || !/^[a-f0-9]{64}$/.test(observation.fingerprint)
    || !Array.isArray(observation.packages) || !Array.isArray(observation.unrecorded_files)
    || observation.unrecorded_files.length !== observation.unrecorded_site_files
    || observation.site_references !== 0 || observation.special_site_files !== 0) throw fail()
  const names = new Set(), pins = []
  for (const pkg of observation.packages) {
    if (typeof pkg.name !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(pkg.name)
      || typeof pkg.version !== 'string' || !/^[0-9][A-Za-z0-9.!+_-]*$/.test(pkg.version)
      || !pkg.has_file_record || pkg.has_source_record
      || ['modified_files', 'missing_files', 'unverified_files', 'references'].some(key => pkg[key] !== 0)) throw fail()
    const name = normalize(pkg.name)
    if (names.has(name)) throw fail()
    names.add(name); pins.push({ name, version: pkg.version })
  }
  for (const file of observation.unrecorded_files) {
    const known = Object.hasOwn(bootstrap.files, file.path) && bootstrap.files[file.path]
    if (!known || file.size !== known.size || file.sha256 !== known.sha256) throw fail()
  }
  return { source_fingerprint: observation.fingerprint, pins: pins.sort((a, b) => a.name.localeCompare(b.name)), bootstrap_files: observation.unrecorded_files }
}

// execute is a test seam for an offline wheel source, never a user command.
export async function prepareLegacyPythonRebuild({ root, dataDir, expectedFingerprint, signal, progress = () => {}, execute = runBounded }) {
  dataDir = management.requireExistingDataRoot(dataDir)
  if (!cliLockToken(path.join(dataDir, 'cli.lock')) || inspectInstance(dataDir).state !== 'stopped') throw fail('CRABOT_BACKUP_REQUIRES_STOP')
  cancelled(signal)
  const original = await inspectLegacyPythonEnvironment({ root, dataDir })
  cancelled(signal)
  const plan = planLegacyPythonRebuild(original)
  if (plan.source_fingerprint !== expectedFingerprint) throw fail('CRABOT_LEGACY_PYTHON_CHANGED')
  const runtime = product.loadProductRuntime(root, { required: true, full: true })
  cancelled(signal)
  const [major, minor] = runtime.manifest.versions.python.split('.').map(Number)
  if (plan.bootstrap_files.length && (major < 3 || major === 3 && minor < 10)) throw fail()
  const id = randomUUID(), relative = 'agent-environments/' + id
  management.ensurePrivateDataRoot(path.join(dataDir, 'agent-environments'))
  const directory = path.join(dataDir, relative)
  progress('creating_environment')
  python.ensureProductPythonEnvironment(runtime, dataDir, directory, spawnSync)
  cancelled(signal)
  const binary = path.join(directory, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|HOME|USER|LOGNAME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR|LANG|LC_.*)$/i.test(key)))
  const env = product.productEnvironment(runtime, dataDir, inherited)
  env.UV_PYTHON_DOWNLOADS = 'never'; env.UV_NO_CONFIG = '1'
  delete env.PYTHONHOME; delete env.PYTHONPATH
  const run = async (command, args) => {
    cancelled(signal)
    try {
      await execute(command, args, { cwd: directory, env, signal, timeout: 300_000, windowsHide: true })
    } catch (error) {
      cancelled(signal)
      throw fail(error.code === 'CRABOT_PREPARATION_CANCELLED' ? error.code : 'CRABOT_LEGACY_PYTHON_INSTALL_FAILED')
    }
    cancelled(signal)
  }
  const requirements = path.join(directory, 'legacy-requirements.txt')
  const text = plan.pins.map(pkg => pkg.name + '==' + pkg.version).join('\n') + '\n'
  if (process.platform === 'win32') { identity.writePrivateFile(requirements, ''); await fs.writeFile(requirements, text, { flush: true }) }
  else await fs.writeFile(requirements, text, { flag: 'wx', mode: 0o600, flush: true })
  progress('restoring_dependencies')
  if (plan.pins.length) await run(runtime.executables.uv, ['pip', 'install', '--no-config', '--no-python-downloads', '--only-binary', ':all:', '--no-deps', '--python', binary, '--requirements', requirements])
  progress('verifying_dependencies')
  await run(runtime.executables.uv, ['pip', 'check', '--no-config', '--no-python-downloads', '--python', binary])
  await run(binary, ['-I', '-B', '-X', 'utf8', '-c', `import sys,pip; assert sys.prefix != sys.base_prefix; assert sys.version_info[:2] == (${major},${minor})`])
  const rebuilt = await inspectPythonEnvironment({ root, dataDir, directory: relative })
  const installed = new Map(rebuilt.packages.map(pkg => [normalize(pkg.name), pkg.version]))
  if (!rebuilt.same_python_minor || installed.size !== rebuilt.packages.length || rebuilt.site_references !== 0 || rebuilt.special_site_files !== 0
    || rebuilt.packages.some(pkg => !pkg.has_file_record || ['modified_files', 'missing_files', 'unverified_files', 'references'].some(key => pkg[key] !== 0))
    || plan.pins.some(pkg => installed.get(pkg.name) !== pkg.version)) throw fail()
  const after = await inspectLegacyPythonEnvironment({ root, dataDir })
  if (after.fingerprint !== plan.source_fingerprint) throw fail('CRABOT_LEGACY_PYTHON_CHANGED')
  cancelled(signal)
  const record = { schema_version: 1, kind: 'legacy-python-rebuild', id, source_fingerprint: plan.source_fingerprint,
    python_version: runtime.manifest.versions.python, pins: plan.pins }
  const receipt = path.join(directory, 'legacy-rebuild.json'), bytes = JSON.stringify(record) + '\n'
  if (process.platform === 'win32') { identity.writePrivateFile(receipt, ''); await fs.writeFile(receipt, bytes, { flush: true }) }
  else await fs.writeFile(receipt, bytes, { flag: 'wx', mode: 0o600, flush: true })
  return { id, directory: relative, binary, source_fingerprint: plan.source_fingerprint,
    receipt_sha256: createHash('sha256').update(bytes).digest('hex'), selected: false }
}
