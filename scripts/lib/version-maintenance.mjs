// Persistent fence for app version replacement. Only the lock-owning recovery
// adapter may start a verified version while this record exists.
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { userInfo } from 'node:os'
import { withFencedLegacySystemRuntime } from './legacy-system-runtime.mjs'
import identity from './process-identity.cjs'
import management from './desktop-management.cjs'
import installation from './desktop-installation.cjs'
import { acquireStartupLock, releaseCliLock, cliLockToken } from './cli-lock.mjs'
import { verifyCoreRelease } from './core-release.mjs'
import { inspectInstance } from './instance-runtime.mjs'
import { verifyMaintenanceBackup } from './maintenance-backup.mjs'
import { previewMigrations } from '../upgrade-lib/migrate.mjs'
import { assertNoInterruptedMigrations } from '../upgrade-lib/migration-transaction.mjs'
import cliLocation from './cli-location.cjs'
import { inspectLegacyEntryFence, sealLegacyEntryFence } from './legacy-entry-fence.mjs'
import { discoverLegacyRuntime, discoverSealedLegacyRuntime } from './legacy-runtime.mjs'
import pythonSelection from './agent-python-selection.cjs'
import { inspectLegacyPythonEnvironment } from './legacy-python.mjs'
import { planLegacyPythonRebuild } from './legacy-python-rebuild.mjs'
import { selectLegacyPythonRebuild } from './legacy-python-selection.mjs'

