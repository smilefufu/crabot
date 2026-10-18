// Persistent fence for app version replacement. Only the lock-owning recovery
// adapter may start a verified version while this record exists.
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import identity from './process-identity.cjs'
import management from './desktop-management.cjs'
import { acquireStartupLock, releaseCliLock, cliLockToken } from './cli-lock.mjs'
import { verifyCoreRelease } from './core-release.mjs'
import { inspectInstance } from './instance-runtime.mjs'
import { verifyMaintenanceBackup } from './maintenance-backup.mjs'

const name = 'desktop-maintenance.json', recovering = new Set()
const version = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value)
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
const fail = () => { throw Object.assign(new Error('版本维护尚未核验完成。请在桌面应用中检查恢复，必要时重新安装；原数据和记录已保留。'), { code: 'CRABOT_MAINTENANCE_PENDING' }) }
function locked(dataDir) {
  dataDir = realpathSync(dataDir)
  if (!cliLockToken(path.join(dataDir, 'cli.lock'))) fail()
  return dataDir
}
function syncDirectory(directory) {
  if (process.platform === 'win32') return
  const fd = openSync(directory, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) }
}
export function readVersionMaintenance(dataDir) {
  const file = path.join(dataDir, name)
  let stat
  try { stat = lstatSync(file) } catch (error) { if (error.code === 'ENOENT') return null; fail() }
  try {
    const privateFile = process.platform === 'win32' ? identity.isPrivateFile(file)
      : String(stat.uid) === identity.inspectProcess(process.pid).owner && (stat.mode & 0o777) === 0o600
    if (!stat.isFile() || stat.size > 65_536 || !privateFile) fail()
    const record = JSON.parse(readFileSync(file, 'utf8'))
    if (record.schema_version !== 1 || !uuid(record.id) || record.data_dir !== realpathSync(dataDir)
      || !path.isAbsolute(record.install_root) || !version(record.source_version) || !version(record.target_version)
      || !/^[a-f0-9]{64}$/.test(record.source_inventory_sha256)
      || record.target_core !== undefined && (!record.target_core || typeof record.target_core.root !== 'string'
        || !path.isAbsolute(record.target_core.root) || !/^[a-f0-9]{64}$/.test(record.target_core.inventory_sha256)
        || Object.keys(record.target_core).some(key => !['root', 'inventory_sha256'].includes(key)))
      || !['preparing', 'backed_up', 'installing', 'verifying'].includes(record.phase)
      || record.backup !== null && (!uuid(record.backup?.id) || !/^[a-f0-9]{64}$/.test(record.backup?.sha256))) fail()
    return record
  } catch { fail() }
}
function write(dataDir, record, initial = false) {
  const destination = path.join(dataDir, name), temporary = destination + '.tmp-' + randomUUID()
  const text = JSON.stringify(record) + '\n'
  try {
    if (process.platform === 'win32') identity.writePrivateFile(temporary, text)
    else writeFileSync(temporary, text, { flag: 'wx', mode: 0o600, flush: true })
    if (initial && existsSync(destination)) fail()
    renameSync(temporary, destination); syncDirectory(dataDir)
  } finally { rmSync(temporary, { force: true }) }
}
export function assertVersionMaintenanceAllowsStart(dataDir) {
  const record = readVersionMaintenance(dataDir)
  if (record && (!recovering.has(record.id) || !cliLockToken(path.join(realpathSync(dataDir), 'cli.lock')))) fail()
}
export async function beginVersionMaintenance(dataDir, root, targetVersion, sourceVersion) {
  dataDir = locked(dataDir)
  management.ensurePrivateDataRoot(dataDir)
  if (readVersionMaintenance(dataDir) || !version(targetVersion)) fail()
  const release = await verifyCoreRelease(root, { version: sourceVersion })
  const record = { schema_version: 1, id: randomUUID(), data_dir: dataDir, install_root: realpathSync(root),
    source_version: release.version, target_version: targetVersion, source_inventory_sha256: release.inventory_sha256,
    phase: 'preparing', backup: null }
  write(dataDir, record, true); return record
}
// Bind an already verified immutable target before replacement begins. Existing
// in-place App updates omit this field and retain their original root contract.
export async function bindVersionMaintenanceTarget(dataDir, id, root) {
  dataDir = locked(dataDir)
  const record = readVersionMaintenance(dataDir)
  if (record?.id !== id || !['preparing', 'backed_up'].includes(record.phase)) fail()
  root = realpathSync(root)
  const release = await verifyCoreRelease(root, { version: record.target_version })
  if (record.target_core) {
    if (record.target_core.root !== root || record.target_core.inventory_sha256 !== release.inventory_sha256) fail()
    return record
  }
  record.target_core = { root, inventory_sha256: release.inventory_sha256 }
  write(dataDir, record); return record
}
async function backupOf(dataDir, record) {
  if (!record.backup) fail()
  const directory = path.join(dataDir + '.desktop-backups', record.backup.id)
  const backup = await verifyMaintenanceBackup(directory, record.backup.sha256)
  if (backup.source !== dataDir || backup.id !== record.backup.id) fail()
}
export async function recordVersionMaintenanceBackup(dataDir, id, backup) {
  dataDir = locked(dataDir)
  const record = readVersionMaintenance(dataDir)
  if (record?.id !== id || record.phase !== 'preparing' || !uuid(backup.id) || !/^[a-f0-9]{64}$/.test(backup.sha256)) fail()
  record.backup = { id: backup.id, sha256: backup.sha256 }
  await backupOf(dataDir, record)
  record.phase = 'backed_up'; write(dataDir, record)
}
export async function markVersionMaintenanceInstalling(dataDir, id) {
  dataDir = locked(dataDir)
  const record = readVersionMaintenance(dataDir)
  if (record?.id !== id || record.phase !== 'backed_up') fail()
  await backupOf(dataDir, record)
  record.phase = 'installing'; write(dataDir, record)
}
// verifyCompatible is read-only. run uses the ordinary migration/start/health
// path under this same lock; neither callback may relabel schemas or reset data.
export async function recoverVersionMaintenance({ dataDir, root, appVersion, verifyCompatible, run }) {
  const lock = await acquireStartupLock(dataDir, 'desktop-recover-version')
  let record
  try {
    dataDir = locked(dataDir); record = readVersionMaintenance(dataDir)
    if (!record) return false
    root = realpathSync(root)
    const exactSource = record.install_root === root, exactTarget = (record.target_core?.root ?? record.install_root) === root
    if (!exactSource && !exactTarget) fail()
    const release = await verifyCoreRelease(root, { version: appVersion })
    const previous = exactSource && ['preparing', 'backed_up'].includes(record.phase) && appVersion === record.source_version
      && release.inventory_sha256 === record.source_inventory_sha256
    if (!previous && (!exactTarget || appVersion !== record.target_version
      || record.target_core && release.inventory_sha256 !== record.target_core.inventory_sha256)) fail()
    const expectedInventory = previous ? record.source_inventory_sha256 : record.target_core?.inventory_sha256
    if (record.backup) await backupOf(dataDir, record)
    else if (!previous) fail()
    await verifyCompatible()
    recovering.add(record.id)
    // Do not turn a pre-install failure into an installer-started state: only
    // the exact verified source may be resumed if replacement never began.
    if (!previous) { record.phase = 'verifying'; write(dataDir, record) }
    if (!await run()) fail()
    const completed = await verifyCoreRelease(root, { version: appVersion })
    if (expectedInventory && completed.inventory_sha256 !== expectedInventory) fail()
    await verifyCompatible()
    if (readVersionMaintenance(dataDir)?.id !== record.id) fail()
    rmSync(path.join(dataDir, name)); syncDirectory(dataDir)
    return true
  } finally { if (record) recovering.delete(record.id); releaseCliLock(lock) }
}


// Offline completion preserves the stopped state. Callers own version selection;
// this is separate from GUI recovery that starts the service and verifies health.
export async function completeStoppedVersionMaintenance({ dataDir, root, id, migrate, verifyComplete }) {
  dataDir = locked(dataDir)
  const record = readVersionMaintenance(dataDir)
  root = realpathSync(root)
  if (record?.id !== id || record.phase !== 'installing' || record.target_core?.root !== root) fail()
  const verify = async () => {
    if (inspectInstance(dataDir).state !== 'stopped') fail()
    const release = await verifyCoreRelease(root, { version: record.target_version })
    if (release.inventory_sha256 !== record.target_core.inventory_sha256) fail()
    await backupOf(dataDir, record)
  }
  await verify()
  record.phase = 'verifying'; write(dataDir, record)
  recovering.add(record.id)
  try {
    await migrate()
    await verifyComplete()
    await verify()
    if (readVersionMaintenance(dataDir)?.id !== record.id) fail()
    rmSync(path.join(dataDir, name)); syncDirectory(dataDir)
  } finally { recovering.delete(record.id) }
}

// Existing user-CLI adapter retains its entry and identical offline semantics.
export function completeStoppedCliVersionMaintenance(options) { return completeStoppedVersionMaintenance(options) }
