import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { App, Shell, dialog as ElectronDialog } from 'electron'
import { DesktopController, type PreparedDesktopPair } from './controller.js'
import { LoginStartup } from './login-startup.js'
import { createOperationProgressWindow } from './operation-progress-window.js'
import { replaceInstallationEntries, registerRetainedInstallationEntries } from './installation-entries.js'

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
  const progress = createOperationProgressWindow('admission', new AbortController())
  try {
    await progress.ready; progress.update('正在更新需要转换的数据，原数据保留在原位置…', false)
    controller.host.status('stopped', '旧版已退出，正在更新需要转换的数据。')
    await controller.applyPreparedPair(prepared, (from, to) => replaceInstallationEntries(from, to, { home, platform: 'win32', env: process.env, shell }))
    return true
  } finally { progress.close(); controller.close() }
}

// A retained-data repair has a different source: the original removal proof,
// even if its Core has been deleted. The existing target-Node handoff alone
// transfers that root guard to the normal data/health recovery coordinator.
export async function repairWindowsRetainedData(options: {
  programs: any; home: string; app: App; dialog: Pick<typeof ElectronDialog, 'showMessageBox'>; shell: Shell
}): Promise<boolean> {
  const { programs, dialog, home, shell } = options
  const load = (name: string): Promise<any> => import(new URL('./bootstrap/scripts/lib/' + name, import.meta.url).href)
  const { assertReinstallVersion } = await load('desktop-reinstall.mjs')
  assertReinstallVersion(programs.removal.source_selection.version, programs.selection.version)
  const desktop = createRequire(import.meta.url)('./bootstrap/scripts/lib/desktop-installation.cjs')
  const own = desktop.readDesktopInstallation(programs.installRoot)
  const answer = await dialog.showMessageBox({ type: 'question', title: '继续使用保留的数据', message: '修复程序并沿用已有聊天、项目和设置？',
    detail: `原数据：${own.dataDir}\n程序：${own.root}\n只转换确实需要升级的数据；不会复制整份旧目录。`,
    buttons: ['修复并继续', '取消'], defaultId: 0, cancelId: 1 })
  if (answer.response !== 0) return false
  if (!['removing', 'completed'].includes(programs.removal.phase)) throw new Error('原卸载尚未停止，请先完成原应用退出；原数据已保留。')
  const { inspectInstance } = await load('instance-runtime.mjs')
  const identity = createRequire(import.meta.url)('./bootstrap/scripts/lib/process-identity.cjs')
  const original = programs.removal.source_selection
  const observation = await identity.inspectProgramReferences({ roots: [path.join(own.root, 'app/releases', original.gui_id), path.join(own.root, 'releases', original.core_id)], files: [own.command] })
  // Only this verified GUI and its OS-pinned child tree are the repair host.
  // Other original processes remain blockers; no stop signal is sent.
  const self = identity.inspectProcess(process.pid)
  const host = identity.captureProcessTreeGeneration(self.pid, self.started, self.owner)
  if (inspectInstance(own.dataDir).state !== 'stopped' || !observation.complete || observation.incomplete
    || observation.unknown_pids?.length || observation.processes.some((value: any) => !host.some((member: any) => identity.sameProcess(member, value)))) {
    throw new Error('原应用或服务仍在使用程序，请正常退出后重新打开；尚未转换数据。')
  }
  const progress = createOperationProgressWindow('admission', new AbortController())
  try {
    await progress.ready; progress.update('正在恢复程序入口，随后核验原数据并启动服务…', false)
    const first = await load('desktop-first-launch.mjs'), bound = await first.bindFirstLaunchData(programs, own.dataDir)
    const prepared = { installRoot: own.root, installation_id: own.record.installation_id, selection: programs.selection,
      coreRoot: programs.coreRoot, guiRoot: programs.guiRoot, proof: bound.proof }
    const { runPreparedDesktopReinstallHandoff } = await import(pathToFileURL(path.join(programs.coreRoot, 'scripts/lib/desktop-reinstall-data.mjs')).href)
    await runPreparedDesktopReinstallHandoff({ installRoot: own.root, prepared, operationId: programs.removal.operation_id,
      registerEntries: (value: PreparedDesktopPair) => registerRetainedInstallationEntries(value, { home, platform: 'win32', env: process.env, shell, operationId: programs.removal.operation_id }) })
    return true
  } finally { progress.close() }
}
