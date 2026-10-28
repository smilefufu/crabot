// Runs only inside the already authenticated employee UID helper. No service is
// started here: the root coordinator owns selection and the original run set.
import path from 'node:path'
import { acquireCliLock, releaseCliLock } from './cli-lock.mjs'
import { verifyCoreRelease } from './core-release.mjs'
import cliLocation from './cli-location.cjs'
import { assertLocalMigrationData, inspectLocalMigrationData, verifyMaintenanceBackup } from './maintenance-backup.mjs'
import { verifyDataCompatibility, applyStartupMigrations } from './core-preparation.mjs'
import { beginVersionMaintenance, bindVersionMaintenanceTarget, prepareScopedVersionMaintenance,
  markVersionMaintenanceInstalling, completeStoppedVersionMaintenance, cancelPreparedVersionMaintenance,
  readVersionMaintenance } from './version-maintenance.mjs'
import { inspectSystemUser } from './system-control.mjs'
import { systemError } from './system-registry.mjs'
import management from './desktop-management.cjs'
import { describeScopedPreparation } from '../upgrade-lib/scoped-preparation.mjs'
import { runScript } from '../upgrade-lib/runner.mjs'
import { prepareSystemScopedRecovery, verifySystemScopedRecovery, cancelSystemScopedRecovery, findSystemScopedCancellation,
  executeSystemScopedMigrations, verifyCompletedSystemScopedRecovery } from './system-scoped-recovery.mjs'

