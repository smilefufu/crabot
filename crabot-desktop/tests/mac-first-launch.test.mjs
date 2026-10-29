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
