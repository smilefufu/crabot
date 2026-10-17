import test from 'node:test'
import assert from 'node:assert/strict'
import { UpdateDialog } from '../dist/update-dialog.js'

const update = { version: '1.2.4', file: '/fixture', sha512: 'fixture', size: 100 }
const flush = () => new Promise(resolve => setImmediate(resolve))
function fixture({ activity = 'idle', check = async () => update, prepare, response = 1, driver = true } = {}) {
  const calls = [], dialogs = []
  const controller = new UpdateDialog({ version: '1.2.3', driver: driver ? {
    check: async progress => { calls.push('check'); return check(progress) }, install: async () => { calls.push('install') },
  } : null, show: async options => { dialogs.push(options); return { response, checkboxChecked: false } },
    activity: async () => { calls.push('activity'); return activity },
    prepareInstall: prepare ?? (async (_update, install) => { calls.push('prepare'); await install() }) })
  return { controller, calls, dialogs }
}
test('background download and ordinary close never install or inspect/mutate business activity', async () => {
  const f = fixture({ response: 0 }); f.controller.start(); await flush()
  assert.deepEqual(f.calls, ['check']); await f.controller.open(); f.controller.close()
  assert.deepEqual(f.calls, ['check']); assert.match(f.dialogs[0].message, /1.2.4/)
})
for (const activity of ['active', 'unknown']) test(activity + ' work facts block installer and maintenance writes', async () => {
  const f = fixture({ activity }); f.controller.start(); await flush(); await f.controller.open(); f.controller.close()
  assert.deepEqual(f.calls, ['check', 'activity']); assert.equal(f.dialogs.length, 2)
})
test('only explicit install plus idle facts reaches the lifecycle maintenance adapter and installer', async () => {
  const f = fixture(); f.controller.start(); await flush(); await f.controller.open(); f.controller.close()
  assert.deepEqual(f.calls, ['check', 'activity', 'prepare', 'install'])
})
test('candidate/source builds perform no network checks or install while still presenting native status', async () => {
  const f = fixture({ driver: false }); f.controller.start(); assert.equal(await f.controller.open(), true); f.controller.close()
  assert.deepEqual(f.calls, []); assert.match(f.dialogs[0].message, /未启用/)
})
test('download errors preserve the old version and do not expose raw network error contents', async () => {
  const f = fixture({ check: async () => { throw new Error('https://secret/credential') }, response: 0 })
  f.controller.start(); await flush(); await f.controller.open(); f.controller.close()
  assert.deepEqual(f.calls, ['check']); assert.equal(JSON.stringify(f.dialogs).includes('secret'), false)
})
test('an interrupted maintenance action reports recovery and never claims success', async () => {
  const f = fixture({ prepare: async () => { throw new Error('interrupted') } })
  f.controller.start(); await flush(); await f.controller.open(); f.controller.close()
  assert.deepEqual(f.calls, ['check', 'activity']); assert.match(f.dialogs.at(-1).message, /未能确认/)
})
test('space and signature failures give specific safe recovery instructions instead of a network diagnosis', async () => {
  for (const [code, word] of [['CRABOT_UPDATE_SPACE', '空间不足'], ['ERR_UPDATER_INVALID_SIGNATURE', '签名']]) {
    const f = fixture({ check: async () => { throw Object.assign(new Error('https://secret/token'), { code }) }, response: 0 })
    f.controller.start(); await flush(); await f.controller.open(); f.controller.close()
    assert.ok(f.dialogs[0].detail.includes(word)); assert.equal(JSON.stringify(f.dialogs).includes('secret'), false)
  }
})
test('a changed cached file can be downloaded again and cannot trap the user in repeated installation attempts', async () => {
  const f = fixture({ prepare: async () => { throw Object.assign(new Error('Changed cache'), { code: 'CRABOT_UPDATE_INTEGRITY' }) } })
  f.controller.start(); await flush(); await f.controller.open()
  await f.controller.open(); await flush(); f.controller.close()
  assert.deepEqual(f.calls, ['check', 'activity', 'check'])
})