const name = 'desktop-maintenance.json', recovering = new Set()
const legacyVersions = JSON.parse(readFileSync(new URL('../desktop/legacy-releases.json', import.meta.url), 'utf8')).versions
const version = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value)
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
const hasScopedProtection = record => [3, 4].includes(record?.schema_version)
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
    const validSource = [1, 3].includes(record.schema_version)
      ? version(record.source_version) && /^[a-f0-9]{64}$/.test(record.source_inventory_sha256) && source === undefined
      : [2, 4].includes(record.schema_version) && legacyVersions.includes(record.source_version) && record.source_inventory_sha256 === undefined
        && record.target_core !== undefined && uuid(source?.entry_fence_id) && /^[a-f0-9]{64}$/.test(source.fingerprint)
        && (source.scope === 'user' && record.system_operation_id === undefined && Object.keys(source).length === 3
          || record.schema_version === 2 && source.scope === 'system' && uuid(record.system_operation_id) && /^[a-f0-9]{64}$/.test(source.manifest_fingerprint) && Object.keys(source).length === 4)
    if (record.legacy_python !== undefined) {
      const prepared = record.legacy_python
      if (![2, 4].includes(record.schema_version) || !prepared || prepared.status === 'absent' && Object.keys(prepared).length !== 1
        || prepared.status === 'prepared' && Object.keys(prepared).length !== 2 || !['absent', 'prepared'].includes(prepared.status)) fail()
      if (prepared.status === 'prepared') pythonSelection.verifyAgentEnvironmentReference(prepared.reference)
    }
    const scoped = hasScopedProtection(record)
    const phases = scoped ? ['preparing', 'prepared', 'installing', 'verifying'] : ['preparing', 'backed_up', 'installing', 'verifying']
    if (scoped && (record.data_protection !== 'scoped' || record.backup !== null
      || record.phase !== 'preparing' && !record.target_core)) fail()
    if (!scoped && record.data_protection !== undefined) fail()
    if (!validSource || !uuid(record.id) || record.data_dir !== realpathSync(dataDir)
      || !path.isAbsolute(record.install_root) || !version(record.target_version)
      || record.target_core !== undefined && (!record.target_core || typeof record.target_core.root !== 'string'
        || !path.isAbsolute(record.target_core.root) || !/^[a-f0-9]{64}$/.test(record.target_core.inventory_sha256)
        || Object.keys(record.target_core).some(key => !['root', 'inventory_sha256'].includes(key)))
      || record.system_operation_id !== undefined && !uuid(record.system_operation_id)
      || !phases.includes(record.phase)
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
  if (record && (!recovering.has(record.id) || !cliLockToken(path.join(realpathSync(dataDir), 'cli.lock')))) {
    if (record.system_operation_id) throw Object.assign(new Error('管理员版本维护尚未核验完成。请联系管理员运行crabot system status检查恢复；原数据和备份已保留。'), { code: 'CRABOT_MAINTENANCE_PENDING' })
    fail()
  }
}
export async function beginVersionMaintenance(dataDir, root, targetVersion, sourceVersion, { systemOperationId, dataProtection } = {}) {
  dataDir = locked(dataDir)
  management.requireExistingDataRoot(dataDir)
  if (readVersionMaintenance(dataDir) || !version(targetVersion) || systemOperationId !== undefined && !uuid(systemOperationId)
    || dataProtection !== undefined && dataProtection !== 'scoped') fail()
  const release = await verifyCoreRelease(root, { version: sourceVersion })
  const record = { schema_version: dataProtection === 'scoped' ? 3 : 1, id: randomUUID(), data_dir: dataDir, install_root: realpathSync(root),
    source_version: release.version, target_version: targetVersion, source_inventory_sha256: release.inventory_sha256,
    phase: 'preparing', backup: null, ...(dataProtection ? { data_protection: dataProtection } : {}), ...(systemOperationId ? { system_operation_id: systemOperationId } : {}) }
  write(dataDir, record, true); return record
}
// A retained installation may no longer have its old Core. Its immutable
// removal proof supplies historical source facts, never old-code execution.
export async function beginRetainedDesktopVersionMaintenance({ installRoot, operationId, selection }) {
  if (!selection || selection.schema_version !== 1 || !version(selection.version) || !uuid(selection.gui_id)
    || !/^[a-f0-9]{64}$/.test(selection.core_id) || Object.keys(selection).length !== 4) fail()
  const { captureDesktopRemovalFacts } = await import('./desktop-removal-context.mjs')
  const { readOriginalDesktopPayload } = await import('./desktop-program-proof.mjs')
  const { readPending } = await import('./desktop-preparation-files.mjs')
  const { assertReinstallVersion } = await import('./desktop-reinstall.mjs')
  const context = await captureDesktopRemovalFacts({ installRoot, operationId }), { own } = context
  const dataDir = locked(management.requireExistingDataRoot(own.dataDir)), source = context.record.source_selection
  const current = () => {
    context.assertIdentity()
    if (!['removing', 'completed'].includes(context.record.phase) || readVersionMaintenance(dataDir)
      || JSON.stringify(installation.readDesktopPairReference(own.root).selection) !== JSON.stringify(source)) fail()
  }
  current(); assertReinstallVersion(source.version, selection.version)
  const targetRoot = realpathSync(path.join(own.root, 'releases', selection.core_id))
  const target = await verifyCoreRelease(targetRoot, { version: selection.version })
  if (target.inventory_sha256 !== selection.core_id) fail()
  const payload = await readOriginalDesktopPayload(own.root, selection), pending = await readPending(own.root)
  if (payload.record.platform !== process.platform || payload.record.arch !== process.arch
    || pending && (pending.phase !== 'prepared' || pending.installation_id !== own.record.installation_id
      || JSON.stringify(pending.selection) !== JSON.stringify(selection) || pending.payload_sha256 !== payload.sha256)) fail()
  current(); await context.proofCurrent(); current()
  if (JSON.stringify(await readPending(own.root)) !== JSON.stringify(pending)) fail()
  const record = { schema_version: 3, id: randomUUID(), data_dir: dataDir,
    install_root: path.join(own.root, 'releases', source.core_id), source_version: source.version, source_inventory_sha256: source.core_id,
    target_version: target.version, target_core: { root: targetRoot, inventory_sha256: target.inventory_sha256 },
    phase: 'preparing', backup: null, data_protection: 'scoped' }
  write(dataDir, record, true); return record
}