export async function maintainSystemUser(entry, { action, deployment, operationId, snapshot, env, outputFd,
  observe = inspectSystemUser }) {
  const { install_root: installRoot, source, target } = deployment
  const sourceRoot = path.join(installRoot, 'releases', source.id), targetRoot = path.join(installRoot, 'releases', target.id)
  const dataDir = management.requirePrivateDataRoot(entry.data_dir)
  const lock = await acquireCliLock(dataDir, 'system-data-' + action)
  try {
    const selected = cliLocation.readCliSelection(installRoot)
    const expected = ['migrate', 'check-migration'].includes(action) ? target.id : source.id
    const state = (await observe(entry)).state
    if (selected !== expected || (action === 'preflight-data' ? !['running', 'stopped'].includes(state) : state !== 'stopped')) throw systemError('核心选择或本人运行状态发生变化，未修改数据。', 'CRABOT_SYSTEM_INSTANCE_CHANGED')
    for (const [root, release] of [[sourceRoot, source], [targetRoot, target]]) {
      const installation = cliLocation.locateCliInstallation(root)
      if (!installation || installation.scope !== 'system' || installation.root !== installRoot || installation.id !== release.id
        || (await verifyCoreRelease(root, { version: release.version })).inventory_sha256 !== release.id) throw systemError('共享维护核心无法核验。')
    }
    let record = readVersionMaintenance(dataDir)
    const scopedOptions = id => ({ dataDir, sourceRoot, targetRoot, operationId, maintenanceId: id,
      sourceInventory: source.id, targetInventory: target.id, receipt: snapshot?.backup })
    // New references use the maintenance UUID; old broad backups have their own id.
    const scopedSnapshot = Boolean(snapshot && snapshot.id === snapshot.backup?.id)
    if (action === 'preflight-data') {
      if (record) throw systemError('本人已有数据维护未完成，未开始另一份准备。', 'CRABOT_MAINTENANCE_PENDING')
      const description = await describeScopedPreparation(targetRoot, dataDir)
      await inspectLocalMigrationData(dataDir, verifyDataCompatibility(targetRoot, dataDir), targetRoot)
      return { preflighted: true, backup_bytes: description.backup_bytes }
    }
    if (action === 'check-migration') {
      if (record || snapshot?.system_operation_id !== operationId || snapshot.target_id !== target.id || !/^[a-f0-9-]{36}$/.test(snapshot.backup?.id ?? '')
        || !/^[a-f0-9]{64}$/.test(snapshot.backup?.sha256 ?? '')) throw systemError('本人数据维护未完成或备份回执不兼容。', 'CRABOT_MAINTENANCE_PENDING')
      if (verifyDataCompatibility(targetRoot, dataDir).length) throw systemError('本人数据尚未与目标核心对齐。', 'CRABOT_MIGRATION_FAILED')
      if (scopedSnapshot) return await verifyCompletedSystemScopedRecovery(scopedOptions(snapshot.id))
      const backup = await verifyMaintenanceBackup(path.join(dataDir + '.desktop-backups', snapshot.backup.id), snapshot.backup.sha256)
      if (backup.source !== dataDir) throw systemError('本人数据尚未与目标核心对齐。', 'CRABOT_MIGRATION_FAILED')
      return { verified: true, service_started: false }
    }
    if (action === 'snapshot') {
      if (record) throw systemError('本人已有数据维护未完成，未创建另一份维护。', 'CRABOT_MAINTENANCE_PENDING')
      await describeScopedPreparation(targetRoot, dataDir)
      await assertLocalMigrationData(dataDir, verifyDataCompatibility(targetRoot, dataDir), targetRoot)
      record = await beginVersionMaintenance(dataDir, sourceRoot, target.version, source.version, { systemOperationId: operationId, dataProtection: 'scoped' })
      await bindVersionMaintenanceTarget(dataDir, record.id, targetRoot)
      const backup = await prepareSystemScopedRecovery(scopedOptions(record.id))
      await prepareScopedVersionMaintenance(dataDir, record.id)
      return { id: record.id, system_operation_id: operationId, backup, target_id: target.id }
    }
    if (action === 'cancel-preparation' && !record) {
      const id = await findSystemScopedCancellation({ dataDir, operationId })
      return id ? await cancelSystemScopedRecovery(scopedOptions(id)) : { preparation_cancelled: false, service_started: false }
    }
    if (!record || record.system_operation_id !== operationId || record.install_root !== sourceRoot
      || record.source_inventory_sha256 !== source.id || record.target_version !== target.version) throw systemError('本人维护不属于此次共享更新，未继续。')
    if (record.schema_version === 3) {
      if (action === 'cancel-preparation') return await cancelSystemScopedRecovery(scopedOptions(record.id))
      if (!['migrate', 'verify-snapshot'].includes(action) || record.phase !== 'prepared' || record.id !== snapshot?.id
        || snapshot.system_operation_id !== operationId || snapshot.target_id !== target.id || !scopedSnapshot
        || record.target_core?.root !== targetRoot || record.target_core.inventory_sha256 !== target.id) throw systemError('范围迁移派发或材料状态无法核验，未重放。', 'CRABOT_SYSTEM_OPERATION_INTERRUPTED')
      await verifySystemScopedRecovery(scopedOptions(record.id))
      if (action === 'verify-snapshot') return { verified: true, service_started: false }
      await markVersionMaintenanceInstalling(dataDir, record.id)
      await completeStoppedVersionMaintenance({ dataDir, root: targetRoot, id: record.id,
        migrate: () => executeSystemScopedMigrations(scopedOptions(record.id), (script, directory, context) =>
          runScript(script, directory, { ...context, root: targetRoot, env: { ...env, DATA_DIR: dataDir }, outputFd })),
        verifyComplete: async () => {
          if (verifyDataCompatibility(targetRoot, dataDir).length) throw systemError('本人数据迁移尚未完成。', 'CRABOT_MIGRATION_FAILED')
          await verifyCompletedSystemScopedRecovery(scopedOptions(record.id))
        } })
      return { migrated: true, service_started: false }
    }
    if (action === 'verify-snapshot') {
      if (record.phase !== 'backed_up' || record.id !== snapshot?.id || snapshot.system_operation_id !== operationId || snapshot.target_id !== target.id
        || record.backup?.id !== snapshot.backup?.id || record.backup.sha256 !== snapshot.backup.sha256
        || record.target_core?.root !== targetRoot || record.target_core.inventory_sha256 !== target.id) throw systemError('原维护材料无法核验。')
      await verifyMaintenanceBackup(path.join(dataDir + '.desktop-backups', record.backup.id), record.backup.sha256)
      return { verified: true, service_started: false }
    }
    if (action === 'cancel-preparation') return await cancelPreparedVersionMaintenance({ dataDir, root: sourceRoot,
      id: record.id, systemOperationId: operationId, verifyCompatible: () => verifyDataCompatibility(sourceRoot, dataDir) })
    if (action !== 'migrate' || record.phase !== 'backed_up' || record.id !== snapshot?.id || snapshot.system_operation_id !== operationId
      || record.target_core?.root !== targetRoot || record.target_core.inventory_sha256 !== target.id
      || record.backup?.id !== snapshot.backup?.id || record.backup.sha256 !== snapshot.backup?.sha256) throw systemError('迁移派发或备份状态无法核验，未重放。', 'CRABOT_SYSTEM_OPERATION_INTERRUPTED')
    await markVersionMaintenanceInstalling(dataDir, record.id)
    await completeStoppedVersionMaintenance({ dataDir, root: targetRoot, id: record.id,
      migrate: () => applyStartupMigrations(targetRoot, dataDir, { ...env, DATA_DIR: dataDir }, undefined, { outputFd }), verifyComplete: () => {
        if (verifyDataCompatibility(targetRoot, dataDir).length) throw systemError('本人数据迁移尚未完成。', 'CRABOT_MIGRATION_FAILED')
      } })
    return { migrated: true, service_started: false }
  } finally { releaseCliLock(lock) }
}
