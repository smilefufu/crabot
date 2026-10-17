// Persistent fence for app version replacement. Only the lock-owning recovery
// adapter may start a verified version while this record exists.
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import identity from './process-identity.cjs'
import management from './desktop-management.cjs'
import { acquireCliLock, releaseCliLock, cliLockToken } from './cli-lock.mjs'
import { verifyCoreRelease } from './core-release.mjs'
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
  const lock = await acquireCliLock(dataDir, 'desktop-recover-version')
  let record
  try {
    dataDir = locked(dataDir); record = readVersionMaintenance(dataDir)
    if (!record) return false
    if (record.install_root !== realpathSync(root)) fail()
    const release = await verifyCoreRelease(root, { version: appVersion })
    const previous = ['preparing', 'backed_up'].includes(record.phase) && appVersion === record.source_version
      && release.inventory_sha256 === record.source_inventory_sha256
    if (!previous && appVersion !== record.target_version) fail()
    if (record.backup) await backupOf(dataDir, record)
    else if (!previous) fail()
    await verifyCompatible()
    recovering.add(record.id)
    // Do not turn a pre-install failure into an installer-started state: only
    // the exact verified source may be resumed if replacement never began.
    if (!previous) { record.phase = 'verifying'; write(dataDir, record) }
    if (!await run()) fail()
    await verifyCoreRelease(root, { version: appVersion }); await verifyCompatible()
    if (readVersionMaintenance(dataDir)?.id !== record.id) fail()
    rmSync(path.join(dataDir, name)); syncDirectory(dataDir)
    return true
  } finally { if (record) recovering.delete(record.id); releaseCliLock(lock) }
}
