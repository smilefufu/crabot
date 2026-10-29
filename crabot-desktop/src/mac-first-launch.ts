import path from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import type { dialog as ElectronDialog } from 'electron'

// Native first-use presentation; program bytes remain in the App, never copied to data.
export async function prepareMacAppData(options: {
  appPath: string; coreRoot: string; home: string; dialog: Pick<typeof ElectronDialog, 'showMessageBox' | 'showOpenDialog'>;
  load: (name: string) => Promise<any>; version: string;
  discoverLegacy?: (root: string) => Promise<{ installation: { installRoot: string; dataRoot: string; version: string } } | null>;
  adoptLegacy?: (sourceRoot: string, dataDir: string) => Promise<void>
}): Promise<string | null> {
  const { appPath, coreRoot, home, dialog, load, version } = options
  const binding = (await load('mac-app-binding.cjs')).default
  const management = (await load('desktop-management.cjs')).default
  const identity = (await load('process-identity.cjs')).default
  if (!identity.inspectInstallFilesystem(appPath).supported) {
    await dialog.showMessageBox({ type: 'info', title: '先复制 Crabot', message: '请将 Crabot 拖到 Applications 或其他本机应用目录后打开。',
      detail: '当前App位于只读镜像或不支持的位置。尚未初始化业务数据。', buttons: ['知道了'] })
    return null
  }
  const { verifyCoreRelease } = await load('core-release.mjs')
  await verifyCoreRelease(coreRoot, { version })
  const previous = binding.readMacAppBinding({ home })
  let selected: string
  let legacy: { installation: { installRoot: string; dataRoot: string; version: string } } | null = null
  if (options.discoverLegacy && (!previous || !existsSync(path.join(previous.data_dir, 'desktop-managed.json')))) {
    let sourceRoot = previous ? path.dirname(previous.data_dir) : path.join(home, '.crabot')
    while (true) {
      try { legacy = await options.discoverLegacy(sourceRoot); break }
      catch (error) {
        if (previous) throw error // A bound pending admission cannot turn into an empty independent instance.
        const answer = await dialog.showMessageBox({ type: 'info', title: '核对已有数据', message: '发现已有数据，尚未确认原程序位置。',
          detail: `已检查：${sourceRoot}\n${error instanceof Error ? error.message : '原目录保留。'}\n可以选择包含程序入口的原文件夹，或明确使用独立数据位置；不会自动覆盖旧数据。`,
          buttons: ['使用独立数据位置', '选择原安装位置…', '取消'], defaultId: 1, cancelId: 2 })
        if (answer.response === 2) return null
        if (answer.response === 0) break
        const chosen = await dialog.showOpenDialog({ title: '选择原 Crabot 安装文件夹', defaultPath: sourceRoot,
          properties: ['openDirectory', 'showHiddenFiles'] })
        if (chosen.canceled || chosen.filePaths.length !== 1) return null
        sourceRoot = chosen.filePaths[0]
      }
    }
  }
  if (previous) {
    selected = management.requireExistingDataRoot(previous.data_dir)
    if (previous.app_path === realpathSync(appPath) && !legacy) return selected
    if (previous.app_path !== realpathSync(appPath) && existsSync(previous.app_path)) {
      const answer = await dialog.showMessageBox({ type: 'question', title: '使用已有数据', message: '用当前 Crabot 打开已有数据？',
        detail: `数据：${selected}\n另一份App仍在：${previous.app_path}\n两份App共用同一个正式实例。开发环境不受影响。`, buttons: ['使用已有数据', '取消'], defaultId: 0, cancelId: 1 })
      if (answer.response !== 0) return null
    }
  } else {
    if (legacy) {
      const answer = await dialog.showMessageBox({ type: 'question', title: '接入已有 Crabot', message: '沿用已有聊天、项目和设置？',
        detail: `原版本：${legacy.installation.version}\n数据：${legacy.installation.dataRoot}\n接入会正常停止旧服务，只保护需转换的数据；原目录和工作内容保留。`,
        buttons: ['接入已有数据', '使用独立数据位置', '取消'], defaultId: 0, cancelId: 2 })
      if (answer.response === 2) return null
      if (answer.response === 1) legacy = null
    }
    const defaultData = path.join(home, 'Library/Application Support/Crabot/data')
    if (legacy) selected = management.requireExistingDataRoot(legacy.installation.dataRoot)
    else {
      const answer = await dialog.showMessageBox({ type: 'info', title: '开始使用 Crabot', message: '选择数据存储位置',
        detail: `默认位置：${defaultData}\n运行环境已包含在App中。聊天、工作依赖和缓存保存在数据目录；项目workspace可在使用后调整。已有源码部署会保留。`,
        buttons: ['使用默认位置', '选择其他位置…', '取消'], defaultId: 0, cancelId: 2 })
      if (answer.response === 2) return null
      selected = defaultData
      if (answer.response === 1) {
        const chosen = await dialog.showOpenDialog({ title: '选择 Crabot 数据目录', defaultPath: defaultData,
          buttonLabel: '使用这个目录', properties: ['openDirectory', 'showHiddenFiles', 'createDirectory', 'promptToCreate'] })
        if (chosen.canceled || chosen.filePaths.length !== 1) return null
        selected = chosen.filePaths[0]
      }
      const relative = path.relative(realpathSync(appPath), path.resolve(selected))
      if (!relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) throw new Error('请选择App外的数据目录。')
      selected = existsSync(selected) ? management.requireExistingDataRoot(selected) : management.ensurePrivateDataRoot(selected)
    }
  }
  if (legacy) {
    if (!options.adoptLegacy) throw new Error('已有数据接入入口未准备完成。')
    binding.writeMacAppBinding({ appPath, dataDir: selected, home })
    await options.adoptLegacy(legacy.installation.installRoot, selected)
    return selected
  }
  const { acquireExistingCliLock, releaseCliLock } = await load('cli-lock.mjs')
  const { inspectInstance } = await load('instance-runtime.mjs')
  const lock = await acquireExistingCliLock(selected, 'mac-first-launch')
  try {
    const current = inspectInstance(selected)
    if (current.state === 'legacy' || current.record && current.record.install_root !== realpathSync(coreRoot)) throw Object.assign(new Error('所选数据仍属于另一部署，请先用原命令停止并选择独立数据位置。'), { code: 'CRABOT_DESKTOP_TAKEOVER_REQUIRED' })
    management.initializeDesktopManagement(selected)
    binding.writeMacAppBinding({ appPath, dataDir: selected, home })
  } finally { releaseCliLock(lock) }
  return selected
}
