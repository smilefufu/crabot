// The service is already stopped and its UID owns the common lifecycle lock.
// A failed first-start migration retains the same durable fence used by updates.
import { verifyDataCompatibility, applyStartupMigrations } from './core-preparation.mjs'
import { verifyCoreRelease } from './core-release.mjs'
import { assertLocalMigrationData, createMaintenanceBackup } from './maintenance-backup.mjs'
import { beginVersionMaintenance, bindVersionMaintenanceTarget, recordVersionMaintenanceBackup,
  markVersionMaintenanceInstalling, completeStoppedVersionMaintenance } from './version-maintenance.mjs'

export async function prepareSystemStartupData({ root, dataDir, env }) {
  const migrations = verifyDataCompatibility(root, dataDir)
  if (!migrations.length) {
    await applyStartupMigrations(root, dataDir, env)
    return
  }
  await assertLocalMigrationData(dataDir, migrations, root)
  const release = await verifyCoreRelease(root)
  const record = await beginVersionMaintenance(dataDir, root, release.version)
  const backup = await createMaintenanceBackup(dataDir)
  await recordVersionMaintenanceBackup(dataDir, record.id, backup)
  await bindVersionMaintenanceTarget(dataDir, record.id, root)
  await markVersionMaintenanceInstalling(dataDir, record.id)
  await completeStoppedVersionMaintenance({ dataDir, root, id: record.id,
    migrate: () => applyStartupMigrations(root, dataDir, env), verifyComplete: () => {
      if (verifyDataCompatibility(root, dataDir).length) throw new Error('数据迁移尚未完成，维护记录和备份已保留。')
    } })
}
