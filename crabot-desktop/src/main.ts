import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, protocol, session, shell, Tray } from 'electron'
import path from 'node:path'
import { homedir } from 'node:os'
import { access, writeFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { DesktopDiagnostics } from 'crabot-client'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { DesktopController } from './controller.js'
import { attachLocalPages } from './local-pages.js'
import { attachDesktopNetwork } from './desktop-network.js'
import { registerDesktopIpc } from './desktop-ipc.js'
import { collectDiagnostics } from './diagnostics.js'
import { externalUrl, isAppUrl, isTrustedFrame } from './window-security.js'

app.setName('Crabot')
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
const directory = path.dirname(fileURLToPath(import.meta.url))
const coreRoot = app.isPackaged ? path.join(process.resourcesPath, 'core') : path.resolve(app.getAppPath(), '..')
const loadCore = (file: string) => import(pathToFileURL(path.join(coreRoot, file)).href)
let window: BrowserWindow | undefined, tray: Tray | undefined, controller: DesktopController | undefined
let dataRoot = path.join(homedir(), '.crabot/data'), initialError: unknown, quitting = false
let pendingQuit: Promise<boolean> | undefined

async function quit(): Promise<boolean> {
  if (pendingQuit) return pendingQuit
  pendingQuit = (async () => {
    const state = controller?.host.snapshot()
    if (state && state.phase !== 'stopped' && state.phase !== 'migration_required') {
      const answer = await dialog.showMessageBox({ type: 'question', title: '退出 Crabot', message: '退出将停止共享的 Crabot 服务。',
        detail: '正在进行的任务和其他客户端连接会受影响。关闭窗口可以继续后台运行。', buttons: ['取消', '停止服务并退出'], defaultId: 0, cancelId: 0 })
      if (answer.response !== 1) return false
      if ((await controller!.stop()).phase !== 'stopped') {
        await dialog.showMessageBox({ type: 'error', message: '未能确认服务已停止。', detail: '已保留运行记录，请检查诊断后重试。' })
        return false
      }
    }
    quitting = true; controller?.close(); tray?.destroy(); app.quit(); return true
  })().finally(() => { pendingQuit = undefined })
  return pendingQuit
}
function show() { window?.show(); window?.focus() }

async function boot() {
  try {
    const { resolveCliDataDir } = await loadCore('scripts/lib/instance.mjs')
    dataRoot = path.resolve(resolveCliDataDir({ homeDir: path.join(homedir(), '.crabot') }))
    const management = (await loadCore('scripts/lib/desktop-management.cjs')).default
    dataRoot = management.ensurePrivateDataRoot(dataRoot)
    app.setPath('userData', path.join(dataRoot, 'desktop-profile'))
  } catch (error) { initialError = error }
  if (!app.requestSingleInstanceLock()) { quitting = true; app.quit(); return }
  app.on('second-instance', show)
  await app.whenReady()
  await access(path.join(coreRoot, 'crabot-admin/dist/web/desktop.html'))
  controller = new DesktopController({ coreRoot, dataRoot, appVersion: app.getVersion(), platform: process.platform as 'darwin' | 'win32' | 'linux' })
  const privateSession = session.fromPartition('persist:crabot-desktop')
  privateSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  privateSession.setPermissionCheckHandler(() => false)
  attachLocalPages(privateSession, path.join(coreRoot, 'crabot-admin/dist/web'))
  attachDesktopNetwork(privateSession, controller.host, () => window?.webContents)
  window = new BrowserWindow({ width: 1180, height: 800, minWidth: 800, minHeight: 560, show: false, title: 'Crabot',
    backgroundColor: '#f5f5f7', autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: { session: privateSession, preload: path.join(directory, 'preload.cjs'), nodeIntegration: false,
      contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, allowRunningInsecureContent: false } })
  const reports = new Map<string, DesktopDiagnostics>()
  const diagnostics = async () => {
    const report = await collectDiagnostics(coreRoot, controller!.host.snapshot(), controller!.host.recent())
    reports.set(report.report_id, report)
    while (reports.size > 4) reports.delete(reports.keys().next().value!)
    return report
  }
  registerDesktopIpc({ ipc: ipcMain, contents: () => window?.webContents, controller, quit, diagnostics,
    openExternal: url => shell.openExternal(url), revealData: async () => !(await shell.openPath(dataRoot)),
    exportDiagnostics: async id => {
      const report = reports.get(id)
      if (!report) return false
      const chosen = await dialog.showSaveDialog({ title: '导出基础诊断', defaultPath: 'crabot-diagnostics.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
      if (chosen.canceled || !chosen.filePath) return false
      const temporary = chosen.filePath + '.tmp-' + randomUUID()
      let created = false
      try {
        await writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); created = true
        await rename(temporary, chosen.filePath); return true
      } catch { return false }
      finally { if (created) await rm(temporary, { force: true }).catch(() => {}) }
    },
  })
  controller.host.subscribe(state => {
    if (!window?.isDestroyed() && window?.webContents.mainFrame && isTrustedFrame(window.webContents.mainFrame, window.webContents)) window.webContents.send('desktop:state', state)
    tray?.setToolTip(`Crabot · ${state.phase === 'ready' ? '运行中' : state.phase === 'stopped' ? '已停止' : '正在检查'}`)
  })
  window.webContents.setWindowOpenHandler(({ url }) => { const allowed = externalUrl(url); if (allowed) void shell.openExternal(allowed); return { action: 'deny' } })
  window.webContents.on('will-navigate', (event, url) => { if (!isAppUrl(url)) { event.preventDefault(); const allowed = externalUrl(url); if (allowed) void shell.openExternal(allowed) } })
  window.webContents.on('will-attach-webview', event => event.preventDefault())
  window.on('close', event => { if (!quitting) { event.preventDefault(); window?.hide() } })
  window.once('ready-to-show', () => { if (!process.argv.includes('--background')) show() })
  // A built-in vector is rendered locally; it needs no downloaded image or external page.
  const iconWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, offscreen: true } })
  await iconWindow.loadURL('data:text/html,' + encodeURIComponent('<html style="margin:0;background:transparent"><body style="margin:0"><svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect x="2" y="4" width="28" height="24" rx="9" fill="#3740a5"/><path d="M8 12h16v9H8z" fill="white"/><circle cx="12" cy="16" r="2" fill="#3740a5"/><circle cx="20" cy="16" r="2" fill="#3740a5"/></svg></body></html>'))
  const capture = await iconWindow.webContents.capturePage({ x: 0, y: 0, width: 32, height: 32 })
  iconWindow.destroy()
  tray = new Tray(nativeImage.createFromBuffer(capture.toPNG()).resize({ width: 20, height: 20 }))
  tray.setToolTip('Crabot')
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开 Crabot', click: show }, { type: 'separator' },
    { label: '启动服务', click: () => { void controller!.start() } }, { label: '停止服务', click: () => { void controller!.stop() } },
    { type: 'separator' }, { label: '退出 Crabot', click: () => { void quit() } }]))
  tray.on('click', show)
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Crabot', submenu: [{ label: '打开 Crabot', click: show }, { type: 'separator' }, { label: '退出 Crabot', accelerator: 'CommandOrControl+Q', click: () => { void quit() } }] },
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]))
  await window.loadURL('app://crabot/')
  if (initialError) controller.fail(initialError)
  else { void controller.start(); controller.watch() }
}
app.on('activate', show)
app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void quit() } })
app.on('window-all-closed', () => { /* Tray owns the application lifetime. */ })
void boot().catch(async () => { await dialog.showMessageBox({ type: 'error', message: 'Crabot 界面启动失败，请修复安装。' }); quitting = true; app.quit() })
