// Actual Chromium/preload/IPC, with no installer backend, MM, model or OS registration.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const assert = require('node:assert/strict')
let progress, foreign
app.on('window-all-closed', () => {})
async function main() {
  const root = process.env.CRABOT_INSTALL_PROGRESS_ROOT
  assert.ok(root && path.isAbsolute(root))
  await fs.mkdir(path.join(root, 'profile')); app.setPath('userData', path.join(root, 'profile'))
  await app.whenReady()
  const { createInstallationProgressWindow } = await import(pathToFileURL(path.join(__dirname, '../dist/installation-progress-window.js')).href)
  const abort = new AbortController(); progress = createInstallationProgressWindow(abort); await progress.ready
  const window = BrowserWindow.getAllWindows()[0]
  const surface = await window.webContents.executeJavaScript('({bridge:Object.keys(window.crabotInstall),node:typeof require,credential:typeof window.crabotDesktop})')
  assert.deepEqual(surface.bridge.sort(), ['cancel', 'subscribe']); assert.equal(surface.node, 'undefined'); assert.equal(surface.credential, 'undefined')
  foreign = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, '../dist/installer-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } })
  await foreign.loadURL(window.webContents.getURL())
  assert.equal(await foreign.webContents.executeJavaScript('window.crabotInstall.cancel().then(()=>false,()=>true)'), true)
  assert.equal(abort.signal.aborted, false)
  progress.update('正在核验安装结果…', false)
  await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  assert.equal(await window.webContents.executeJavaScript('document.getElementById("cancel").disabled'), true)
  assert.equal(await window.webContents.executeJavaScript('document.getElementById("message").textContent'), '正在核验安装结果…')
  await window.webContents.executeJavaScript('window.crabotInstall.cancel()'); assert.equal(abort.signal.aborted, false)
  progress.update('正在安装 Crabot 和内置运行环境…')
  await window.webContents.executeJavaScript('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))')
  await fs.writeFile(path.join(root, 'progress.png'), (await window.webContents.capturePage()).toPNG())
  await window.webContents.executeJavaScript('document.getElementById("cancel").click()')
  const deadline = Date.now() + 5000
  while (!abort.signal.aborted && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(abort.signal.aborted, true)
  progress.close(); progress.close()
  console.log('CRABOT_INSTALLER_PROGRESS ' + JSON.stringify({ sandboxed_renderer: true, foreign_frame_rejected: true, cancellation_gated: true, repeated_cleanup: true, business_mm_started: false }))
}
main().then(() => { foreign?.destroy(); app.quit() }).catch(error => { console.error(error); try { progress?.close(); foreign?.destroy() } finally { app.exit(1) } })
