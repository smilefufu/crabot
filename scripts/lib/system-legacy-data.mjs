// Legacy conversion data work, only after the dedicated role drops to the real
// employee UID. Root intent/sealing and service registration remain outside here.
import fs from 'node:fs'
import path from 'node:path'
import { userInfo } from 'node:os'
import { isDeepStrictEqual } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { validateSystemConversionInstance } from './system-conversion.mjs'
import { systemError } from './system-registry.mjs'
import pythonSelection from './agent-python-selection.cjs'
import { acquireCliLock, releaseCliLock } from './cli-lock.mjs'
import { inspectLegacySystemDataDirectory, privatizeLegacySystemDataDirectory, assertLegacySystemDataLayout } from './legacy-system-directory.mjs'
import { withFencedLegacySystemRuntime } from './legacy-system-runtime.mjs'
import { withVerifiedLegacyProcessGraph } from './legacy-process-graph.mjs'
import { inspectInstance } from './instance-runtime.mjs'
import { verifyCoreRelease } from './core-release.mjs'
import cliLocation from './cli-location.cjs'
import management from './desktop-management.cjs'
import { createMaintenanceBackup, assertLocalMigrationData, verifyMaintenanceBackup } from './maintenance-backup.mjs'
import { verifyDataCompatibility, applyStartupMigrations } from './core-preparation.mjs'
import { inspectLegacyPythonEnvironment } from './legacy-python.mjs'
import { prepareLegacyPythonRebuild } from './legacy-python-rebuild.mjs'
import { beginLegacySystemVersionMaintenance, cancelPreparedLegacySystemVersionMaintenance, markLegacySystemVersionMaintenanceInstalling,
  readVersionMaintenance, recordVersionMaintenanceBackup, completeStoppedVersionMaintenance,
  bindLegacyPythonMaintenance, selectLegacyPythonMaintenance } from './version-maintenance.mjs'
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = () => { throw systemError('旧共享实例的本人数据或迁移回执发生变化，未继续；原数据和保护保留。', 'CRABOT_SYSTEM_CONVERSION_DATA') }
function sync(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY)
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}
function privateWrite(file, bytes) {
  const fd = fs.openSync(file, 'wx', 0o600)
  try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, 0o600); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  sync(path.dirname(file))
}
function ownManifest(file, uid) {
  const parent = fs.lstatSync(path.dirname(file))
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== uid || parent.mode & 0o022) fail()
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.uid !== uid || stat.mode & 0o022 || stat.nlink !== 1 || stat.size > 65536) fail()
    const bytes = Buffer.alloc(65537)
    let size = 0
    while (size < bytes.length) {
      const count = fs.readSync(fd, bytes, size, bytes.length - size, size)
      if (!count) break
      size += count
    }
    if (size > 65536) fail()
    return bytes.subarray(0, size)
  } finally { fs.closeSync(fd) }
}

