import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
const handler = source.slice(source.indexOf('void boot().catch')).replace('void boot()', 'boot()')
for (const code of ['CRABOT_DESKTOP_INSTALLATION', 'CRABOT_CORE_INTEGRITY', 'CRABOT_MAC_APP_BINDING', 'DESKTOP_BOOT_FAILED']) {
  test('startup failure retains the actual cause and log location: ' + code, async () => {
    const error = Object.assign(new Error('specific failed operation'), { code }), messages = []
    let quit = false
    await vm.runInNewContext(handler, {
      Error, path, quitting: false, boot: async () => { throw error }, bootstrapStage() {}, console: { error() {} },
      app: { isPackaged: false, whenReady: async () => {}, getPath: () => '/fixture/profile', quit: () => { quit = true } },
      dialog: { showMessageBox: async value => messages.push(value) },
    })
    assert.equal(messages.length, 1)
    assert.ok(messages[0].message.includes(error.message))
    assert.ok(messages[0].message.includes(path.join('/fixture/profile', 'bootstrap.log')))
    assert.equal(quit, true)
  })
}
