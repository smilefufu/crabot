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
import cliLocation from './cli-location.cjs'
import { inspectLegacyEntryFence, sealLegacyEntryFence } from './legacy-entry-fence.mjs'
import { discoverLegacyRuntime, discoverSealedLegacyRuntime } from './legacy-runtime.mjs'

const name = 'desktop-maintenance.json', recovering = new Set()
const legacyVersions = JSON.parse(readFileSync(new URL('../desktop/legacy-releases.json', import.meta.url), 'utf8')).versions
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
    const source = record.legacy_source
    const validSource = record.schema_version === 1
      ? version(record.source_version) && /^[a-f0-9]{64}$/.test(record.source_inventory_sha256) && source === undefined
      : record.schema_version === 2 && legacyVersions.includes(record.source_version) && record.source_inventory_sha256 === undefined
        && record.system_operation_id === undefined && record.target_core !== undefined && source?.scope === 'user' && uuid(source.entry_fence_id)
        && /^[a-f0-9]{64}$/.test(source.fingerprint) && Object.keys(source).length === 3
    if (!validSource || !uuid(record.id) || record.data_dir !== realpathSync(dataDir)
      || !path.isAbsolute(record.install_root) || !version(record.target_version)
      || record.target_core !== undefined && (!record.target_core || typeof record.target_core.root !== 'string'
        || !path.isAbsolute(record.target_core.root) || !/^[a-f0-9]{64}$/.test(record.target_core.inventory_sha256)
        || Object.keys(record.target_core).some(key => !['root', 'inventory_sha256'].includes(key)))
      || record.system_operation_id !== undefined && !uuid(record.system_operation_id)
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
export async function beginVersionMaintenance(dataDir, root, targetVersion, sourceVersion, { systemOperationId } = {}) {
  dataDir = locked(dataDir)
  management.ensurePrivateDataRoot(dataDir)
  if (readVersionMaintenance(dataDir) || !version(targetVersion) || systemOperationId !== undefined && !uuid(systemOperationId)) fail()
  const release = await verifyCoreRelease(root, { version: sourceVersion })
  const record = { schema_version: 1, id: randomUUID(), data_dir: dataDir, install_root: realpathSync(root),
    source_version: release.version, target_version: targetVersion, source_inventory_sha256: release.inventory_sha256,
    phase: 'preparing', backup: null, ...(systemOperationId ? { system_operation_id: systemOperationId } : {}) }
  write(dataDir, record, true); return record
}
// Explicit legacy-user adapter. The ordinary sealed source path above remains
// distinct; no old release is assigned a fabricated Core inventory/version.
async function legacyUserSource(record) {
  if (record?.schema_version !== 2 || record.legacy_source?.scope !== 'user'
    || inspectInstance(record.data_dir).state !== 'stopped') fail()
  for (const marker of ['.git', 'core-release.json', 'cli-installation.json']) {
    try { lstatSync(path.join(record.install_root, marker)); fail() } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const fenced = await inspectLegacyEntryFence(record.install_root)
  const expected = { version: record.source_version, installRoot: record.install_root,
    dataRoot: record.data_dir, fingerprint: record.legacy_source.fingerprint }
  if (fenced.id !== record.legacy_source.entry_fence_id || !fenced.entries_fenced
    || !['fenced', 'data_changing'].includes(fenced.phase)
    || Object.keys(expected).some(key => fenced.installation[key] !== expected[key])) fail()
  const observe = fenced.phase === 'fenced' ? discoverLegacyRuntime : discoverSealedLegacyRuntime
  if ((await observe(expected, { entryFenceId: fenced.id })).state !== 'stopped') fail()
  return fenced
}
export async function beginLegacyUserVersionMaintenance({ dataDir, installation, entryFenceId, targetRoot }) {
  dataDir = management.requirePrivateDataRoot(dataDir); locked(dataDir)
  if (readVersionMaintenance(dataDir) || !uuid(entryFenceId) || installation?.dataRoot !== dataDir
    || !legacyVersions.includes(installation?.version)) fail()
  targetRoot = realpathSync(targetRoot)
  const release = await verifyCoreRelease(targetRoot)
  const record = { schema_version: 2, id: randomUUID(), data_dir: dataDir, install_root: realpathSync(installation.installRoot),
    source_version: installation.version, target_version: release.version,
    legacy_source: { scope: 'user', entry_fence_id: entryFenceId, fingerprint: installation.fingerprint },
    target_core: { root: targetRoot, inventory_sha256: release.inventory_sha256 }, phase: 'preparing', backup: null }
  if ((await legacyUserSource(record)).phase !== 'fenced') fail()
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
  if (record.schema_version === 2) {
    const source = await legacyUserSource(record)
    if (source.phase === 'fenced') await sealLegacyEntryFence(record.install_root, source.id)
    if ((await legacyUserSource(record)).phase !== 'data_changing') fail()
  }
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
    // Legacy takeover owns entry/startup and environment selection as well as
    // data. The ordinary updater must never auto-resume just its target Core.
    if (record.schema_version !== 1) fail()
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

// Cancel only a pre-install preparation. This never restores data or starts a
// service; the coordinator separately owns selection and the original run set.
export async function cancelPreparedVersionMaintenance({ dataDir, root, id, verifyCompatible, systemOperationId }) {
  dataDir = locked(dataDir); root = realpathSync(root)
  const record = readVersionMaintenance(dataDir)
  if (record?.schema_version !== 1 || record.id !== id || !['preparing', 'backed_up'].includes(record.phase) || record.install_root !== root
    || systemOperationId !== undefined && record.system_operation_id !== systemOperationId
    || inspectInstance(dataDir).state !== 'stopped') fail()
  const verify = async () => {
    cliLocation.assertSelectedCli(root)
    const release = await verifyCoreRelease(root, { version: record.source_version })
    if (release.inventory_sha256 !== record.source_inventory_sha256 || inspectInstance(dataDir).state !== 'stopped') fail()
    if (record.backup) await backupOf(dataDir, record)
  }
  await verify()
  await verifyCompatible()
  await verify()
  const current = readVersionMaintenance(dataDir)
  if (current?.id !== id || current.phase !== record.phase) fail()
  rmSync(path.join(dataDir, name)); syncDirectory(dataDir)
  return { preparation_cancelled: true, service_started: false }
}

// Data protection only: the surrounding takeover may restore known old entries
// after this succeeds. It must not resume business while a newer phase exists.
export async function cancelPreparedLegacyUserVersionMaintenance({ dataDir, id }) {
  dataDir = locked(dataDir)
  const record = readVersionMaintenance(dataDir)
  if (record?.schema_version !== 2 || record.id !== id || !['preparing', 'backed_up'].includes(record.phase)) fail()
  if ((await legacyUserSource(record)).phase !== 'fenced') fail()
  if (record.backup) await backupOf(dataDir, record)
  if ((await legacyUserSource(record)).phase !== 'fenced') fail()
  const current = readVersionMaintenance(dataDir)
  if (current?.id !== id || current.phase !== record.phase) fail()
  rmSync(path.join(dataDir, name)); syncDirectory(dataDir)
  return { preparation_cancelled: true, service_started: false }
}
