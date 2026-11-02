import path from 'node:path'
import { existsSync, realpathSync, promises as fs } from 'node:fs'
import type { dialog as ElectronDialog } from 'electron'

// DEB owns program files; this adapter chooses and prepares only per-user data.
export async function prepareUbuntuAppData(options: {
  coreRoot: string; home: string; env?: NodeJS.ProcessEnv; version: string;
  dialog: Pick<typeof ElectronDialog, 'showMessageBox' | 'showOpenDialog'>;
  load: (name: string) => Promise<any>; signal?: AbortSignal;
  onDataSelected: (dataDir: string) => Promise<void>;
  progress?: (message: string, cancellable: boolean) => void;
}): Promise<string | null> {
  const { coreRoot, home, dialog, load } = options, env = options.env ?? process.env
  const binding = (await load('ubuntu-app-binding.cjs')).default
  const management = (await load('desktop-management.cjs')).default
  const { readInstalledCoreRelease } = await load('core-release.mjs')
  await readInstalledCoreRelease(coreRoot, { version: options.version })
  const previous = binding.readUbuntuAppBinding({ home, env })
  let dataDir: string
  if (previous) dataDir = binding.requireUbuntuAppBinding({ coreRoot, home, env }).data_dir
  else {
    const proposed = binding.defaultDataDir({ home, env })
    const answer = await dialog.showMessageBox({ type: 'info', title: '开始使用 Crabot', message: '选择数据存储位置',
      detail: `默认位置：${proposed}\n程序和内置环境已由系统安装。聊天、用户依赖和缓存放在数据目录，已有CLI/开发部署不会自动接管。`,
      buttons: ['使用默认位置', '选择其他位置…', '取消'], defaultId: 0, cancelId: 2 })
    if (answer.response === 2) return null
    dataDir = proposed
    if (answer.response === 1) {
      const chosen = await dialog.showOpenDialog({ title: '选择 Crabot 数据目录', defaultPath: proposed,
        buttonLabel: '使用这个目录', properties: ['openDirectory', 'showHiddenFiles', 'createDirectory', 'promptToCreate'] })
      if (chosen.canceled || chosen.filePaths.length !== 1) return null
      dataDir = chosen.filePaths[0]
    }
    const program = binding.ubuntuAppForCore(coreRoot), relative = path.relative(program, path.resolve(dataDir))
    if (!relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) throw new Error('请选择系统程序目录之外的数据位置。')
    dataDir = existsSync(dataDir) ? management.requireExistingDataRoot(dataDir) : management.ensurePrivateDataRoot(dataDir)
  }
  await options.onDataSelected(dataDir)
  if (previous && management.readDesktopManagement(dataDir)) return dataDir
  const { discoverDesktopDataSource, importDesktopData } = await load('desktop-data-import.mjs')
  const { discoverUserSourceDeployment } = await load('source-installation.mjs')
  const sourceRoot = previous?.source_root ?? path.join(home, '.crabot')
  const source = !previous?.source_root && discoverUserSourceDeployment({ home, source: env }) ? null : await discoverDesktopDataSource({ root: sourceRoot })
  let importing = !!previous?.source_root
  if (source && !previous) {
    const answer = await dialog.showMessageBox({ type: 'question', title: '接入已有 Crabot', message: '沿用已有聊天、项目和设置？',
      detail: `原版本：${source.version}\n来源：${source.dataRoot}\n目标：${dataDir}\n会正常停止原服务、复制data并只做必要转换，原目录和外部workspace保留。`,
      buttons: ['接入已有数据', '使用独立数据', '取消'], defaultId: 0, cancelId: 2 })
    if (answer.response === 2) return null
    importing = answer.response === 0
  }
  if (importing) {
    if (!source) throw new Error('上次接入的来源目录不可用；原数据和已复制内容保留，请恢复来源后重试。')
    let restartCopy = false
    if (previous && (await fs.readdir(dataDir)).some(name => !['cli.lock', 'desktop-profile'].includes(name))) {
      const answer = await dialog.showMessageBox({ type: 'warning', title: '重新导入数据', message: '重新建立上次尚未启用的数据副本？',
        detail: `只处理：${dataDir}\n原数据保留：${source.dataRoot}\n已有未知迁移状态时不会重新复制。`, buttons: ['重新导入', '取消'], cancelId: 1 })
      if (answer.response !== 0) return null
      restartCopy = true
    }
    const overlaps = (a: string, b: string) => { const relative = path.relative(a, b); return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
    if (overlaps(source.dataRoot, dataDir) || overlaps(dataDir, source.dataRoot)) throw new Error('来源和目标数据目录不能重叠，未修改原绑定。')
    binding.writeUbuntuAppBinding({ coreRoot, dataDir, sourceRoot, home, env })
    await importDesktopData({ source, root: coreRoot, target: dataDir, restartCopy, signal: options.signal,
      progress: (value: { phase: string; files?: number; bytes?: number; message?: string }) => {
        const amount = value.files === undefined ? '' : `，${value.files} 个文件，${((value.bytes ?? 0) / 1024 / 1024).toFixed(1)} MB`
        options.progress?.(`${value.phase}${amount}${value.message ? '：' + value.message : ''}`, value.phase !== '迁移数据')
      } })
    return dataDir
  }
  const { acquireExistingCliLock, releaseCliLock } = await load('cli-lock.mjs')
  const { inspectInstance } = await load('instance-runtime.mjs')
  const lock = await acquireExistingCliLock(dataDir, 'ubuntu-first-launch')
  try {
    const current = inspectInstance(dataDir)
    if (current.state === 'legacy' || current.record && current.record.install_root !== realpathSync(coreRoot)) {
      throw Object.assign(new Error('所选数据属于另一部署，请先核对并确认导入，未启动另一实例。'), { code: 'CRABOT_DESKTOP_TAKEOVER_REQUIRED' })
    }
    management.initializeDesktopManagement(dataDir)
    binding.writeUbuntuAppBinding({ coreRoot, dataDir, home, env })
  } finally { releaseCliLock(lock) }
  return dataDir
}
