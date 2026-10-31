import path from 'node:path'
import { existsSync } from 'node:fs'
import type { dialog as ElectronDialog } from 'electron'
import type { PreparedInstallation } from './installation-entries.js'
import { createOperationProgressWindow } from './operation-progress-window.js'

// Programs are already at their final location. This UI chooses existing data;
// the common target-Node role alone performs its stopped conversion.
export async function prepareWindowsFirstLaunch(options: {
  resources: string; pinText: string; home: string;
  dialog: Pick<typeof ElectronDialog, 'showMessageBox' | 'showOpenDialog'>;
  load: (name: string) => Promise<any>;
  registerEntries: (prepared: PreparedInstallation) => Promise<void>
}): Promise<any | null> {
  const { dialog, load } = options
  const first = await load('desktop-first-launch.mjs')
  const programs = await first.readFirstLaunchPrograms(options)
  if (programs.initialized) return programs
  const desktop = (await load('desktop-installation.cjs')).default
  const management = (await load('desktop-management.cjs')).default
  const { discoverLegacyDesktopTakeover } = await load('legacy-desktop-discovery.mjs')
  const { discoverUserSourceDeployment } = await load('source-installation.mjs')
  const metadata = path.join(programs.installRoot, 'desktop-installation.json')
  const bound = existsSync(metadata) ? desktop.readDesktopInstallation(programs.installRoot) : null
  let root = bound ? path.dirname(bound.dataDir) : path.join(options.home, '.crabot'), legacy
  if (!bound && discoverUserSourceDeployment({ home: options.home })) legacy = null
  else while (true) {
    try { legacy = await discoverLegacyDesktopTakeover({ root, source: {} }); break }
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
  if (legacy && !bound) {
    const answer = await dialog.showMessageBox({ type: 'question', title: '接入已有 Crabot', message: '沿用已有聊天、项目和设置？',
      detail: `原版本：${legacy.installation.version}\n数据：${legacy.installation.dataRoot}\n程序保留在：${programs.installRoot}\n将正常停止旧服务，只转换需要升级的数据；不复制整份旧目录。`,
      buttons: ['接入已有数据', '取消'], defaultId: 0, cancelId: 1 })
    if (answer.response !== 0) return null
  }
  if (bound && !legacy && !management.readDesktopManagement(bound.dataDir)) throw new Error('已有数据绑定尚未完成，请保留原目录。')
  const dataDir = bound?.dataDir ?? (legacy ? management.requireExistingDataRoot(legacy.installation.dataRoot)
    : management.ensurePrivateDataRoot(path.join(programs.installRoot, 'data')))
  const selected = await first.bindFirstLaunchData(programs, dataDir)
  if (!legacy) return first.completeFreshFirstLaunch(selected, options.registerEntries)
  const { runPreparedLegacyDesktopTakeover } = await load('legacy-desktop-handoff.mjs')
  const abort = new AbortController(), progress = createOperationProgressWindow('admission', abort)
  const labels: Record<string, string> = { stopping: '正在正常停止旧版服务…', preparing_environment: '正在核对已有工作依赖…', switching: '正在准备数据接入…', converting: '正在转换需要升级的数据…' }
  try {
    await progress.ready
    await runPreparedLegacyDesktopTakeover({ prepared: { installRoot: programs.installRoot, installation: legacy.installation,
      selection: programs.selection, coreRoot: programs.coreRoot, guiRoot: programs.guiRoot, proof: selected.proof },
      entryFenceId: legacy.entryFenceId, signal: abort.signal, registerEntries: options.registerEntries,
      progress: (phase: string) => progress.update(labels[phase] || '正在接入已有数据…', !['switching', 'converting'].includes(phase)) })
  } finally { progress.close() }
  return desktop.locatePinnedDesktopGui(options.resources, options.pinText)
}
