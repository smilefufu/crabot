import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import binding from '../../scripts/lib/mac-app-binding.cjs'
const require = createRequire(import.meta.url), ts = require('typescript')
const source = readFileSync(new URL('../src/mac-first-launch.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
const exports = {}; vm.runInNewContext(compiled, { exports, require, Error })
const mac = { skip: process.platform !== 'darwin' }
function fixture(t, { response = 0, readOnly = false, chosen } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'crabot-Mac-first-'))), home = join(root, 'home'), appPath = join(root, 'Crabot.app')
  const coreRoot = join(appPath, 'Contents/Resources/core'); mkdirSync(coreRoot, { recursive: true }); mkdirSync(home)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const messages = [], directories = [], stages = []
  const options = { home, appPath, coreRoot, version: '0.1.0', dialog: {
    showMessageBox: async value => { messages.push(value); return { response } },
    showOpenDialog: async value => { directories.push(value); return chosen ? { canceled: false, filePaths: [chosen] } : { canceled: true, filePaths: [] } },
  }, load: async name => {
    if (name === 'core-release.mjs') return { verifyCoreRelease: async (root, options) => { stages.push('verified'); assert.equal(root, coreRoot); assert.equal(options.version, '0.1.0') } }
    if (name === 'process-identity.cjs' && readOnly) return { default: { inspectInstallFilesystem: () => ({ supported: false }) } }
    return import(new URL('../../scripts/lib/' + name, import.meta.url))
  } }
  return { root, options, home, appPath, messages, directories, stages }
}
test('cancel and read-only DMG do not initialize business data or publish a locator', mac, async t => {
  for (const settings of [{ response: 2 }, { readOnly: true }, { response: 1 }]) {
    const f = fixture(t, settings)
    assert.equal(await exports.prepareMacAppData(f.options), null)
    assert.equal(existsSync(binding.bindingFile(f.home)), false)
    assert.equal(existsSync(join(f.home, 'Library/Application Support/Crabot/data')), false)
    if (settings.readOnly) { assert.equal(f.stages.length, 0); assert.match(f.messages[0].message, /拖到 Applications/) }
  }
})
test('default first launch creates only external data and reopen uses the same data without dialogs', mac, async t => {
  const f = fixture(t)
  const selected = await exports.prepareMacAppData(f.options)
  assert.equal(selected, join(f.home, 'Library/Application Support/Crabot/data'))
  assert.equal(existsSync(join(selected, 'desktop-managed.json')), true)
  assert.equal(existsSync(join(selected, 'Contents')), false)
  const count = f.messages.length
  assert.equal(await exports.prepareMacAppData(f.options), selected)
  assert.equal(f.messages.length, count)
  assert.equal(binding.readMacAppBinding({ home: f.home }).app_path, f.appPath)
})
test('native picker includes hidden directories and unknown source data is preserved rather than adopted', mac, async t => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'crabot-old-data-')))
  t.after(() => rmSync(temporary, { recursive: true, force: true }))
  const chosen = join(temporary, '.source-data'); mkdirSync(chosen); writeFileSync(join(chosen, 'old-history'), 'retain')
  const f = fixture(t, { response: 1, chosen })
  await assert.rejects(exports.prepareMacAppData(f.options), { code: 'CRABOT_DESKTOP_TAKEOVER_REQUIRED' })
  assert.equal(readFileSync(join(chosen, 'old-history'), 'utf8'), 'retain')
  assert.ok(f.directories[0].properties.includes('showHiddenFiles'))
  assert.equal(existsSync(binding.bindingFile(f.home)), false)
})

test('supported legacy release needs explicit consent and retains the original data instead of installing another App', mac, async t => {
  const f = fixture(t), oldRoot = join(f.root, 'old'), dataRoot = join(oldRoot, 'data')
  mkdirSync(dataRoot, { recursive: true }); writeFileSync(join(dataRoot, 'old-chat'), 'keep')
  const calls = []
  f.options.discoverLegacy = async () => ({ installation: { installRoot: oldRoot, dataRoot, version: 'v2026.10.15.1' } })
  f.options.adoptLegacy = async (root, data) => { calls.push([root, data]); assert.equal(binding.readMacAppBinding({ home: f.home }).data_dir, dataRoot) }
  assert.equal(await exports.prepareMacAppData(f.options), dataRoot)
  assert.equal(calls.length, 1); assert.equal(f.messages[0].title, '接入已有 Crabot')
  assert.equal(readFileSync(join(dataRoot, 'old-chat'), 'utf8'), 'keep')
  assert.equal(existsSync(join(dataRoot, 'Contents')), false)
})
test('canceling legacy admission neither binds nor converts old data', mac, async t => {
  const f = fixture(t, { response: 2 }), oldRoot = join(f.root, 'old'), dataRoot = join(oldRoot, 'data')
  mkdirSync(dataRoot, { recursive: true })
  f.options.discoverLegacy = async () => ({ installation: { installRoot: oldRoot, dataRoot, version: 'v2026.10.15.1' } })
  f.options.adoptLegacy = async () => { throw new Error('must not convert after cancellation') }
  assert.equal(await exports.prepareMacAppData(f.options), null)
  assert.equal(existsSync(binding.bindingFile(f.home)), false)
})

test('unresolved original location offers a hidden-folder picker before legacy admission', mac, async t => {
  const f = fixture(t), oldRoot = join(f.root, '.old-install'), dataRoot = join(oldRoot, 'data')
  mkdirSync(dataRoot, { recursive: true }); let discoveries = 0, adopted = 0
  f.options.discoverLegacy = async () => { if (++discoveries === 1) throw new Error('原程序位置尚未确定'); return { installation: { installRoot: oldRoot, dataRoot, version: 'v2026.10.15.1' } } }
  f.options.dialog.showMessageBox = async value => { f.messages.push(value); return { response: value.title === '核对已有数据' ? 1 : 0 } }
  f.options.dialog.showOpenDialog = async value => { f.directories.push(value); return { canceled: false, filePaths: [oldRoot] } }
  f.options.adoptLegacy = async () => { adopted++ }
  assert.equal(await exports.prepareMacAppData(f.options), dataRoot)
  assert.equal(discoveries, 2); assert.equal(adopted, 1)
  assert.ok(f.directories[0].properties.includes('showHiddenFiles'))
})
test('bound interrupted admission cannot fall back to creating independent empty data', mac, async t => {
  const f = fixture(t), dataRoot = join(f.root, 'old-data'); mkdirSync(dataRoot)
  binding.writeMacAppBinding({ home: f.home, appPath: f.appPath, dataDir: dataRoot })
  f.options.discoverLegacy = async () => { throw new Error('原维护仍需核验') }
  await assert.rejects(exports.prepareMacAppData(f.options), /原维护仍需核验/)
  assert.equal(f.messages.length, 0)
  assert.equal(binding.readMacAppBinding({ home: f.home }).data_dir, dataRoot)
})
