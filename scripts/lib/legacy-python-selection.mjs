// Explicit stopped-takeover step. The caller owns confirmation/backup and may
// cancel the reference only before resuming business; no environment is moved.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import management from './desktop-management.cjs'
import selection from './agent-python-selection.cjs'
import identity from './process-identity.cjs'
import product from './product-runtime.cjs'
import python from './product-python-env.cjs'
import { cliLockToken } from './cli-lock.mjs'
import { inspectInstance } from './instance-runtime.mjs'
import { inspectLegacyPythonEnvironment, inspectPythonEnvironment } from './legacy-python.mjs'
import { planLegacyPythonRebuild } from './legacy-python-rebuild.mjs'
const fail = (code = 'CRABOT_LEGACY_PYTHON_SELECTION_UNVERIFIED', cause) => { throw Object.assign(new Error('Python默认环境尚不能安全切换；原环境、准备目录及已有引用均保留。', { cause }), { code }) }
const uncertain = cause => fail('CRABOT_PYTHON_SELECTION_UNKNOWN', cause)
function stopped(dataDir) {
  dataDir = management.requirePrivateDataRoot(dataDir)
  if (!cliLockToken(path.join(dataDir, 'cli.lock')) || inspectInstance(dataDir).state !== 'stopped') fail('CRABOT_BACKUP_REQUIRES_STOP')
  return dataDir
}
function reference(prepared, expectedFingerprint) {
  if (prepared.source_fingerprint !== expectedFingerprint) fail()
  return { schema_version: 1, id: prepared.id, directory: prepared.directory,
    receipt_sha256: prepared.receipt_sha256, source_fingerprint: expectedFingerprint }
}
async function sourcePlan(root, dataDir, expectedFingerprint) {
  const plan = planLegacyPythonRebuild(await inspectLegacyPythonEnvironment({ root, dataDir }))
  if (plan.source_fingerprint !== expectedFingerprint) fail('CRABOT_LEGACY_PYTHON_CHANGED')
  return plan
}
async function sync(directory) {
  if (process.platform === 'win32') return
  const fd = await fs.open(directory, 'r'); try { await fd.sync() } finally { await fd.close() }
}
export async function selectLegacyPythonRebuild({ root, dataDir, prepared, expectedFingerprint }) {
  dataDir = stopped(dataDir)
  const record = reference(prepared, expectedFingerprint), candidate = selection.verifyAgentEnvironmentCandidate(dataDir, record)
  const current = selection.readAgentEnvironmentReference(dataDir)
  if (current && JSON.stringify(current) !== JSON.stringify(record)) fail('CRABOT_PYTHON_SELECTION_CONFLICT')
  const plan = await sourcePlan(root, dataDir, expectedFingerprint)
  if (JSON.stringify(plan.pins) !== JSON.stringify(candidate.receipt.pins)) fail()
  const rebuilt = await inspectPythonEnvironment({ root, dataDir, directory: record.directory })
  const packages = new Map(rebuilt.packages.map(pkg => [pkg.name.toLowerCase().replace(/[-_.]+/g, '-'), pkg.version]))
  if (!rebuilt.same_python_minor || rebuilt.site_references || rebuilt.special_site_files || packages.size !== rebuilt.packages.length
    || rebuilt.packages.some(pkg => !pkg.has_file_record || ['modified_files', 'missing_files', 'unverified_files', 'references'].some(key => pkg[key] !== 0))
    || plan.pins.some(pkg => packages.get(pkg.name) !== pkg.version)) fail()
  const runtime = product.loadProductRuntime(root, { required: true, full: true })
  try { python.ensureProductPythonEnvironment(runtime, dataDir, candidate.directory, spawnSync) }
  catch (error) { fail('CRABOT_LEGACY_PYTHON_SELECTION_UNVERIFIED', error) }
  await sourcePlan(root, dataDir, expectedFingerprint)
  selection.verifyAgentEnvironmentCandidate(dataDir, record)
  if (JSON.stringify(selection.readAgentEnvironmentReference(dataDir)) !== JSON.stringify(current)) fail('CRABOT_PYTHON_SELECTION_CONFLICT')
  if (!current) {
    const file = path.join(dataDir, selection.selectionName), temporary = file + '.tmp-' + randomUUID()
    let published = false
    try {
      const bytes = JSON.stringify(record) + '\n'
      if (process.platform === 'win32') { identity.writePrivateFile(temporary, ''); await fs.writeFile(temporary, bytes, { flush: true }) }
      else await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600, flush: true })
      if (process.platform !== 'win32') await fs.chmod(temporary, 0o600)
      // All supported writers hold the same lifecycle lock. Recheck initial
      // absence immediately before atomic rename; no transient hardlink survives
      // a crash to make an otherwise complete private reference unreadable.
      if (selection.readAgentEnvironmentReference(dataDir)) fail('CRABOT_PYTHON_SELECTION_CONFLICT')
      await fs.rename(temporary, file); published = true
      await sync(dataDir)
    } catch (error) { if (published) uncertain(error); throw error }
    finally { await fs.rm(temporary, { force: true }) }
  }
  return { ...record, selected: true }
}
export async function cancelLegacyPythonSelection({ root, dataDir, prepared, expectedFingerprint }) {
  dataDir = stopped(dataDir)
  const current = selection.readAgentEnvironmentReference(dataDir)
  if (!current) return { cleared: false }
  if (JSON.stringify(current) !== JSON.stringify(reference(prepared, expectedFingerprint))) fail('CRABOT_PYTHON_SELECTION_CONFLICT')
  await sourcePlan(root, dataDir, expectedFingerprint)
  await fs.unlink(path.join(dataDir, selection.selectionName))
  try { await sync(dataDir) } catch (error) { uncertain(error) }
  return { cleared: true }
}
