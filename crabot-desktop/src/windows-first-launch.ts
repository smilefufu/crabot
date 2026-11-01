import path from 'node:path'
import { compareVersions } from './release-signatures.js'
import { existsSync, promises as fs } from 'node:fs'
import type { dialog as ElectronDialog } from 'electron'
import type { PreparedInstallation } from './installation-entries.js'

// Programs are already at their final location. This UI chooses existing data;
// the common target-Node role alone performs its stopped conversion.
export async function prepareWindowsFirstLaunch(options: {
  resources: string; pinText: string; home: string;
  progress?: (message: string, cancellable: boolean) => void; signal?: AbortSignal;
  dialog: Pick<typeof ElectronDialog, 'showMessageBox' | 'showOpenDialog'>;
  load: (name: string, verifiedCore?: string) => Promise<any>;
  registerEntries: (prepared: PreparedInstallation) => Promise<void>
  repairExisting?: (programs: any) => Promise<boolean>
  upgradeExisting?: (prepared: PreparedInstallation & { source: PreparedInstallation['selection']; proof: { file: string; sha256: string } }, source: any) => Promise<boolean>
}): Promise<any | null> {
  const { dialog } = options
  options.progress?.('正在准备 Crabot，核对程序与已有数据位置…', false)
  const first = await options.load('desktop-first-launch.mjs')
  const programs = await first.readFirstLaunchPrograms(options)
  if (programs.initialized) return programs
  // Only the protected first-use verifier can supply this completely checked Core.
  const load = (name: string) => options.load(name, programs.coreRoot)
  const desktop = (await load('desktop-installation.cjs')).default
  const management = (await load('desktop-management.cjs')).default
  const { discoverDesktopDataSource, importDesktopData, forwardImportedWindowsCommand } = await load('desktop-data-import.mjs')
  const { discoverUserSourceDeployment } = await load('source-installation.mjs')
  if (programs.removal) {
    if (!options.repairExisting || !await options.repairExisting(programs)) return null
    return desktop.locatePinnedDesktopGui(options.resources, options.pinText)
  }
  if (programs.source) {
    if (compareVersions(programs.selection.version, programs.source.selection.version) < 0) throw Object.assign(new Error('安装包比当前桌面版本旧，请使用同版或更新版；原程序和数据保留。'), { code: 'CRABOT_DESKTOP_RELEASE_VERSION' })
    const selected = await first.bindFirstLaunchData(programs, programs.source.dataDir)
    if (!options.upgradeExisting) throw new Error('已有桌面版本更新入口尚未就绪，原程序和数据保留。')
    if (!await options.upgradeExisting({ installRoot: programs.installRoot, installation_id: selected.record.installation_id,
      selection: programs.selection, source: programs.source.selection, coreRoot: programs.coreRoot, guiRoot: programs.guiRoot, proof: selected.proof }, programs.source)) return null
    return desktop.locatePinnedDesktopGui(options.resources, options.pinText)
  }
  const metadata = path.join(programs.installRoot, 'desktop-installation.json')
  const bound = existsSync(metadata) ? desktop.readDesktopInstallation(programs.installRoot) : null
  if (bound?.dataDir === path.join(programs.installRoot, 'data') && management.readDesktopManagement(bound.dataDir)) {
    const selected = await first.bindFirstLaunchData(programs, bound.dataDir)
    return first.completeImportedFirstLaunch(selected, options.registerEntries)
  }
  let root = bound && bound.dataDir !== path.join(programs.installRoot, 'data') ? path.dirname(bound.dataDir) : path.join(options.home, '.crabot'), legacy
  if (!bound && discoverUserSourceDeployment({ home: options.home })) legacy = null
  else while (true) {
    try { legacy = await discoverDesktopDataSource({ root }); break }
    catch (error) {
      if (bound) throw error
      const answer = await dialog.showMessageBox({ type: 'warning', title: '核对已有 Crabot', message: '尚未核实原安装位置。',
        detail: `${root}\n${error instanceof Error ? error.message : '原数据保留。'}`, buttons: ['选择原安装位置…', '取消'], cancelId: 1 })
      if (answer.response !== 0) return null
      const chosen = await dialog.showOpenDialog({ title: '选择原 Crabot 安装文件夹', defaultPath: root, properties: ['openDirectory', 'showHiddenFiles'] })
      if (chosen.canceled || chosen.filePaths.length !== 1) return null
      root = chosen.filePaths[0]
    }
  }
  if (legacy) {
    const answer = await dialog.showMessageBox({ type: 'question', title: '接入已有 Crabot', message: '沿用已有聊天、项目和设置？',
      detail: `原版本：${legacy.version}\n数据：${legacy.dataRoot}\n程序保留在：${programs.installRoot}\n将正常停止旧服务，把 data 复制到所选程序目录，再按需升级；原数据保留。`,
      buttons: ['接入已有数据', '取消'], defaultId: 0, cancelId: 1 })
    if (answer.response !== 0) return null
  }
  const dataDir = legacy ? management.ensurePrivateDataRoot(path.join(programs.installRoot, 'data'))
    : bound?.dataDir ?? management.ensurePrivateDataRoot(path.join(programs.installRoot, 'data'))
  let restartCopy = false
  if (legacy && bound?.dataDir === dataDir && (await fs.readdir(dataDir)).some(name => !['cli.lock', 'desktop-profile'].includes(name))) {
    const retry = await dialog.showMessageBox({ type: 'warning', title: '重新导入数据', message: '上次导入尚未完成，重新复制原数据？',
      detail: `只重新建立尚未启用的副本：${dataDir}\n来源保留：${legacy.dataRoot}`, buttons: ['重新导入', '取消'], cancelId: 1 })
    if (retry.response !== 0) return null
    restartCopy = true
  }
  const selected = await first.bindFirstLaunchData(programs, dataDir)
  if (!legacy) return first.completeFreshFirstLaunch(selected, options.registerEntries)
  await importDesktopData({ source: legacy, root: programs.coreRoot, target: dataDir, restartCopy, signal: options.signal,
    progress: (value: { phase: string; files?: number; bytes?: number; message?: string; elapsed_ms?: number }) => {
      const copied = value.files === undefined ? '' : `，${value.files} 个文件，${((value.bytes || 0) / 1024 / 1024).toFixed(1)} MB`
      options.progress?.(`${value.phase}${copied}${value.message ? '：' + value.message : ''}`, value.phase !== '迁移数据')
      console.info(JSON.stringify({ component: 'desktop-data-import', ...value }))
    } })
  const installed = await first.completeImportedFirstLaunch(selected, options.registerEntries)
  await forwardImportedWindowsCommand(legacy, programs.installRoot)
  return installed
}
