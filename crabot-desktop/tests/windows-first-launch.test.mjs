import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url), ts = require('typescript')
const source = readFileSync(new URL('../src/windows-first-launch.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
const root = path.resolve('/fixture/selected-programs'), old = path.resolve('/fixture/home/.crabot'), dataDir = path.join(old, 'data')
const selection = { schema_version: 1, version: '1.2.3', gui_id: 'fixture-gui', core_id: 'fixture-core' }
async function run({ initialized = false, legacy = false, source = false, cancel = false, bound = false } = {}) {
  const effects = [], messages = [], queries = []
  const own = { root, dataDir, record: { installation_id: 'fixture' } }
  const programs = { initialized, installRoot: root, selection, coreRoot: path.join(root, 'releases/core'), guiRoot: path.join(root, 'app/releases/gui') }
  const original = { installation: { installRoot: old, dataRoot: dataDir, version: 'v2026.10.14.1' }, entryFenceId: 'previous-fence' }
  const modules = {
    'desktop-first-launch.mjs': {
      readFirstLaunchPrograms: async () => programs,
      bindFirstLaunchData: async (value, data) => { assert.equal(value, programs); effects.push(['bind', data]); return { ...own, dataDir: data, proof: { file: 'proof', sha256: 'digest' } } },
      completeFreshFirstLaunch: async (value, register) => { await register({ installRoot: root }); effects.push(['fresh', value.dataDir]); return value },
    },
    'desktop-installation.cjs': { default: { readDesktopInstallation: value => { assert.equal(value, root); return own }, locatePinnedDesktopGui: () => own } },
    'desktop-management.cjs': { default: { requireExistingDataRoot: value => { effects.push(['existing', value]); return value }, ensurePrivateDataRoot: value => { effects.push(['create', value]); return value }, readDesktopManagement: () => null } },
    'legacy-desktop-discovery.mjs': { discoverLegacyDesktopTakeover: async value => { queries.push(value); return legacy ? original : null } },
    'source-installation.mjs': { discoverUserSourceDeployment: () => source ? { root: '/fixture/source' } : null },
    'legacy-desktop-handoff.mjs': { runPreparedLegacyDesktopTakeover: async options => {
      effects.push(['legacy', options.prepared.installRoot, options.prepared.installation.dataRoot]); assert.equal(options.entryFenceId, original.entryFenceId)
      await options.registerEntries({ installRoot: options.prepared.installRoot })
    } },
  }
  const exports = {}
  vm.runInNewContext(compiled, { exports, AbortController, require: name => {
    if (name === 'node:path') return path
    if (name === 'node:fs') return { existsSync: () => bound }
    if (name === './operation-progress-window.js') return { createOperationProgressWindow: () => ({ ready: Promise.resolve(), close() {}, update() {} }) }
    throw Error('Unexpected import: ' + name)
  } })
  const result = await exports.prepareWindowsFirstLaunch({ resources: '/fixture/resources', pinText: 'pin', home: path.dirname(old),
    load: async name => { assert.ok(modules[name], name); return modules[name] },
    registerEntries: async value => { effects.push(['register', value.installRoot]) },
    dialog: { showMessageBox: async options => { messages.push(options); return { response: cancel ? 1 : 0 } }, showOpenDialog: () => assert.fail('No directory picker is needed for a verified release') } })
  return { result, effects, messages, queries }
}
test('an initialized Windows app opens without another installation or data prompt', async () => {
  const value = await run({ initialized: true }); assert.equal(value.result.initialized, true)
  assert.deepEqual(value.effects, []); assert.deepEqual(value.messages, []); assert.deepEqual(value.queries, [])
})
test('a source deployment remains independent and fresh GUI uses the selected program directory', async () => {
  const value = await run({ source: true })
  assert.deepEqual(value.queries, []); assert.deepEqual(value.messages, [])
  assert.deepEqual(value.effects, [['create', path.join(root, 'data')], ['bind', path.join(root, 'data')], ['register', root], ['fresh', path.join(root, 'data')]])
})
test('legacy data confirmation shows both locations, then registers the selected programs instead of copying into the old root', async () => {
  const value = await run({ legacy: true })
  assert.equal(value.messages.length, 1)
  assert.match(value.messages[0].detail, /v2026\.10\.14\.1/)
  assert.ok(value.messages[0].detail.includes(dataDir)); assert.ok(value.messages[0].detail.includes(root))
  assert.deepEqual(value.effects, [['existing', dataDir], ['bind', dataDir], ['legacy', root, dataDir], ['register', root]])
})
test('cancelling legacy data confirmation has no binding, migration, directory or registration effects', async () => {
  const value = await run({ legacy: true, cancel: true }); assert.equal(value.result, null); assert.deepEqual(value.effects, [])
})
test('a pending first launch resumes from the actual bound data without prompting for another directory', async () => {
  const value = await run({ legacy: true, bound: true })
  assert.equal(value.messages.length, 0); assert.equal(value.queries[0].root, old)
  assert.deepEqual(value.effects, [['bind', dataDir], ['legacy', root, dataDir], ['register', root]])
})
