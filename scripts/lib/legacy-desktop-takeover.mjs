// Dedicated target-Node data role for legacy-user takeover. Program selection,
// OS/CLI registration and ordinary target GUI health are separate later steps.
import { promises as fs, realpathSync, constants } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import product from './product-runtime.cjs'
import identity from './process-identity.cjs'
import installationState from './desktop-installation.cjs'
import management from './desktop-management.cjs'
import pythonSelection from './agent-python-selection.cjs'
import { randomUUID } from 'node:crypto'
import { privateJson, readPending } from './desktop-preparation-files.mjs'
import { acquireExistingCliLock, releaseCliLock } from './cli-lock.mjs'
import { verifyLegacyDesktopPrograms } from './legacy-desktop-programs.mjs'
import { inspectLegacyEntryFence, enableLegacyCliForwarding } from './legacy-entry-fence.mjs'
import { inspectInstance } from './instance-runtime.mjs'
import { adoptLegacyDesktopCli } from './legacy-desktop-cli.mjs'
import { discoverSealedLegacyRuntime } from './legacy-runtime.mjs'
import { inspectLegacyPythonEnvironment } from './legacy-python.mjs'
import { readVersionMaintenance } from './version-maintenance.mjs'
import { convertLegacyUserData } from './legacy-user-data-conversion.mjs'
import { verifyDataCompatibility } from './core-preparation.mjs'
import { assertNoInterruptedMigrations } from '../upgrade-lib/migration-transaction.mjs'
const fail = () => { throw Object.assign(new Error('旧安装接管尚未核验完成，原数据和保护记录已保留，请从同一安装包继续检查。'), { code: 'CRABOT_MAINTENANCE_PENDING' }) }

