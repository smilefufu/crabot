// Offline user-CLI switch. A target-bundled Node coordinator owns the lifecycle
// lock and migrations; downloading/preparing payloads is a separate read/copy step.
import { promises as fs, realpathSync } from 'node:fs'
import path from 'node:path'
import { locateCliInstallation, selectCliPayload, readCliSelection } from './cli-installation.mjs'
import { readStandaloneCliBinding } from './standalone-cli-install.mjs'
import { acquireCliLock, releaseCliLock } from './cli-lock.mjs'
import { inspectInstance } from './instance-runtime.mjs'
import { verifyCoreRelease } from './core-release.mjs'
import { createMaintenanceBackup, assertLocalMigrationData } from './maintenance-backup.mjs'
import { beginVersionMaintenance, bindVersionMaintenanceTarget, recordVersionMaintenanceBackup,
  markVersionMaintenanceInstalling, completeStoppedCliVersionMaintenance } from './version-maintenance.mjs'
import { applyStartupMigrations, verifyDataCompatibility } from './core-preparation.mjs'
import management from './desktop-management.cjs'

const fail = message => { throw Object.assign(new Error(message), { code: 'CRABOT_CLI_UPGRADE' }) }
export async function applyStoppedCliUpgrade({ sourceRoot, targetRoot, dataDir, env = process.env, log = () => {} }) {
  sourceRoot = realpathSync(sourceRoot); targetRoot = realpathSync(targetRoot); dataDir = realpathSync(dataDir)
  const source = locateCliInstallation(sourceRoot), target = locateCliInstallation(targetRoot)
  if (!source || !target || source.scope !== 'user' || target.scope !== 'user' || source.root !== target.root
    || !source.selected || source.id === target.id) fail('只接受当前独立 user CLI 同一安装内已准备的新核心。')
  if (management.readDesktopManagement(dataDir) || !await readStandaloneCliBinding(dataDir, source.root)) fail('实例不属于此独立 CLI，请使用对应的桌面或迁移入口。')
  management.ensurePrivateDataRoot(dataDir)
  const lock = await acquireCliLock(dataDir, 'upgrade-standalone-cli')
  try {
    const stopped = async expected => {
      if (inspectInstance(dataDir).state !== 'stopped' || readCliSelection(source.root) !== expected) fail('实例或当前版本已改变，未继续升级。')
      if (!await readStandaloneCliBinding(dataDir, source.root)) fail('数据归属记录缺失。')
      const records = await fs.readdir(path.join(dataDir, 'module-runtime-registry/records')).catch(error => {
        if (error.code === 'ENOENT') return []; throw error
      })
      if (records.some(name => name.endsWith('.json'))) fail('模块尚未收口，未继续升级。')
    }
    await stopped(source.id)
    const migrations = verifyDataCompatibility(targetRoot, dataDir) // preflight every module before any data write
    await assertLocalMigrationData(dataDir, migrations, targetRoot)
    const next = await verifyCoreRelease(targetRoot)
    const record = await beginVersionMaintenance(dataDir, sourceRoot, next.version)
    const backup = await createMaintenanceBackup(dataDir)
    await recordVersionMaintenanceBackup(dataDir, record.id, backup)
    await bindVersionMaintenanceTarget(dataDir, record.id, targetRoot)
    await stopped(source.id)
    await markVersionMaintenanceInstalling(dataDir, record.id)
    await selectCliPayload({ installRoot: source.root, coreRoot: targetRoot, id: target.id, version: next.version, scope: 'user' },
      { expected: source.id, dataDir })
    await completeStoppedCliVersionMaintenance({ dataDir, root: targetRoot, id: record.id,
      migrate: () => applyStartupMigrations(targetRoot, dataDir, { ...env, DATA_DIR: dataDir, CRABOT_HOME: targetRoot }, log),
      verifyComplete: async () => {
        await stopped(target.id)
        if (verifyDataCompatibility(targetRoot, dataDir).length) fail('迁移尚未完成，已保留维护记录及备份。')
      } })
    return { version: next.version, coreRoot: targetRoot, backup: backup.directory, service_started: false, health_verified: false }
  } finally { releaseCliLock(lock) }
}
