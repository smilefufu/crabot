// Common stopped conversion only. Layout adapters verify their own immutable
// programs and commit their own entries; this layer never selects GUI programs.
import { promises as fs, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import product from './product-runtime.cjs'
import { acquireExistingCliLock, releaseCliLock } from './cli-lock.mjs'
import { fenceLegacyEntries, inspectLegacyEntryFence, resumeLegacyEntryFence } from './legacy-entry-fence.mjs'
import { inspectInstance } from './instance-runtime.mjs'
import { discoverSealedLegacyRuntime } from './legacy-runtime.mjs'
import { stopFencedLegacyInstance } from './legacy-stop.mjs'
import { inspectLegacyPythonEnvironment } from './legacy-python.mjs'
import { prepareLegacyPythonRebuild } from './legacy-python-rebuild.mjs'
import { beginLegacyUserVersionMaintenance, readVersionMaintenance, prepareScopedVersionMaintenance,
  bindLegacyPythonMaintenance, markVersionMaintenanceInstalling, selectLegacyPythonMaintenance, migrateStoppedVersionMaintenance } from './version-maintenance.mjs'
import { applyStartupMigrations, verifyDataCompatibility } from './core-preparation.mjs'
import { assertNoInterruptedMigrations } from '../upgrade-lib/migration-transaction.mjs'
const fail = () => { throw Object.assign(new Error('旧数据接入尚未核验完成，原数据和保护记录已保留。'), { code: 'CRABOT_MAINTENANCE_PENDING' }) }
function matches(value, source, target, entryFenceId) {
  return value?.schema_version === 4 && value.data_dir === source.dataRoot && value.install_root === source.installRoot
    && value.source_version === source.version && value.legacy_source.scope === 'user'
    && value.legacy_source.fingerprint === source.fingerprint && value.legacy_source.entry_fence_id === entryFenceId
    && value.target_version === target.version && value.target_core.root === target.root
    && value.target_core.inventory_sha256 === target.core_id
}
export async function convertLegacyUserData({ installation, target, verifyPrograms, signal, progress = () => {}, inspectEnvironment = inspectLegacyPythonEnvironment }) {
  const root = realpathSync(fileURLToPath(new URL('../../', import.meta.url)))
  if (root !== target?.root || typeof verifyPrograms !== 'function') fail()
  const runtime = product.loadProductRuntime(root, { required: true, full: true })
  if (realpathSync(process.execPath) !== realpathSync(runtime.executables.node)) fail()
  const dataDir = installation.dataRoot
  const rootLock = await acquireExistingCliLock(installation.installRoot, 'legacy-desktop-takeover')
  let dataLock
  try {
    let entry
    try { await fs.lstat(path.join(installation.installRoot, '.desktop-takeover')); entry = await inspectLegacyEntryFence(installation.installRoot) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    await verifyPrograms({ entryFenceId: entry?.id, signal })
    dataLock = await acquireExistingCliLock(dataDir, 'legacy-desktop-takeover')
    let record = readVersionMaintenance(dataDir)
    const matching = value => matches(value, installation, target, entry?.id)
    if (record && !matching(record)) fail()
    signal?.throwIfAborted()
    if (!entry) entry = await fenceLegacyEntries(installation)
    else if (!record && entry.phase === 'fencing') entry = await resumeLegacyEntryFence(installation.installRoot, entry.id)
    if (!record && entry.phase !== 'fenced') fail()
    // Sends at most one shutdown mutation; unknown processes are never killed.
    if (entry.phase === 'fenced' && (!record || ['preparing', 'prepared'].includes(record.phase))) {
      progress('stopping')
      await stopFencedLegacyInstance(installation, { entryFenceId: entry.id, signal })
    }
    if (!record) record = await beginLegacyUserVersionMaintenance({ dataDir, installation, entryFenceId: entry.id, targetRoot: root, dataProtection: 'scoped' })
    if (!matching(record)) fail()
    if (record.phase === 'preparing') record = await prepareScopedVersionMaintenance(dataDir, record.id)
    if (record.phase === 'prepared') {
      signal?.throwIfAborted(); progress('preparing_environment')
      let preparedEnvironment = record.legacy_python?.reference
      if (!record.legacy_python) {
        const observed = await inspectEnvironment({ root, dataDir })
        if (observed.status !== 'absent') preparedEnvironment = await prepareLegacyPythonRebuild({ root, dataDir, expectedFingerprint: observed.fingerprint, signal })
      }
      record = await bindLegacyPythonMaintenance({ dataDir, id: record.id, prepared: preparedEnvironment, inspectEnvironment })
      signal?.throwIfAborted(); progress('switching')
      await markVersionMaintenanceInstalling(dataDir, record.id)
      record = readVersionMaintenance(dataDir)
    }
    if (!matching(record) || !record.legacy_python) fail()
    if (record.phase === 'installing') {
      // After the durable verifying phase a retry checks evidence, never replays.
      signal?.throwIfAborted()
      await selectLegacyPythonMaintenance({ dataDir, id: record.id, inspectEnvironment })
      progress('converting')
      await migrateStoppedVersionMaintenance({ dataDir, root, id: record.id,
        migrate: () => applyStartupMigrations(root, dataDir, product.productEnvironment(runtime, dataDir, { ...process.env, DATA_DIR: dataDir, CRABOT_HOME: root, CRABOT_PRODUCT_REQUIRED: '1' })),
        verifyComplete: async () => { if (verifyDataCompatibility(root, dataDir).length) fail() } })
    } else if (record.phase !== 'verifying') fail()
    if (inspectInstance(dataDir).state !== 'stopped' || (await discoverSealedLegacyRuntime(installation, { entryFenceId: entry.id })).state !== 'stopped') fail()
    await assertNoInterruptedMigrations(dataDir)
    if (verifyDataCompatibility(root, dataDir).length) fail()
    await verifyPrograms({ entryFenceId: entry.id })
    const current = readVersionMaintenance(dataDir)
    if (!matching(current) || current.id !== record.id || current.phase !== 'verifying') fail()
    return { maintenance_id: current.id, dataDir, verification_pending: true, health_verified: false }
  } finally { if (dataLock) releaseCliLock(dataLock); releaseCliLock(rootLock) }
}