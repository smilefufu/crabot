// Runs only inside the already authenticated employee UID helper. No service is
// started here: the root coordinator owns selection and the original run set.
import path from 'node:path'
import { acquireCliLock, releaseCliLock } from './cli-lock.mjs'
import { verifyCoreRelease } from './core-release.mjs'
import cliLocation from './cli-location.cjs'
import { assertLocalMigrationData, createMaintenanceBackup, verifyMaintenanceBackup } from './maintenance-backup.mjs'
import { verifyDataCompatibility, applyStartupMigrations } from './core-preparation.mjs'
import { beginVersionMaintenance, bindVersionMaintenanceTarget, recordVersionMaintenanceBackup,
  markVersionMaintenanceInstalling, completeStoppedVersionMaintenance, cancelPreparedVersionMaintenance,
  readVersionMaintenance } from './version-maintenance.mjs'
import { inspectSystemUser } from './system-control.mjs'
import { systemError } from './system-registry.mjs'

export async function maintainSystemUser(entry, { action, deployment, operationId, snapshot, env, outputFd,
  observe = inspectSystemUser }) {
  const { install_root: installRoot, source, target } = deployment
  const sourceRoot = path.join(installRoot, 'releases', source.id), targetRoot = path.join(installRoot, 'releases', target.id)
  const lock = await acquireCliLock(entry.data_dir, 'system-data-' + action)
  try {
    const selected = cliLocation.readCliSelection(installRoot)
    const expected = ['migrate', 'check-migration'].includes(action) ? target.id : source.id
    if (selected !== expected || (await observe(entry)).state !== 'stopped') throw systemError('核心选择或本人停止状态发生变化，未修改数据。', 'CRABOT_SYSTEM_INSTANCE_CHANGED')
    for (const [root, release] of [[sourceRoot, source], [targetRoot, target]]) {
      const installation = cliLocation.locateCliInstallation(root)
      if (!installation || installation.scope !== 'system' || installation.root !== installRoot || installation.id !== release.id
        || (await verifyCoreRelease(root, { version: release.version })).inventory_sha256 !== release.id) throw systemError('共享维护核心无法核验。')
    }
    let record = readVersionMaintenance(entry.data_dir)
    if (action === 'check-migration') {
      if (record || snapshot?.system_operation_id !== operationId || !/^[a-f0-9-]{36}$/.test(snapshot.backup?.id ?? '')
        || !/^[a-f0-9]{64}$/.test(snapshot.backup?.sha256 ?? '')) throw systemError('本人数据维护未完成或备份回执不兼容。', 'CRABOT_MAINTENANCE_PENDING')
      const backup = await verifyMaintenanceBackup(path.join(entry.data_dir + '.desktop-backups', snapshot.backup.id), snapshot.backup.sha256)
      if (backup.source !== entry.data_dir || verifyDataCompatibility(targetRoot, entry.data_dir).length) throw systemError('本人数据尚未与目标核心对齐。', 'CRABOT_MIGRATION_FAILED')
      return { verified: true, service_started: false }
    }
    if (action === 'snapshot') {
      if (record) throw systemError('本人已有数据维护未完成，未创建另一份维护。', 'CRABOT_MAINTENANCE_PENDING')
      await assertLocalMigrationData(entry.data_dir, verifyDataCompatibility(targetRoot, entry.data_dir))
      record = await beginVersionMaintenance(entry.data_dir, sourceRoot, target.version, source.version, { systemOperationId: operationId })
      const backup = await createMaintenanceBackup(entry.data_dir)
      await recordVersionMaintenanceBackup(entry.data_dir, record.id, backup)
      await bindVersionMaintenanceTarget(entry.data_dir, record.id, targetRoot)
      return { id: record.id, system_operation_id: operationId, backup: { id: backup.id, sha256: backup.sha256 }, target_id: target.id }
    }
    if (action === 'cancel-preparation' && !record) return { preparation_cancelled: false, service_started: false }
    if (!record || record.system_operation_id !== operationId || record.install_root !== sourceRoot
      || record.source_inventory_sha256 !== source.id || record.target_version !== target.version) throw systemError('本人维护不属于此次共享更新，未继续。')
    if (action === 'cancel-preparation') return cancelPreparedVersionMaintenance({ dataDir: entry.data_dir, root: sourceRoot,
      id: record.id, systemOperationId: operationId, verifyCompatible: () => verifyDataCompatibility(sourceRoot, entry.data_dir) })
    if (action !== 'migrate' || record.phase !== 'backed_up' || record.id !== snapshot?.id || snapshot.system_operation_id !== operationId
      || record.target_core?.root !== targetRoot || record.target_core.inventory_sha256 !== target.id
      || record.backup?.id !== snapshot.backup?.id || record.backup.sha256 !== snapshot.backup?.sha256) throw systemError('迁移派发或备份状态无法核验，未重放。', 'CRABOT_SYSTEM_OPERATION_INTERRUPTED')
    await markVersionMaintenanceInstalling(entry.data_dir, record.id)
    await completeStoppedVersionMaintenance({ dataDir: entry.data_dir, root: targetRoot, id: record.id,
      migrate: () => applyStartupMigrations(targetRoot, entry.data_dir, env, undefined, { outputFd }), verifyComplete: () => {
        if (verifyDataCompatibility(targetRoot, entry.data_dir).length) throw systemError('本人数据迁移尚未完成。', 'CRABOT_MIGRATION_FAILED')
      } })
    return { migrated: true, service_started: false }
  } finally { releaseCliLock(lock) }
}
