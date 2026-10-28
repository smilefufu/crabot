import { BrowserWindow, ipcMain, session } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { OperationProgressSchema } from './operation-progress.js'
const directory = path.dirname(fileURLToPath(import.meta.url))
// Fixed display/cancellation only; this component owns no install/removal work.
export function createOperationProgressWindow(kind: 'installation' | 'removal', abort: AbortController) {
  if (kind !== 'installation' && kind !== 'removal') throw new Error('Unknown progress operation')
  const removal = kind === 'removal', prefix = removal ? 'removal' : 'installer'
  const title = removal ? '卸载 Crabot' : '安装 Crabot'
  const heading = removal ? '正在卸载 Crabot' : '正在安装 Crabot'
  const initialMessage = removal ? '正在核验原安装，用户数据将保留…' : '正在核验离线安装组件…'
  const bridge = removal ? 'crabotRemove' : 'crabotInstall'

  const nonce = randomBytes(24).toString('base64url')
  const html = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<title>${title}</title>
<style>
body{font:16px system-ui;background:#f5f5f7;color:#202124;margin:48px}
h1{font-size:24px}p{line-height:1.8}
button{font:inherit;float:right;padding:8px 24px;border:1px solid #bbb;border-radius:8px;background:white}
progress{width:100%;margin:20px 0}
</style>
<h1>${heading}</h1><p id="message">${initialMessage}</p>
<progress></progress><button id="cancel">取消</button>
<script nonce="${nonce}">
const button=document.getElementById('cancel');
button.onclick=()=>window.${bridge}.cancel();
window.${bridge}.subscribe(state=>{
  document.getElementById('message').textContent=state.message;
  button.disabled=!state.cancellable;
});
</script></html>`
  const url = 'data:text/html;base64,' + Buffer.from(html).toString('base64'), partition = session.fromPartition('crabot-' + prefix)
  partition.setPermissionRequestHandler((_web, _permission, callback) => callback(false)); partition.setPermissionCheckHandler(() => false)
  const window = new BrowserWindow({ width: 560, height: 300, resizable: false, minimizable: false, maximizable: false, title,
    webPreferences: { preload: path.join(directory, prefix + '-preload.cjs'), session: partition, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } })
  let cancellable = true
  const update = (message: string, allowCancel = true) => {
    cancellable = allowCancel
    if (!window.isDestroyed()) window.webContents.send(prefix + ':progress', OperationProgressSchema.parse({ message, cancellable: allowCancel }))
  }
  const cancel = () => { if (cancellable) { abort.abort(); update('正在取消并等待文件操作结束…', false) } }
  ipcMain.handle(prefix + ':cancel', (event, argument) => {
    const frame = event.senderFrame, main = window.webContents.mainFrame
    if (argument !== undefined || event.sender.id !== window.webContents.id || !frame || frame.parent || frame.url !== url
      || frame.processId !== main.processId || frame.routingId !== main.routingId) throw new Error(removal ? 'Removal request rejected' : 'Installer request rejected')
    cancel(); return true
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.on('will-attach-webview', event => event.preventDefault())
  window.on('close', event => { event.preventDefault(); cancel() })
  return { ready: window.loadURL(url), update, close: () => { ipcMain.removeHandler(prefix + ':cancel'); if (!window.isDestroyed()) window.destroy() } }
}
