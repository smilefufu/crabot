import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { showStartupPage } from '../dist/startup-page.js'

function fixture() {
  let url, handler
  const nodes = Object.fromEntries(['status', 'detail', 'actions', 'progress', 'cancel'].map(id => [id, { style: {} }]))
  const window = { isDestroyed: () => false,
    async loadURL(value) { url = value },
    webContents: { on(_event, value) { handler = value }, removeListener() { handler = undefined }, getURL: () => url,
      setWindowOpenHandler(value) { assert.deepEqual(value(), { action: 'deny' }) },
      async executeJavaScript(code) { vm.runInNewContext(code, { document: { getElementById: id => nodes[id] } }) } } }
  return { window, nodes, page: () => Buffer.from(url.split(',')[1], 'base64').toString(),
    click(action) { let prevented = false; handler({ preventDefault() { prevented = true } }, 'https://crabot.invalid/startup/' + action); assert.equal(prevented, true) } }
}
test('the normal window shows the installed version, literal progress and an actionable retry without another BrowserWindow', async () => {
  const f = fixture(), page = await showStartupPage(f.window, '0.1.0-desktop.17')
  assert.match(f.page(), /0\.1\.0-desktop\.17/)
  assert.match(f.page(), /Content-Security-Policy/)
  await page.update('复制数据', '<script>must stay literal</script>')
  assert.equal(f.nodes.detail.textContent, '<script>must stay literal</script>')
  const pending = page.retry(new Error('specific operation failed'), 'C:\\data\\bootstrap.log')
  await Promise.resolve()
  assert.match(f.nodes.detail.textContent, /specific operation failed/)
  assert.equal(f.nodes.actions.style.display, 'block')
  f.click('retry'); assert.equal(await pending, true)
  page.close()
})
test('unrelated navigation cannot authorize retry and the explicit Exit action returns to the caller', async () => {
  const f = fixture(), page = await showStartupPage(f.window, '<unsafe-version>')
  assert.ok(f.page().includes('&lt;unsafe-version&gt;'))
  const pending = page.retry(new Error('data unavailable'), 'log')
  await Promise.resolve()
  f.click('unrecognized'); f.click('exit')
  assert.equal(await pending, false)
  page.close()
})

test('the normal startup window retains cancellation only during cancellable data preparation', async () => {
  const f = fixture(); let cancelled = 0
  const page = await showStartupPage(f.window, '0.1.0-desktop.17', () => { cancelled++ })
  f.click('cancel'); assert.equal(cancelled, 0)
  await page.update('复制数据', '', false, true)
  assert.equal(f.nodes.cancel.hidden, false)
  f.click('cancel'); assert.equal(cancelled, 1)
  await page.update('迁移数据', '', false, false)
  assert.equal(f.nodes.cancel.hidden, true)
  f.click('cancel'); assert.equal(cancelled, 1)
  page.close()
})