function matchesMaintenance(value, prepared, entryFenceId) {
  const source = prepared.installation
  return value?.schema_version === 4 && value.data_dir === source.dataRoot && value.install_root === source.installRoot
    && value.source_version === source.version && value.legacy_source.scope === 'user'
    && value.legacy_source.fingerprint === source.fingerprint && value.legacy_source.entry_fence_id === entryFenceId
    && value.target_version === prepared.selection.version && value.target_core.root === prepared.coreRoot
    && value.target_core.inventory_sha256 === prepared.selection.core_id
}
function targetRuntime(prepared) {
  const root = realpathSync(fileURLToPath(new URL('../../', import.meta.url)))
  if (root !== prepared?.coreRoot) fail()
  const runtime = product.loadProductRuntime(root, { required: true, full: true })
  if (realpathSync(process.execPath) !== realpathSync(runtime.executables.node)) fail()
  return { root, runtime }
}
async function present(file) { try { return await fs.lstat(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }

// All locks and maintenance imports must come from this exact verified target,
// rather than an installer/Electron module with a different in-memory lock map.
export async function convertLegacyDesktopData({ prepared, signal, progress = () => {}, inspectEnvironment = inspectLegacyPythonEnvironment }) {
  return convertLegacyUserData({ installation: prepared.installation,
    target: { root: prepared.coreRoot, version: prepared.selection.version, core_id: prepared.selection.core_id },
    verifyPrograms: options => verifyLegacyDesktopPrograms(prepared, options), signal, progress, inspectEnvironment })
}


// After the exact stopped conversion only. This publishes the existing desktop
// formats and target selector, but leaves version protection for ordinary GUI health.
export async function commitLegacyDesktopInstallation({ prepared, maintenanceId, registerEntries }) {
  const { root } = targetRuntime(prepared), source = prepared.installation, dataDir = source.dataRoot
  if (typeof registerEntries !== 'function') fail()
  const rootLock = await acquireExistingCliLock(source.installRoot, 'commit-legacy-desktop-installation')
  let dataLock
  try {
    dataLock = await acquireExistingCliLock(dataDir, 'commit-legacy-desktop-installation')
    const entry = await inspectLegacyEntryFence(source.installRoot)
    const current = () => {
      const record = readVersionMaintenance(dataDir)
      if (!matchesMaintenance(record, prepared, entry.id) || record.id !== maintenanceId || record.phase !== 'verifying' || !record.legacy_python) fail()
      const selected = pythonSelection.readAgentEnvironmentReference(dataDir)
      if (record.legacy_python.status === 'prepared') {
        pythonSelection.verifyAgentEnvironmentCandidate(dataDir, record.legacy_python.reference)
        if (JSON.stringify(selected) !== JSON.stringify(record.legacy_python.reference)) fail()
      } else if (selected !== null) fail()
      if (inspectInstance(dataDir).state !== 'stopped') fail()
    }
    const verify = async () => {
      current()
      await verifyLegacyDesktopPrograms(prepared, { entryFenceId: entry.id })
      if ((await discoverSealedLegacyRuntime(source, { entryFenceId: entry.id })).state !== 'stopped') fail()
      await assertNoInterruptedMigrations(dataDir)
      if (verifyDataCompatibility(root, dataDir).length) fail()
      current()
    }
    await verify()
    const bin = path.join(source.installRoot, 'bin')
    if (await present(bin)) management.requireExistingDataRoot(bin)
    else management.ensurePrivateDataRoot(bin)
    const metadata = path.join(source.installRoot, 'desktop-installation.json')
    if (!await present(metadata)) {
      const stat = await fs.lstat(source.installRoot, { bigint: true })
      await privateJson(metadata, { schema_version: 1, installation_id: randomUUID(), owner: identity.inspectProcess(process.pid).owner,
        install_root: source.installRoot, root_identity: { dev: String(stat.dev), ino: String(stat.ino) },
        paths: { app: 'app/releases', core: 'releases', data: 'data', bin: 'bin' } })
    }
    const own = installationState.readDesktopInstallation(source.installRoot)
    const name = process.platform === 'win32' ? 'crabot.exe' : 'crabot', launcher = path.join(bin, name), original = path.join(root, 'bin', name)
    const stat = await present(launcher)
    if (stat) {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
        || (process.platform === 'win32' ? !identity.isOwnedFile(launcher) : stat.uid !== process.getuid())
        || !(await fs.readFile(launcher)).equals(await fs.readFile(original))) fail()
    } else {
      await fs.copyFile(original, launcher, constants.COPYFILE_EXCL)
      if (process.platform !== 'win32') await fs.chmod(launcher, 0o755)
    }
    const marker = { schema_version: 1, install_kind: 'desktop', admin_listen_host: '127.0.0.1' }, markerFile = path.join(dataDir, 'desktop-managed.json')
    const markerStat = await present(markerFile)
    if (markerStat) {
      if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink !== 1
        || (process.platform === 'win32' ? !identity.isPrivateFile(markerFile) : markerStat.uid !== process.getuid() || (markerStat.mode & 0o777) !== 0o600)
        || JSON.stringify(management.readDesktopManagement(dataDir)) !== JSON.stringify(marker)) fail()
    } else await privateJson(markerFile, marker)
    const registration = { installRoot: own.root, installation_id: own.record.installation_id,
      selection: prepared.selection, coreRoot: prepared.coreRoot, guiRoot: prepared.guiRoot }
    // Existing program-preparation format: it binds the exact GUI for native
    // sandbox inspection and keeps normal GUI startup blocked until OS entries
    // finish. No fresh-data initializer or additional recovery format is used.
    const pending = { schema_version: 1, id: maintenanceId, installation_id: own.record.installation_id,
      selection: prepared.selection, phase: 'prepared', payload_sha256: prepared.proof.sha256 }
    const originalPending = await readPending(own.root)
    if (originalPending && JSON.stringify(originalPending) !== JSON.stringify(pending)) fail()
    if (!originalPending) await privateJson(path.join(own.root, '.desktop-installing.json'), pending)
    const selector = path.join(own.root, 'current-release.json')
    if (await present(selector) && JSON.stringify(installationState.readDesktopPairReference(own.root).selection) !== JSON.stringify(prepared.selection)) fail()
    await enableLegacyCliForwarding(source.installRoot, entry.id)
    await adoptLegacyDesktopCli({ installRoot: own.root })
    await registerEntries(registration)
    await verify()
    if (JSON.stringify(installationState.readDesktopInstallation(own.root).record) !== JSON.stringify(own.record)) fail()
    if (JSON.stringify(await readPending(own.root)) !== JSON.stringify(pending)) fail()
    if (!await present(selector)) await privateJson(selector, prepared.selection)
    await fs.unlink(path.join(own.root, '.desktop-installing.json'))
    if (process.platform !== 'win32') {
      const directory = await fs.open(own.root, 'r'); try { await directory.sync() } finally { await directory.close() }
    }
    const selected = installationState.readDesktopSelection(own.root)
    if (JSON.stringify(selected.selection) !== JSON.stringify(prepared.selection)) fail()
    current()
    return { executable: selected.executable, dataDir, maintenance_id: maintenanceId, verification_pending: true, health_verified: false }
  } finally { if (dataLock) releaseCliLock(dataLock); releaseCliLock(rootLock) }
}
