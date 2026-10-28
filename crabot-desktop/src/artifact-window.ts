import { BrowserWindow, dialog, Menu, session, shell, type DownloadItem } from 'electron'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { artifactUrl, attachArtifactNetwork } from './artifact-network.js'
import type { SessionHost } from './session-host.js'
import { externalUrl } from './window-security.js'

export class ArtifactWindows {
  private windows = new Map<string, { window: BrowserWindow; save: () => void }>()
  constructor(private readonly host: SessionHost, private readonly changed: () => void = () => {}) {}
  hasFocused(): boolean { return Array.from(this.windows.values()).some(item => item.window === BrowserWindow.getFocusedWindow()) }
  saveFocused(): boolean {
    const item = Array.from(this.windows.values()).find(item => item.window === BrowserWindow.getFocusedWindow())
    if (!item) return false
    item.save(); return true
  }
  open(value: string, download = false): boolean {
    const scope = this.host.context(), target = artifactUrl(value, scope)
    if (!scope || !target) return false
    const key = JSON.stringify([scope, target])
    const existing = this.windows.get(key)
    if (existing && !existing.window.isDestroyed()) { existing.window.show(); existing.window.focus(); if (download) existing.save(); return true }
    const isolated = session.fromPartition('crabot-artifact-' + randomUUID())
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    isolated.setPermissionCheckHandler(() => false)
    const window = new BrowserWindow({ width: 960, height: 720, title: 'Crabot · 附件预览', autoHideMenuBar: true,
      webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false } })
    const policy = attachArtifactNetwork(isolated, this.host, () => window.isDestroyed() ? undefined : window.webContents, target, scope)
    const downloads = new Set<DownloadItem>()
    let allowDownload = true, beganDownload = false
    const save = () => {
      if (policy.arm('download')) { allowDownload = true; window.webContents.downloadURL(target) }
      else void dialog.showMessageBox(window, { type: 'info', message: '当前附件连接已失效或仍在读取，请从 Crabot 重新打开后保存。' })
    }
    this.windows.set(key, { window, save }); this.changed()
    window.on('focus', this.changed)
    isolated.on('will-download', (event, item, contents) => {
      if (!allowDownload || contents !== window.webContents || item.getURLChain().some(url => url !== target)) { event.preventDefault(); return }
      allowDownload = false; beganDownload = true
      downloads.add(item)
      item.setSaveDialogOptions({ title: '保存附件', defaultPath: path.basename(item.getFilename()) || 'crabot-attachment' })
      item.once('done', () => { downloads.delete(item); if (!window.isDestroyed() && (download || window.webContents.getURL() === '')) window.close() })
    })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('dom-ready', () => { allowDownload = false })
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.webContents.on('will-attach-webview', event => event.preventDefault())
    window.webContents.on('will-prevent-unload', event => event.preventDefault())
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && (process.platform === 'darwin' ? input.meta : input.control) && input.key.toLowerCase() === 's') { event.preventDefault(); save() }
    })
    window.webContents.on('context-menu', (_event, parameters) => {
      const link = externalUrl(parameters.linkURL)
      Menu.buildFromTemplate([{ label: '保存原始附件…', click: save }, ...(link ? [{ label: '在系统浏览器打开链接', click: () => { void shell.openExternal(link) } }] : []),
        { type: 'separator' }, { role: 'copy' }, { role: 'selectAll' }]).popup({ window })
    })
    window.once('closed', () => {
      downloads.forEach(item => { try { item.cancel() } catch { /* Chromium may already have disposed a cancelled item. */ } }); policy.close(); this.windows.delete(key)
      this.changed()
      void isolated.clearStorageData().catch(() => {})
    })
    if (download) save()
    else if (policy.arm('preview')) void window.loadURL(target).catch(() => {
      if (!window.isDestroyed() && !beganDownload) void dialog.showMessageBox(window, { type: 'error', message: '附件未能打开。', detail: '文件可能已过期或连接已失效，请回到聊天重新打开。' })
    })
    return true
  }
  close() { for (const { window } of this.windows.values()) if (!window.isDestroyed()) window.destroy(); this.windows.clear() }
}
