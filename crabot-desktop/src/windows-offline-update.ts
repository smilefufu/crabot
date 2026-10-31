import path from 'node:path'
import { createRequire } from 'node:module'
import type { App, Shell, dialog as ElectronDialog } from 'electron'
import { DesktopController, type PreparedDesktopPair } from './controller.js'
import { LoginStartup } from './login-startup.js'
import { replaceInstallationEntries } from './installation-entries.js'

// Offline source-to-target update of one existing desktop installation. Reuses
// the original stopped-pair coordinator, never authenticates the new GUI to the
// old Core, and never starts the old Core or forces an old GUI to exit.
export async function applyWindowsOfflineUpdate(options: {
  prepared: PreparedDesktopPair; source: any; home: string; app: App;
  dialog: Pick<typeof ElectronDialog, 'showMessageBox'>; shell: Shell
}): Promise<boolean> {
  const { source, prepared, dialog, app, shell, home } = options
  const load = (name: string): Promise<any> => import(new URL('./bootstrap/scripts/lib/' + name, import.meta.url).href)
  const identity = createRequire(import.meta.url)('./bootstrap/scripts/lib/process-identity.cjs')
  const desktop = createRequire(import.meta.url)('./bootstrap/scripts/lib/desktop-installation.cjs')
  const { inspectInstance } = await load('instance-runtime.mjs')
  const { verifyCoreRelease } = await load('core-release.mjs')
  const release = await verifyCoreRelease(source.coreRoot, { version: source.selection.version })
  if (release.inventory_sha256 !== source.selection.core_id) throw new Error('原版本程序已变化，未开始更新。')
  while (true) {
    const observation = await identity.inspectProgramReferences({ roots: [source.guiRoot], files: [source.executable] })
    if (!observation.complete || observation.incomplete || observation.unknown_pids?.length) throw new Error('旧版应用退出状态尚未核实，尚未转换数据。')
    if (inspectInstance(source.dataDir).state === 'stopped' && observation.processes.length === 0) break
    const answer = await dialog.showMessageBox({ type: 'info', title: '完成 Crabot 更新', message: '请先退出旧版 Crabot，再继续。',
      detail: `原版本：${source.selection.version}\n目标版本：${prepared.selection.version}\n请从旧版菜单选择“退出 Crabot”；仅关闭窗口会继续后台运行。已有工作和数据会按正常退出流程保留。`,
      buttons: ['已退出，继续更新', '稍后再更新'], defaultId: 0, cancelId: 1 })
    if (answer.response !== 0) return false
  }
  const verifyBinding = () => {
    const own = desktop.readDesktopSelection(source.root)
    if (own.record.installation_id !== source.record.installation_id || JSON.stringify(own.selection) !== JSON.stringify(source.selection)
      || own.dataDir !== source.dataDir) throw new Error('原版本选择已变化，未继续更新。')
  }
  const startup = new LoginStartup({ platform: 'win32', packaged: true, executable: source.executable,
    configHome: path.join(home, '.config'), app })
  const controller = new DesktopController({ coreRoot: source.coreRoot, dataRoot: source.dataDir, appVersion: source.selection.version,
    platform: 'win32', packaged: true, verifyBinding, loginStartup: startup })
  try {
    controller.host.status('stopped', '旧版已退出，正在更新需要转换的数据。')
    await controller.applyPreparedPair(prepared, (from, to) => replaceInstallationEntries(from, to, { home, platform: 'win32', env: process.env, shell }))
    return true
  } finally { controller.close() }
}
