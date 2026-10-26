// The private GUI role starts before ordinary installation/Core binding. All
// operation authority still comes from the fixed job's actual parent handshake.
import { app, dialog, Menu, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import type { RemovalRequest } from './removal-request.js'
import { createRemovalProgressWindow } from './removal-progress-window.js'
import { runRemovalOperation } from './removal-operation.js'
const require = createRequire(import.meta.url)
const load = (file: string) => import(new URL('./bootstrap/scripts/lib/' + file, import.meta.url).href)
const fail = (): never => { throw Object.assign(new Error('独立卸载维护程序的位置无法核验。'), { code: 'CRABOT_DESKTOP_REMOVAL' }) }

export function startDesktopRemovalHost(request: RemovalRequest) {
  // Configure only this private image's profile, synchronously before app ready.
  if (!app.isPackaged || !['darwin', 'win32'].includes(process.platform)) return fail()
  const executable = fs.realpathSync.native(process.execPath)
  const guiRoot = process.platform === 'darwin' ? path.resolve(path.dirname(executable), '../../..') : path.dirname(executable)
  const directory = path.dirname(guiRoot)
  const management = require('./bootstrap/scripts/lib/desktop-management.cjs')
  if (path.basename(guiRoot) !== 'gui' || !/^crabot-removal-host-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(path.basename(directory))
    || management.requirePrivateDataRoot(directory) !== directory || fs.realpathSync.native(process.cwd()) !== directory
    || fs.realpathSync.native(process.resourcesPath) !== path.join(guiRoot, process.platform === 'darwin' ? 'Crabot.app/Contents/Resources' : 'resources')) fail()
  const profile = management.ensurePrivateDataRoot(path.join(directory, 'profile'))
  app.setPath('userData', profile); app.setPath('sessionData', profile)
  app.setPath('temp', management.ensurePrivateDataRoot(path.join(profile, 'tmp')))
  const admissionAbort = new AbortController()
  let activeAbort = admissionAbort, firstDisplay = true
  const cancel = () => activeAbort.abort()
  const message = (value: unknown) => {
    if (value && typeof value === 'object' && Object.keys(value).length === 1 && (value as { kind?: unknown }).kind === 'desktop_removal_cancel') cancel()
  }
  process.on('message', message)
  const finished = (async () => {
    await app.whenReady(); Menu.setApplicationMenu(null)
    const { beginInitialDesktopRemoval, resumeDesktopRemoval, resumeInstallerDesktopRemoval, finishDesktopRemoval } = await load('desktop-removal-job.mjs')
    const { removeDesktopUserEntries } = await import('./installation-removal.js')
    const own = require('./bootstrap/scripts/lib/desktop-installation.cjs').readDesktopInstallation(request.installRoot)
    let open = request.existing ? resumeDesktopRemoval : beginInitialDesktopRemoval
    if (request.installerPayload) open = resumeInstallerDesktopRemoval
    const lease = await open({ ...request, signal: admissionAbort.signal })
    const result = await runRemovalOperation({ lease,
      openProgress: async abort => {
        activeAbort = abort
        if (firstDisplay && admissionAbort.signal.aborted) abort.abort(admissionAbort.signal.reason)
        firstDisplay = false
        const progress = createRemovalProgressWindow(abort)
        try {
          await progress.ready
          // Readiness is display metadata, not an exit or deletion receipt.
          try { if (process.connected) process.send?.({ kind: 'desktop_removal_host_ready', operation_id: request.operationId }, () => {}) } catch {}
          return progress
        } catch (error) { progress.close(); throw error }
      },
      decide: async ({ canCancel, code }) => {
        const buttons = canCancel ? ['重试', '取消卸载', '暂时退出'] : ['继续卸载', '保留数据修复…', '暂时退出']
        const answer = await dialog.showMessageBox({ type: 'warning', title: '卸载尚未完成', message: 'Crabot 尚未卸载完成，用户数据已保留。',
          detail: `${canCancel ? '程序删除尚未开始，可核验后取消。' : '程序删除已经开始，可以继续卸载或使用离线安装器修复。'}\n退出此界面会保留当前进度及保护，不会自动启动服务。\n诊断代码：${code}`,
          buttons, defaultId: 0, cancelId: 2, noLink: true })
        if (answer.response === 0) return 'retry'
        if (answer.response === 1 && canCancel) return 'cancel'
        if (answer.response === 1) await dialog.showMessageBox({ type: 'info', title: '保留数据修复', message: '请打开同版或更高版 Crabot 离线安装器。',
          detail: `选择原安装位置 ${own.root}，安装器将核验并使用原有数据。此界面关闭后即可继续；不要删除数据目录。`, buttons: ['关闭维护界面'] })
        return 'close'
      },
      removeEntries: () => removeDesktopUserEntries({ installRoot: own.root, operationId: request.operationId, home: homedir(), env: process.env, app, shell, maintenancePayload: lease.hostPayload }),
      finish: () => finishDesktopRemoval({ installRoot: own.root, operationId: request.operationId }),
    })
    if (result === 'completed') {
      for (;;) {
        const answer = await dialog.showMessageBox({ type: 'info', title: 'Crabot 已卸载', message: '应用已卸载，数据已保留。',
          detail: `保留位置：${own.dataDir}\n工作区与工作依赖同样保留。以后可用同版或更高版离线安装器恢复。`, buttons: ['关闭', '查看保留位置'], defaultId: 0, cancelId: 0 })
        if (answer.response !== 1) break
        const error = await shell.openPath(own.dataDir)
        if (error) await dialog.showMessageBox({ type: 'warning', message: '无法打开保留位置。', detail: own.dataDir, buttons: ['知道了'] })
      }
    } else if (result === 'cancelled') await dialog.showMessageBox({ type: 'info', title: '已取消卸载', message: '程序及用户数据已保留。',
      detail: '共享服务不会自动重启。如需继续使用，请从正常应用入口手动启动。', buttons: ['知道了'] })
    return result
  })().finally(() => { process.removeListener('message', message) })
  return { cancel, finished }
}