// manifestFile/runtimeOptions/inspectEnvironment/prepareEnvironment/processes
// are current-UID fixture seams. None are accepted from CLI, env or role permits.
export async function maintainLegacySystemUser(entry, { action, source, observation, sourceFenceId, operationId, targetRoot, snapshot, env, outputFd,
  manifestFile = path.join(entry.home, '.crabot/instance.json'), runtimeOptions, inspectEnvironment = inspectLegacyPythonEnvironment,
  prepareEnvironment = prepareLegacyPythonRebuild, processes = withVerifiedLegacyProcessGraph }) {
  const actual = userInfo()
  if (entry.uid <= 0 || actual.uid !== entry.uid || actual.gid !== entry.gid || actual.username !== entry.user || actual.homedir !== entry.home) fail()
  validateSystemConversionInstance({ entry, observation }, source)
  if (!['snapshot', 'migrate', 'cancel-preparation', 'check-migration'].includes(action) || !uuid(operationId) || !uuid(sourceFenceId)) fail()
  if (['migrate', 'check-migration'].includes(action) && (!snapshot || Object.keys(snapshot).length !== 4 || !uuid(snapshot.id)
    || snapshot.system_operation_id !== operationId || !uuid(snapshot.backup?.id) || Object.keys(snapshot.backup).length !== 2
    || !/^[a-f0-9]{64}$/.test(snapshot.backup.sha256) || !/^[a-f0-9]{64}$/.test(snapshot.target_id))) fail()
  const dataDir = inspectLegacySystemDataDirectory(entry.data_dir, observation.data_directory).directory
  if (dataDir !== entry.data_dir || observation.data_dir !== dataDir) fail()
  const context = { account: { user: entry.user, uid: entry.uid, gid: entry.gid, home: entry.home }, release: source, port_offset_hint: entry.port_offset }
  const parameters = { dataDir, context, expected: observation, entryFenceId: sourceFenceId, operationId, targetRoot, runtimeOptions }
  const lock = await acquireCliLock(dataDir, 'system-legacy-' + action)
  let diagnosticFd, diagnosticVerified = false
  try {
    inspectLegacySystemDataDirectory(dataDir, observation.data_directory)
    const target = ['migrate', 'check-migration'].includes(action) ? cliLocation.assertSelectedCli(targetRoot) : cliLocation.locateCliInstallation(targetRoot)
    const release = await verifyCoreRelease(targetRoot)
    if (!target || target.scope !== 'system' || target.id !== release.inventory_sha256 || targetRoot !== target.coreRoot) fail()
    const copyRelative = path.join('system-conversion', operationId, 'legacy-instance.json')
    const converted = bytes => {
      const previous = JSON.parse(bytes)
      if (previous.mode !== 'system' || previous.port_offset !== entry.port_offset || typeof previous.crabot_home !== 'string' || fs.realpathSync(previous.crabot_home) !== source.installRoot) fail()
      return { ...previous, data_dir: dataDir, crabot_home: targetRoot }
    }
    // The root role must require its durable migrated receipt before dispatching
    // this observation; a missing employee fence is never root completion proof.
    if (action === 'check-migration') {
      management.requirePrivateDataRoot(dataDir)
      assertLegacySystemDataLayout(dataDir)
      if (readVersionMaintenance(dataDir) || snapshot?.system_operation_id !== operationId || snapshot.target_id !== target.id
        || inspectInstance(dataDir).state !== 'stopped') fail()
      await processes(source.installRoot, value => { if (value.state !== 'stopped') fail() })
      const directory = path.join(dataDir + '.desktop-backups', snapshot.backup.id)
      const backup = await verifyMaintenanceBackup(directory, snapshot.backup.sha256)
      if (backup.source !== dataDir || verifyDataCompatibility(targetRoot, dataDir).length) fail()
      const original = ownManifest(path.join(directory, 'data', copyRelative), entry.uid)
      if (hash(original) !== observation.manifest_fingerprint
        || !isDeepStrictEqual(JSON.parse(ownManifest(manifestFile, entry.uid)), converted(original))) fail()
      return { verified: true, service_started: false }
    }
    if ((await withFencedLegacySystemRuntime(context, observation, value => value, runtimeOptions)).state !== 'stopped') fail()
    assertLegacySystemDataLayout(dataDir)
    if (['snapshot', 'cancel-preparation'].includes(action)) privatizeLegacySystemDataDirectory(dataDir, observation.data_directory)
    management.requirePrivateDataRoot(dataDir)
    const container = management.ensurePrivateDataRoot(path.join(dataDir, 'system-conversion'))
    const directory = management.ensurePrivateDataRoot(path.join(container, operationId))
    diagnosticFd = fs.openSync(path.join(directory, 'maintenance.log'), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600)
    const diagnostic = fs.fstatSync(diagnosticFd)
    if (!diagnostic.isFile() || diagnostic.uid !== entry.uid || diagnostic.nlink !== 1 || (diagnostic.mode & 0o777) !== 0o600) fail()
    diagnosticVerified = true; outputFd ??= diagnosticFd
    let record = readVersionMaintenance(dataDir)
    if (action === 'snapshot') {
      if (record) fail()
      await assertLocalMigrationData(dataDir, verifyDataCompatibility(targetRoot, dataDir), targetRoot)
      const original = ownManifest(manifestFile, entry.uid)
      if (hash(original) !== observation.manifest_fingerprint) fail()
      converted(original)
      record = await beginLegacySystemVersionMaintenance(parameters)
      privateWrite(path.join(directory, 'legacy-instance.json'), original)
      const backup = await createMaintenanceBackup(dataDir); await recordVersionMaintenanceBackup(dataDir, record.id, backup)
      const python = await inspectEnvironment({ root: targetRoot, dataDir })
      const prepared = python.status === 'absent' ? undefined : await prepareEnvironment({ root: targetRoot, dataDir, expectedFingerprint: python.fingerprint })
      await bindLegacyPythonMaintenance({ dataDir, id: record.id, prepared, inspectEnvironment })
      return { id: record.id, system_operation_id: operationId, backup: { id: backup.id, sha256: backup.sha256 }, target_id: target.id }
    }
    if (action === 'cancel-preparation' && !record) {
      if (pythonSelection.readAgentEnvironmentReference(dataDir)) fail()
      return { preparation_cancelled: false, service_started: false }
    }
    if (record?.schema_version !== 2 || record.legacy_source.scope !== 'system' || record.system_operation_id !== operationId
      || record.legacy_source.entry_fence_id !== sourceFenceId || record.install_root !== source.installRoot
      || record.legacy_source.fingerprint !== source.code_fingerprint || record.legacy_source.manifest_fingerprint !== observation.manifest_fingerprint
      || record.target_core.root !== targetRoot || record.target_core.inventory_sha256 !== target.id) fail()
    if (action === 'cancel-preparation') return cancelPreparedLegacySystemVersionMaintenance({ ...parameters, id: record.id })
    if (record.phase !== 'backed_up' || !record.legacy_python || record.id !== snapshot?.id || snapshot.system_operation_id !== operationId
      || snapshot.target_id !== target.id || record.backup.id !== snapshot.backup?.id || record.backup.sha256 !== snapshot.backup.sha256) fail()
    const original = ownManifest(manifestFile, entry.uid)
    if (hash(original) !== observation.manifest_fingerprint) fail()
    const next = Buffer.from(JSON.stringify(converted(original)) + '\n')
    await markLegacySystemVersionMaintenanceInstalling({ ...parameters, id: record.id })
    await selectLegacyPythonMaintenance({ dataDir, id: record.id, inspectEnvironment })
    await completeStoppedVersionMaintenance({ dataDir, root: targetRoot, id: record.id,
      migrate: async () => {
        await applyStartupMigrations(targetRoot, dataDir, { ...env, DATA_DIR: dataDir }, undefined, { outputFd })
        if (hash(ownManifest(manifestFile, entry.uid)) !== observation.manifest_fingerprint) fail()
        const temporary = manifestFile + '.conversion-' + randomUUID()
        try { privateWrite(temporary, next); fs.renameSync(temporary, manifestFile); sync(path.dirname(manifestFile)) }
        finally { fs.rmSync(temporary, { force: true }) }
      }, verifyComplete: () => {
        if (verifyDataCompatibility(targetRoot, dataDir).length || !ownManifest(manifestFile, entry.uid).equals(next)) fail()
      } })
    return { migrated: true, service_started: false }
  } catch (error) {
    if (diagnosticVerified) {
      try { fs.writeSync(diagnosticFd, new Date().toISOString() + ' ' + (error.stack ?? 'Unknown conversion failure') + '\n') } catch {}
    }
    throw error
  } finally {
    if (diagnosticFd !== undefined) fs.closeSync(diagnosticFd)
    releaseCliLock(lock)
  }
}
