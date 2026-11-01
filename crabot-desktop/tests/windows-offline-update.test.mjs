import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const require = createRequire(import.meta.url), ts = require('typescript')
const file = new URL('../src/windows-offline-update.ts', import.meta.url)
const sourceText = readFileSync(file, 'utf8').replaceAll('import.meta.url', JSON.stringify(file.href))
const compiled = ts.transpileModule(sourceText, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText

async function run({ guiRunning = false, coreRunning = false, cancel = false, imageQueryIncomplete = false, changedBinding = false } = {}) {
  const effects = [], queries = [], messages = []
  const source = { root: path.resolve('/fixture/app'), guiRoot: path.resolve('/fixture/app/old-gui'),
    coreRoot: path.resolve('/fixture/app/old-core'), executable: path.resolve('/fixture/app/old-gui/Crabot.exe'),
    dataDir: path.resolve('/fixture/data'), selection: { version: '0.1.0-desktop.14', core_id: 'old-core' }, record: { installation_id: 'same-installation' } }
  const prepared = { installRoot: source.root, selection: { version: '0.1.0-desktop.15' } }
  const modules = {
    'instance-runtime.mjs': { inspectInstance: () => ({ state: coreRunning ? 'running' : 'stopped' }) },
    'core-release.mjs': { verifyCoreRelease: async () => ({ inventory_sha256: 'old-core' }) },
  }
  const identity = { inspectProgramReferences: async query => {
    queries.push(query)
    // An unavailable Restart Manager file-resource query says nothing about
    // whether the old GUI is running; the immutable old files are not removed.
    if (query.files.length || imageQueryIncomplete) return { complete: false, incomplete: true, unknown_pids: [], processes: [] }
    return { complete: true, incomplete: false, unknown_pids: [], processes: guiRunning ? [{ pid: 123, executable: source.executable }] : [] }
  } }
  const desktop = { readDesktopSelection: () => ({ ...source, selection: changedBinding ? { version: 'another' } : source.selection }) }
  const resolve = name => {
    if (name.includes('process-identity.cjs')) return identity
    if (name.includes('desktop-installation.cjs')) return desktop
    const imported = name.startsWith('file:') ? path.basename(new URL(name).pathname) : ''
    if (modules[imported]) return modules[imported]
    throw new Error('Unexpected bootstrap module: ' + name)
  }
  class Controller {
    constructor(options) { this.options = options; this.host = { status() {} } }
    async applyPreparedPair(value, register) { this.options.verifyBinding(); effects.push('apply'); assert.equal(value, prepared); await register(source, prepared) }
    close() { effects.push('controller-closed') }
  }
  const exports = {}
  vm.runInNewContext(compiled, { exports, URL, AbortController, process: { env: {} }, require: name => {
    if (name === 'node:path') return path
    if (name === 'node:url') return { pathToFileURL }
    if (name === 'node:module') return { createRequire: () => resolve }
    if (name === './controller.js') return { DesktopController: Controller }
    if (name === './login-startup.js') return { LoginStartup: class {} }
    if (name === './operation-progress-window.js') return { createOperationProgressWindow: () => ({ ready: Promise.resolve(), update() {}, close() { effects.push('progress-closed') } }) }
    if (name === './installation-entries.js') return { replaceInstallationEntries: async () => { effects.push('entries') } }
    return resolve(name)
  } })
  let result, error
  try {
    result = await exports.applyWindowsOfflineUpdate({ source, prepared, home: path.resolve('/fixture/home'), app: {}, shell: {},
      dialog: { showMessageBox: async options => { messages.push(options); guiRunning = coreRunning = false; return { response: cancel ? 1 : 0 } } } })
  } catch (cause) { error = cause }
  return { result, error, effects, queries, messages }
}

test('a stopped prior GUI updates without requiring a file-holder scan of immutable old programs', async () => {
  const value = await run()
  assert.ifError(value.error)
  assert.equal(value.result, true)
  assert.equal(value.queries.length, 1)
  assert.deepEqual(Array.from(value.queries[0].files), [])
  assert.ok(value.effects.includes('apply'))
})
for (const kind of ['guiRunning', 'coreRunning']) test('an actual old ' + kind + ' must exit before update', async () => {
  const value = await run({ [kind]: true })
  assert.ifError(value.error); assert.equal(value.result, true)
  assert.equal(value.messages.length, 1); assert.equal(value.queries.length, 2)
  assert.ok(value.effects.includes('apply'))
})
test('cancelling while the original GUI is alive does not update or replace entries', async () => {
  const value = await run({ guiRunning: true, cancel: true })
  assert.ifError(value.error); assert.equal(value.result, false); assert.deepEqual(value.effects, [])
})
test('an incomplete GUI-image observation still blocks conversion', async () => {
  const value = await run({ imageQueryIncomplete: true })
  assert.match(value.error?.message || '', /旧版应用退出状态尚未核实/)
  assert.deepEqual(value.effects, [])
})
test('the stopped-pair coordinator still rejects a changed original installation binding', async () => {
  const value = await run({ changedBinding: true })
  assert.match(value.error?.message || '', /原版本选择已变化/)
  assert.ok(!value.effects.includes('apply')); assert.ok(value.effects.includes('progress-closed'))
})
