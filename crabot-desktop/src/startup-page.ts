import type { BrowserWindow } from 'electron'
import { randomBytes } from 'node:crypto'

// Temporary content of the ordinary main window. It owns no install/data work.
export async function showStartupPage(window: BrowserWindow, version: string, cancel?: () => void) {
  const nonce = randomBytes(24).toString('base64url')
  const escape = (value: string) => value.replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value]!)
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<title>CRABOT</title><style>body{margin:0;background:#202127;color:#eee;font:16px system-ui}main{max-width:760px;margin:12vh auto;padding:32px}h1{font-size:32px}small{color:#adb0be}pre{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7;font:inherit}button{font:inherit;padding:10px 24px;border-radius:8px;border:1px solid #7b7e9e;background:#a7a8ff;color:#171724;margin-right:12px}#actions{display:none}progress{width:100%;accent-color:#a7a8ff}</style>
<main><h1>CRABOT</h1><small>版本 ${escape(version)}</small><h2 id="status">正在准备本机服务…</h2><pre id="detail"></pre><progress id="progress"></progress><p><button id="cancel" hidden>取消本次数据准备</button></p><p id="actions"><button id="retry">重试</button><button id="exit">退出 CRABOT</button></p></main>
<script nonce="${nonce}">document.getElementById('cancel').onclick=()=>location.href='https://crabot.invalid/startup/cancel';document.getElementById('retry').onclick=()=>location.href='https://crabot.invalid/startup/retry';document.getElementById('exit').onclick=()=>location.href='https://crabot.invalid/startup/exit';</script></html>`
  const url = 'data:text/html;base64,' + Buffer.from(html).toString('base64')
  let canCancel = false
  let settle: ((retry: boolean) => void) | undefined
  const navigate = (event: Electron.Event, target: string) => {
    event.preventDefault()
    if (window.webContents.getURL() !== url) return
    if (target === 'https://crabot.invalid/startup/cancel' && canCancel) { canCancel = false; cancel?.() }
    if (target === 'https://crabot.invalid/startup/retry') settle?.(true)
    if (target === 'https://crabot.invalid/startup/exit') settle?.(false)
  }
  window.webContents.on('will-navigate', navigate)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  await window.loadURL(url)
  const update = async (message: string, detail = '', failed = false, cancellable = false) => {
    canCancel = !failed && cancellable && !!cancel
    if (window.isDestroyed() || window.webContents.getURL() !== url) return
    await window.webContents.executeJavaScript(`document.getElementById('status').textContent=${JSON.stringify(message)};document.getElementById('detail').textContent=${JSON.stringify(detail)};document.getElementById('actions').style.display=${JSON.stringify(failed ? 'block' : 'none')};document.getElementById('progress').hidden=${failed};document.getElementById('cancel').hidden=${!canCancel};`)
  }
  return {
    update,
    retry: async (error: unknown, log: string) => {
      const choice = new Promise<boolean>(resolve => { settle = resolve })
      await update('本机服务准备未完成', `${error instanceof Error ? error.message : String(error)}\n日志：${log}`, true)
      try { return await choice } finally { settle = undefined }
    },
    close: () => { settle?.(false); window.webContents.removeListener('will-navigate', navigate) },
  }
}
