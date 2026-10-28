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
  const removal = process.env.CRABOT_INSTALL_PROGRESS_KIND === 'removal'
  const module = await import(pathToFileURL(path.join(__dirname, removal ? '../dist/removal-progress-window.js' : '../dist/installation-progress-window.js')).href)
  const create = removal ? module.createRemovalProgressWindow : module.createInstallationProgressWindow
  const bridge = removal ? 'crabotRemove' : 'crabotInstall'
  const abort = new AbortController(); progress = create(abort); await progress.ready
  const window = BrowserWindow.getAllWindows()[0]
  const surface = await window.webContents.executeJavaScript(`({bridge:Object.keys(window.${bridge}),other:typeof window.${removal ? 'crabotInstall' : 'crabotRemove'},node:typeof require,credential:typeof window.crabotDesktop})`)
  assert.deepEqual(surface.bridge.sort(), ['cancel', 'subscribe']); assert.equal(surface.node, 'undefined'); assert.equal(surface.credential, 'undefined'); assert.equal(surface.other, 'undefined')
  foreign = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, removal ? '../dist/removal-preload.cjs' : '../dist/installer-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } })
  await foreign.loadURL(window.webContents.getURL())
  assert.equal(await foreign.webContents.executeJavaScript(`window.${bridge}.cancel().then(()=>false,()=>true)`), true)
  assert.equal(abort.signal.aborted, false)
  progress.update(removal ? '正在移除已核验程序，数据将保留…' : '正在核验安装结果…', false)
  await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  assert.equal(await window.webContents.executeJavaScript('document.getElementById("cancel").disabled'), true)
  assert.equal(await window.webContents.executeJavaScript('document.getElementById("message").textContent'), removal ? '正在移除已核验程序，数据将保留…' : '正在核验安装结果…')
  await window.webContents.executeJavaScript(`window.${bridge}.cancel()`); assert.equal(abort.signal.aborted, false)
  window.webContents.send((removal ? 'removal' : 'installer') + ':progress', { message: '无效状态不能恢复取消', cancellable: true, unexpected: true })
  await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  assert.equal(await window.webContents.executeJavaScript('document.getElementById("cancel").disabled'), true)
  window.close(); assert.equal(window.isDestroyed(), false); assert.equal(abort.signal.aborted, false)
  progress.update(removal ? '正在准备卸载，用户数据和 workspace 将保留…' : '正在安装 Crabot 和内置运行环境…')
  await window.webContents.executeJavaScript('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))')
  await fs.writeFile(path.join(root, 'progress.png'), (await window.webContents.capturePage()).toPNG())
  await window.webContents.executeJavaScript('document.getElementById("cancel").click()')
  const deadline = Date.now() + 5000
  while (!abort.signal.aborted && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(abort.signal.aborted, true)
  progress.close(); progress.close()
  console.log((removal ? 'CRABOT_REMOVAL_PROGRESS ' : 'CRABOT_INSTALLER_PROGRESS ') + JSON.stringify({ sandboxed_renderer: true, foreign_frame_rejected: true, cancellation_gated: true, repeated_cleanup: true, business_mm_started: false }))
}
main().then(() => { foreign?.destroy(); app.quit() }).catch(error => { console.error(error); try { progress?.close(); foreign?.destroy() } finally { app.exit(1) } })
