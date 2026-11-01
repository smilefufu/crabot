// Real sandboxed renderer for normal-window preparation actions. No Core or MM.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { once } = require('node:events')
const root = process.env.CRABOT_STARTUP_PAGE_TEST_ROOT
app.setPath('userData', root)
app.whenReady().then(async () => {
  const { showStartupPage } = await import(pathToFileURL(path.resolve(__dirname, '../dist/startup-page.js')).href)
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  let cancellations = 0
  const page = await showStartupPage(window, '0.1.0-desktop.17', () => { cancellations++ })
  const click = async action => {
    const navigation = once(window.webContents, 'will-navigate')
    await window.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(action)}).click()`)
    await navigation
  }
  await page.update('复制数据', '', false, true)
  assert.equal(await window.webContents.executeJavaScript("document.getElementById('cancel').hidden"), false)
  await click('cancel'); assert.equal(cancellations, 1)
  await page.update('迁移数据')
  assert.equal(await window.webContents.executeJavaScript("document.getElementById('cancel').hidden"), true)
  await click('cancel'); assert.equal(cancellations, 1)
  const pending = page.retry(new Error('具体失败 <script>literal</script>'), path.join(root, 'bootstrap.log'))
  const limit = Date.now() + 2000
  while (await window.webContents.executeJavaScript("document.getElementById('actions').style.display") !== 'block') {
    if (Date.now() >= limit) throw new Error('Retry actions did not appear')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.match(await window.webContents.executeJavaScript("document.getElementById('detail').textContent"), /具体失败 <script>literal<\/script>/)
  await click('retry'); assert.equal(await pending, true)
  assert.equal(BrowserWindow.getAllWindows().length, 1)
  assert.equal(window.webContents.getURL().startsWith('data:text/html;base64,'), true)
  page.close()
  console.log('CRABOT_STARTUP_PAGE ' + JSON.stringify({ actual_sandboxed_renderer: true, copy_cancel: true, migration_cancel_blocked: true, concrete_error: true, retry: true, one_window: true, business_mm_started: false }))
  app.exit(0)
}).catch(error => { console.error(error.stack); app.exit(1) })
