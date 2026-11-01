import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
const branch = source.slice(source.indexOf('  const windowsRemoval ='), source.indexOf('  const windowsFirstUse =')).replaceAll('import.meta.url', "'fixture-main'")
const selection = { version: '1.2.3', gui_id: 'original', core_id: 'original-core' }
async function run({ phase = 'preparing', pin = JSON.stringify(selection) + '\n', present = true, platform = 'win32', failure } = {}) {
  let resumed = 0, reads = 0
  const result = await vm.runInNewContext(`(async () => {${branch}; return 'first-use' })()`, {
    app: { isPackaged: true }, process: { platform }, pin, windowsRoot: path.resolve('/fixture/install'), path,
    existsSync: () => present, createRequire: () => () => ({ readDesktopRemoval: () => {
      reads++; if (failure) throw failure; return { phase, source_selection: selection }
    } }), bootUninstall: async () => { resumed++ },
  })
  return { result, resumed, reads }
}
for (const phase of ['preparing', 'stopping']) test('the original Windows GUI resumes existing removal before first-use/Core loading: ' + phase, async () => {
  assert.deepEqual(await run({ phase }), { result: undefined, resumed: 1, reads: 1 })
})
for (const phase of ['removing', 'completed']) test('the installed repair GUI retains its existing data-repair path: ' + phase, async () => {
  assert.deepEqual(await run({ phase }), { result: 'first-use', resumed: 0, reads: 1 })
})
test('a different target GUI does not impersonate the original removal source', async () => {
  assert.deepEqual(await run({ pin: JSON.stringify({ ...selection, gui_id: 'target' }) + '\n' }), { result: 'first-use', resumed: 0, reads: 1 })
})
test('ordinary first use and other platforms do not read a removal record', async () => {
  for (const options of [{ present: false }, { platform: 'darwin' }, { platform: 'linux' }]) {
    assert.deepEqual(await run(options), { result: 'first-use', resumed: 0, reads: 0 })
  }
})
test('an invalid private removal record preserves the concrete existing reader error', async () => {
  const failure = Object.assign(new Error('invalid private removal record'), { code: 'CRABOT_DESKTOP_REMOVAL' })
  await assert.rejects(run({ failure }), error => error === failure)
})
