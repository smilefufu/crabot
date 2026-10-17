// Fresh/repeated installation of a standalone bundled CLI. Version upgrades and
// legacy takeover are separate transactions; this entry never migrates data or
// starts a service. The native OS installers own PATH/command registration.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { prepareCliPayload, selectCliPayload, readCliSelection } from './cli-installation.mjs'
import { inspectInstance, readInstanceRuntime } from './instance-runtime.mjs'
import { acquireCliLock, releaseCliLock } from './cli-lock.mjs'
import management from './desktop-management.cjs'
import { detectMode } from './mode.mjs'
import { assertVersionMaintenanceAllowsStart } from './version-maintenance.mjs'

const fail = message => { throw Object.assign(new Error(message), { code: 'CRABOT_CLI_INSTALLATION' }) }
async function present(file) { try { return await fs.lstat(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
async function checkData(dataDir, installRoot, selected) {
  if (!await present(dataDir)) return
  if (management.readDesktopManagement(dataDir)) fail('此实例由桌面管理，请从桌面安装 crabot 命令；不会复制另一套运行环境。')
  const instance = inspectInstance(dataDir)
  if (instance.state !== 'stopped') fail('实例尚未停止，请先使用已有 crabot stop，再重新安装。')
  const records = await fs.readdir(path.join(dataDir, 'module-runtime-registry/records')).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  if (records.some(name => name.endsWith('.json'))) fail('仍有未收口模块记录，无法确认停止；未切换代码。')
  const record = readInstanceRuntime(dataDir)
  const ownData = selected && record?.install_root === path.join(installRoot, 'releases', selected)
  const entries = await fs.readdir(dataDir)
  if (!ownData && entries.some(name => !['cli.lock', '.DS_Store'].includes(name))) fail('发现尚未归属于此 CLI 安装的数据，需要先完成旧安装迁移。原数据已保留。')
  // Old wx locks cannot be adopted by merely opening the new OS lock's inode.
  const file = path.join(dataDir, 'cli.lock')
  if (await present(file)) {
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.size > 4096) fail('已有操作锁无法识别，未接管。')
    let lock
    try { lock = JSON.parse(await fs.readFile(file, 'utf8')) } catch {}
    if (!lock?.owner || typeof lock.token !== 'string') fail('发现旧版操作锁，请保留旧安装并先完成迁移。')
  }
}

export async function installStandaloneCli({ sourceRoot, installRoot, dataDir, scope = 'user' }) {
  installRoot = path.resolve(installRoot)
  if (scope === 'user' && detectMode() === 'system') fail('此机器使用 system 安装，请通过现有命令或联系系统管理员管理。')
  for (const file of ['cli.mjs', '.git', 'core-release.json']) if (await present(path.join(installRoot, file))) fail('发现已有代码安装，请使用已有升级或显式接管流程，未覆盖原入口。')
  let selected = null
  if (await present(path.join(installRoot, 'cli-installation.json'))) selected = readCliSelection(installRoot)
  if (selected) {
    const source = JSON.parse(await fs.readFile(path.join(sourceRoot, 'core-release.json'), 'utf8'))
    if (source.inventory_sha256 !== selected) fail('发现另一版本，请使用 crabot upgrade 更新，安装器未切换当前版本。')
  }
  if (scope === 'user') {
    if (!dataDir) fail('缺少实例数据目录，未开始安装。')
    dataDir = path.resolve(dataDir)
    await checkData(dataDir, await fs.realpath(installRoot).catch(error => { if (error.code === 'ENOENT') return installRoot; throw error }), selected)
  }
  const prepared = await prepareCliPayload({ sourceRoot, installRoot, scope })
  let lock
  try {
    if (scope === 'user') {
      await checkData(dataDir, prepared.installRoot, selected)
      dataDir = management.ensurePrivateDataRoot(dataDir)
      lock = await acquireCliLock(dataDir, 'install-standalone-cli')
      assertVersionMaintenanceAllowsStart(dataDir)
      await checkData(dataDir, prepared.installRoot, selected)
    }
    await selectCliPayload(prepared, { dataDir, expected: selected })
    return prepared
  } finally { if (lock) releaseCliLock(lock) }
}
