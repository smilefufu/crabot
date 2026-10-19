import { BrowserWindow, ipcMain, session } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { InstallationProgressSchema } from './installer-progress.js'
const directory = path.dirname(fileURLToPath(import.meta.url))
export function createInstallationProgressWindow(abort: AbortController) {
  const nonce = randomBytes(24).toString('base64url')
  const html = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<title>安装 Crabot</title>
<style>
body{font:16px system-ui;background:#f5f5f7;color:#202124;margin:48px}
h1{font-size:24px}p{line-height:1.8}
button{font:inherit;float:right;padding:8px 24px;border:1px solid #bbb;border-radius:8px;background:white}
progress{width:100%;margin:20px 0}
</style>
<h1>正在安装 Crabot</h1><p id="message">正在核验离线安装组件…</p>
<progress></progress><button id="cancel">取消</button>
<script nonce="${nonce}">
const button=document.getElementById('cancel');
button.onclick=()=>window.crabotInstall.cancel();
window.crabotInstall.subscribe(state=>{
  document.getElementById('message').textContent=state.message;
  button.disabled=!state.cancellable;
});
</script></html>`
  const url = 'data:text/html;base64,' + Buffer.from(html).toString('base64'), partition = session.fromPartition('crabot-installer')
  partition.setPermissionRequestHandler((_web, _permission, callback) => callback(false)); partition.setPermissionCheckHandler(() => false)
  const window = new BrowserWindow({ width: 560, height: 300, resizable: false, minimizable: false, maximizable: false, title: '安装 Crabot',
    webPreferences: { preload: path.join(directory, 'installer-preload.cjs'), session: partition, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } })
  let cancellable = true
  const update = (message: string, allowCancel = true) => {
    cancellable = allowCancel
    if (!window.isDestroyed()) window.webContents.send('installer:progress', InstallationProgressSchema.parse({ message, cancellable: allowCancel }))
  }
  const cancel = () => { if (cancellable) { abort.abort(); update('正在取消并等待文件操作结束…', false) } }
  ipcMain.handle('installer:cancel', (event, argument) => {
    const frame = event.senderFrame, main = window.webContents.mainFrame
    if (argument !== undefined || event.sender.id !== window.webContents.id || !frame || frame.parent || frame.url !== url
      || frame.processId !== main.processId || frame.routingId !== main.routingId) throw new Error('Installer request rejected')
    cancel(); return true
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.on('will-attach-webview', event => event.preventDefault())
  window.on('close', event => { event.preventDefault(); cancel() })
  return { ready: window.loadURL(url), update, close: () => { ipcMain.removeHandler('installer:cancel'); if (!window.isDestroyed()) window.destroy() } }
}