// Explicit legacy-user adapter. The ordinary sealed source path above remains
// distinct; no old release is assigned a fabricated Core inventory/version.
async function legacyUserSource(record) {
  if (![2, 4].includes(record?.schema_version) || record.legacy_source?.scope !== 'user'
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
export async function beginLegacyUserVersionMaintenance({ dataDir, installation, entryFenceId, targetRoot, dataProtection }) {
  dataDir = management.requireExistingDataRoot(dataDir); locked(dataDir)
  if (readVersionMaintenance(dataDir) || !uuid(entryFenceId) || installation?.dataRoot !== dataDir
    || !legacyVersions.includes(installation?.version) || dataProtection !== undefined && dataProtection !== 'scoped') fail()
  targetRoot = realpathSync(targetRoot)
  const release = await verifyCoreRelease(targetRoot)
  const record = { schema_version: dataProtection === 'scoped' ? 4 : 2, id: randomUUID(), data_dir: dataDir, install_root: realpathSync(installation.installRoot),
    source_version: installation.version, target_version: release.version,
    legacy_source: { scope: 'user', entry_fence_id: entryFenceId, fingerprint: installation.fingerprint },
    target_core: { root: targetRoot, inventory_sha256: release.inventory_sha256 }, phase: 'preparing', backup: null,
    ...(dataProtection ? { data_protection: dataProtection } : {}) }
  if ((await legacyUserSource(record)).phase !== 'fenced') fail()
  write(dataDir, record, true); return record
}
// Dedicated system source adapter. Root authorization/entry sealing belongs to
// the conversion role; these methods only protect this already-dropped UID's data.
function assertLegacySystemUid(context) {
  const actual = userInfo(), account = context?.account
  if (!account || account.uid <= 0 || actual.uid !== account.uid || actual.gid !== account.gid
    || actual.username !== account.user || actual.homedir !== account.home) fail()
}
async function legacySystemSource(record, { context, expected, operationId, entryFenceId, runtimeOptions }) {
  assertLegacySystemUid(context)
  if (record?.schema_version !== 2 || record.legacy_source?.scope !== 'system' || record.system_operation_id !== operationId
    || record.legacy_source.entry_fence_id !== entryFenceId || record.install_root !== context.release?.installRoot
    || record.source_version !== context.release.version || record.legacy_source.fingerprint !== context.release.code_fingerprint
    || record.legacy_source.manifest_fingerprint !== expected?.manifest_fingerprint || record.data_dir !== expected?.data_dir
    || inspectInstance(record.data_dir).state !== 'stopped') fail()
  const observed = await withFencedLegacySystemRuntime(context, expected, value => value, runtimeOptions)
  if (observed.state !== 'stopped') fail()
}
export async function beginLegacySystemVersionMaintenance(options) {
  const { context, expected, entryFenceId, operationId } = options
  assertLegacySystemUid(context)
  const dataDir = management.requirePrivateDataRoot(options.dataDir); locked(dataDir)
  if (readVersionMaintenance(dataDir) || !uuid(entryFenceId) || !uuid(operationId) || expected?.data_dir !== dataDir
    || !legacyVersions.includes(context.release?.version) || !/^[a-f0-9]{64}$/.test(expected.manifest_fingerprint)) fail()
  const targetRoot = realpathSync(options.targetRoot), release = await verifyCoreRelease(targetRoot)
  const record = { schema_version: 2, id: randomUUID(), data_dir: dataDir, install_root: realpathSync(context.release.installRoot),
    source_version: context.release.version, target_version: release.version, system_operation_id: operationId,
    legacy_source: { scope: 'system', entry_fence_id: entryFenceId, fingerprint: context.release.code_fingerprint,
      manifest_fingerprint: expected.manifest_fingerprint },
    target_core: { root: targetRoot, inventory_sha256: release.inventory_sha256 }, phase: 'preparing', backup: null }
  await legacySystemSource(record, options)
  write(dataDir, record, true); return record
}
// The root conversion role must have sealed shared entries before dispatching
// this step. Employees never read or modify the root-private fence transaction.
export async function markLegacySystemVersionMaintenanceInstalling(options) {
  assertLegacySystemUid(options.context)
  const dataDir = locked(management.requirePrivateDataRoot(options.dataDir)), record = readVersionMaintenance(dataDir)
  if (record?.id !== options.id || record.phase !== 'backed_up') fail()
  await backupOf(dataDir, record)
  await legacySystemSource(record, options)
  record.phase = 'installing'; write(dataDir, record)
}
export async function cancelPreparedLegacySystemVersionMaintenance(options) {
  assertLegacySystemUid(options.context)
  const dataDir = locked(management.requirePrivateDataRoot(options.dataDir)), record = readVersionMaintenance(dataDir)
  if (record?.id !== options.id || !['preparing', 'backed_up'].includes(record.phase)) fail()
  await legacySystemSource(record, options)
  if (record.backup) await backupOf(dataDir, record)
  await legacySystemSource(record, options)
  const current = readVersionMaintenance(dataDir)
  if (current?.id !== record.id || current.phase !== record.phase) fail()
  rmSync(path.join(dataDir, name)); syncDirectory(dataDir)
  return { preparation_cancelled: true, service_started: false }
}

async function legacyPythonProtection(dataDir, record) {
  if (hasScopedProtection(record)) return protectionOf(dataDir, record)
  const release = await verifyCoreRelease(record.target_core.root, { version: record.target_version })
  if (release.inventory_sha256 !== record.target_core.inventory_sha256) fail()
  await backupOf(dataDir, record)
}

// Persist only a prepared environment reference while the old default is still
// untouched. This grants neither deployment authority nor permission to start.
export async function bindLegacyPythonMaintenance({ dataDir, id, prepared, inspectEnvironment = inspectLegacyPythonEnvironment }) {
  dataDir = locked(management.requireExistingDataRoot(dataDir))
  const record = readVersionMaintenance(dataDir)
  if (![2, 4].includes(record?.schema_version) || record.id !== id || record.phase !== (hasScopedProtection(record) ? 'prepared' : 'backed_up')
    || inspectInstance(dataDir).state !== 'stopped' || pythonSelection.readAgentEnvironmentReference(dataDir)) fail()
  const root = record.target_core.root
  await legacyPythonProtection(dataDir, record)
  const observed = await inspectEnvironment({ root, dataDir })
  let value
  if (observed.status === 'absent' && prepared === undefined) value = { status: 'absent' }
  else {
    const reference = pythonSelection.verifyAgentEnvironmentReference({ schema_version: 1, id: prepared?.id, directory: prepared?.directory,
      source_fingerprint: prepared?.source_fingerprint, receipt_sha256: prepared?.receipt_sha256 })
    const candidate = pythonSelection.verifyAgentEnvironmentCandidate(dataDir, reference), plan = planLegacyPythonRebuild(observed)
    if (plan.source_fingerprint !== reference.source_fingerprint || JSON.stringify(plan.pins) !== JSON.stringify(candidate.receipt.pins)) fail()
    value = { status: 'prepared', reference }
  }
  if (record.legacy_python && JSON.stringify(record.legacy_python) !== JSON.stringify(value)) fail()
  record.legacy_python = value; write(dataDir, record); return record
}
// Selection is a data-changing step, after the surrounding takeover has sealed
// old entry points. A lost publication result retains the same installing guard.
export async function selectLegacyPythonMaintenance({ dataDir, id, inspectEnvironment = inspectLegacyPythonEnvironment, selectPrepared = selectLegacyPythonRebuild }) {
  dataDir = locked(management.requireExistingDataRoot(dataDir))
  const record = readVersionMaintenance(dataDir)
  if (![2, 4].includes(record?.schema_version) || record.id !== id || record.phase !== 'installing' || !record.legacy_python
    || inspectInstance(dataDir).state !== 'stopped') fail()
  const root = record.target_core.root
  await legacyPythonProtection(dataDir, record)
  if (record.legacy_python.status === 'absent') {
    if ((await inspectEnvironment({ root, dataDir })).status !== 'absent' || pythonSelection.readAgentEnvironmentReference(dataDir)) fail()
    return { selected: false, environment_created: false }
  }
  const reference = record.legacy_python.reference
  pythonSelection.verifyAgentEnvironmentCandidate(dataDir, reference)
  await selectPrepared({ root, dataDir, prepared: reference, expectedFingerprint: reference.source_fingerprint })
  const current = pythonSelection.readAgentEnvironmentReference(dataDir)
  if (!current || Object.keys(reference).some(key => current[key] !== reference[key])) fail()
  return { ...reference, selected: true }
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
// This is a preparation check, never a backup receipt. The common migration
// executor creates and verifies each exact recovery scope before its first write.
export async function prepareScopedVersionMaintenance(dataDir, id) {
  dataDir = locked(dataDir)
  const record = readVersionMaintenance(dataDir)
  if (!hasScopedProtection(record) || record.id !== id || record.phase !== 'preparing' || !record.target_core
    || inspectInstance(dataDir).state !== 'stopped') fail()
  await protectionOf(dataDir, record)
  record.phase = 'prepared'; write(dataDir, record); return record
}
async function protectionOf(dataDir, record) {
  if (!hasScopedProtection(record)) return backupOf(dataDir, record)
  if (!record.target_core || inspectInstance(dataDir).state !== 'stopped') fail()
  const release = await verifyCoreRelease(record.target_core.root, { version: record.target_version })
  if (release.inventory_sha256 !== record.target_core.inventory_sha256) fail()
  if (record.schema_version === 4) {
    const source = await legacyUserSource(record)
    if (['installing', 'verifying'].includes(record.phase) && source.phase !== 'data_changing') fail()
  }
  await previewMigrations(record.target_core.root, dataDir)
  if (record.schema_version === 4) await legacyUserSource(record)
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
  if (hasScopedProtection(record) || record?.id !== id || record.phase !== 'preparing' || !uuid(backup.id) || !/^[a-f0-9]{64}$/.test(backup.sha256)) fail()
  record.backup = { id: backup.id, sha256: backup.sha256 }
  await backupOf(dataDir, record)
  record.phase = 'backed_up'; write(dataDir, record)
}
export async function markVersionMaintenanceInstalling(dataDir, id) {
  dataDir = locked(dataDir)
  const record = readVersionMaintenance(dataDir)
  if (record?.id !== id || record.phase !== (hasScopedProtection(record) ? 'prepared' : 'backed_up')) fail()
  await protectionOf(dataDir, record)
  if ([2, 4].includes(record.schema_version)) {
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
    if (![1, 3].includes(record.schema_version)) fail()
    root = realpathSync(root)
    const exactSource = record.install_root === root, exactTarget = (record.target_core?.root ?? record.install_root) === root
    if (!exactSource && !exactTarget) fail()
    const release = await verifyCoreRelease(root, { version: appVersion })
    const previous = exactSource && ['preparing', 'backed_up', 'prepared'].includes(record.phase) && appVersion === record.source_version
      && release.inventory_sha256 === record.source_inventory_sha256
    if (!previous && (!exactTarget || appVersion !== record.target_version
      || record.target_core && release.inventory_sha256 !== record.target_core.inventory_sha256)) fail()
    const expectedInventory = previous ? record.source_inventory_sha256 : record.target_core?.inventory_sha256
    if (record.schema_version === 3) {
      try { await assertNoInterruptedMigrations(dataDir) }
      catch (error) { throw Object.assign(error, { code: 'CRABOT_MIGRATION_INTERRUPTED' }) }
      if (!previous) await protectionOf(dataDir, record)
    } else if (record.backup) await backupOf(dataDir, record)
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


// Run one stopped conversion without granting startup or clearing protection.
// A paired GUI update still owns selection, handoff and target health.
export async function migrateStoppedVersionMaintenance({ dataDir, root, id, migrate, verifyComplete }) {
  dataDir = locked(dataDir)
  const record = readVersionMaintenance(dataDir)
  root = realpathSync(root)
  if (record?.id !== id || record.phase !== 'installing' || record.target_core?.root !== root) fail()
  const verify = async () => {
    locked(dataDir)
    if (inspectInstance(dataDir).state !== 'stopped') fail()
    if (hasScopedProtection(record)) return protectionOf(dataDir, record)
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
  } finally { recovering.delete(record.id) }
}

// Existing offline callers finish here and keep their original stopped state.
export async function completeStoppedVersionMaintenance(options) {
  // Fresh legacy takeover still owns paired selection and actual GUI/Core health.
  if (readVersionMaintenance(locked(options.dataDir))?.schema_version === 4) fail()
  await migrateStoppedVersionMaintenance(options)
  const dataDir = locked(options.dataDir), record = readVersionMaintenance(dataDir)
  if (record?.id !== options.id || record.phase !== 'verifying') fail()
  rmSync(path.join(dataDir, name)); syncDirectory(dataDir)
}

// Existing user-CLI adapter retains its entry and identical offline semantics.
export function completeStoppedCliVersionMaintenance(options) { return completeStoppedVersionMaintenance(options) }

// Cancel only a pre-install preparation. This never restores data or starts a
// service; the coordinator separately owns selection and the original run set.
export async function cancelPreparedVersionMaintenance({ dataDir, root, id, verifyCompatible, systemOperationId }) {
  dataDir = locked(dataDir); root = realpathSync(root)
  const record = readVersionMaintenance(dataDir)
  if (![1, 3].includes(record?.schema_version) || record.id !== id || !['preparing', 'backed_up', 'prepared'].includes(record.phase) || record.install_root !== root
    || systemOperationId !== undefined && record.system_operation_id !== systemOperationId
    || inspectInstance(dataDir).state !== 'stopped') fail()
  const verify = async () => {
    cliLocation.assertSelectedCli(root)
    const release = await verifyCoreRelease(root, { version: record.source_version })
    if (release.inventory_sha256 !== record.source_inventory_sha256 || inspectInstance(dataDir).state !== 'stopped') fail()
    if (record.schema_version === 3) await assertNoInterruptedMigrations(dataDir)
    else if (record.backup) await backupOf(dataDir, record)
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
  if (![2, 4].includes(record?.schema_version) || record.id !== id
    || !['preparing', hasScopedProtection(record) ? 'prepared' : 'backed_up'].includes(record.phase)) fail()
  if ((await legacyUserSource(record)).phase !== 'fenced') fail()
  if (hasScopedProtection(record)) await assertNoInterruptedMigrations(dataDir)
  else if (record.backup) await backupOf(dataDir, record)
  if ((await legacyUserSource(record)).phase !== 'fenced') fail()
  const current = readVersionMaintenance(dataDir)
  if (current?.id !== id || current.phase !== record.phase) fail()
  rmSync(path.join(dataDir, name)); syncDirectory(dataDir)
  return { preparation_cancelled: true, service_started: false }
}
