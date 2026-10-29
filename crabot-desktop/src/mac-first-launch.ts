import path from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import type { dialog as ElectronDialog } from 'electron'

// Native first-use presentation; program bytes remain in the App, never copied to data.
export async function prepareMacAppData(options: {
  appPath: string; coreRoot: string; home: string; dialog: Pick<typeof ElectronDialog, 'showMessageBox' | 'showOpenDialog'>;
  load: (name: string) => Promise<any>; version: string
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
  if (previous) {
    selected = management.requireExistingDataRoot(previous.data_dir)
    if (previous.app_path === realpathSync(appPath)) return selected
    if (previous.app_path !== realpathSync(appPath) && existsSync(previous.app_path)) {
      const answer = await dialog.showMessageBox({ type: 'question', title: '使用已有数据', message: '用当前 Crabot 打开已有数据？',
        detail: `数据：${selected}\n另一份App仍在：${previous.app_path}\n两份App共用同一个正式实例。开发环境不受影响。`, buttons: ['使用已有数据', '取消'], defaultId: 0, cancelId: 1 })
      if (answer.response !== 0) return null
    }
  } else {
    const defaultData = path.join(home, 'Library/Application Support/Crabot/data')
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
