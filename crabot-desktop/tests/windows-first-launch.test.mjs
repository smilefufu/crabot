import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { compareVersions } from '../dist/release-signatures.js'
const require = createRequire(import.meta.url), ts = require('typescript')
const source = readFileSync(new URL('../src/windows-first-launch.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
const root = path.resolve('/fixture/selected-programs'), old = path.resolve('/fixture/home/.crabot'), dataDir = path.join(old, 'data')
const selection = { schema_version: 1, version: '1.2.3', gui_id: 'fixture-gui', core_id: 'fixture-core' }
async function run({ initialized = false, legacy = false, source = false, cancel = false, bound = false, previousDesktop = false, previousVersion = '1.2.2', retained = false, pendingLocal = false, converted = false, progressEvents = [], programFailure } = {}) {
  const effects = [], messages = [], queries = []
  const own = { root, dataDir: pendingLocal ? path.join(root, 'data') : dataDir, record: { installation_id: 'fixture' } }
  const programs = { initialized, installRoot: root, selection, coreRoot: path.join(root, 'releases/core'), guiRoot: path.join(root, 'app/releases/gui'), ...(retained ? { removal: { phase: 'completed' } } : {}), ...(previousDesktop ? { source: { ...own, selection: { ...selection, version: previousVersion } } } : {}) }
  const original = { installation: { installRoot: old, dataRoot: dataDir, version: 'v2026.10.14.1' }, entryFenceId: 'previous-fence' }
  const modules = {
    'desktop-first-launch.mjs': {
      readFirstLaunchPrograms: async () => { progressEvents.push('read-programs'); if (programFailure) throw programFailure; return programs },
      bindFirstLaunchData: async (value, data) => { assert.ok(!previousDesktop || previousVersion !== '1.2.4', 'No binding writes on downgrade'); assert.equal(value, programs); effects.push(['bind', data]); return { ...own, dataDir: data, proof: { file: 'proof', sha256: 'digest' } } },
      completeImportedFirstLaunch: async (value, register) => { await register({ installRoot: root }); return value },
      completeFreshFirstLaunch: async (value, register) => { await register({ installRoot: root }); effects.push(['fresh', value.dataDir]); return value },
    },
    'desktop-installation.cjs': { default: { readDesktopInstallation: value => { assert.equal(value, root); return own }, locatePinnedDesktopGui: () => own } },
    'desktop-management.cjs': { default: { requireExistingDataRoot: value => { effects.push(['existing', value]); return value }, ensurePrivateDataRoot: value => { effects.push(['create', value]); return value }, readDesktopManagement: () => converted ? { schema_version: 1, install_kind: 'desktop', admin_listen_host: '127.0.0.1' } : null } },
    'desktop-data-import.mjs': { discoverDesktopDataSource: async value => { queries.push(value); return legacy ? original.installation : null },
      importDesktopData: async value => { effects.push(['import', value.source.dataRoot, value.target]); if (value.restartCopy) effects.push(['restart-copy']) }, forwardImportedWindowsCommand: async () => {} },
    'source-installation.mjs': { discoverUserSourceDeployment: () => source ? { root: '/fixture/source' } : null },
    'legacy-desktop-handoff.mjs': { runPreparedLegacyDesktopTakeover: async options => {
      effects.push(['legacy', options.prepared.installRoot, options.prepared.installation.dataRoot]); assert.equal(options.entryFenceId, original.entryFenceId)
      await options.registerEntries({ installRoot: options.prepared.installRoot })
    } },
  }
  const exports = {}
  vm.runInNewContext(compiled, { exports, AbortController, require: name => {
    if (name === 'node:path') return path
    if (name === './release-signatures.js') return { compareVersions }
    if (name === 'node:fs') return { existsSync: () => bound, promises: { readdir: async () => ['partial'], rm: () => assert.fail('GUI must not delete data outside the importer lock') } }
    if (name === './operation-progress-window.js') return { createOperationProgressWindow: () => {
      progressEvents.push('open'); return { ready: Promise.resolve().then(() => progressEvents.push('ready')),
        close() { progressEvents.push('close') }, update(message, cancellable) { progressEvents.push(['update', message, cancellable]) } }
    } }
    throw Error('Unexpected import: ' + name)
  } })
  const result = await exports.prepareWindowsFirstLaunch({ resources: '/fixture/resources', pinText: 'pin', home: path.dirname(old),
    load: async name => { assert.ok(modules[name], name); return modules[name] },
    registerEntries: async value => { effects.push(['register', value.installRoot]) },
    repairExisting: async value => { assert.equal(value, programs); effects.push(['repair', root]); return !cancel },
    upgradeExisting: async (prepared, source) => { effects.push(['update', prepared.installRoot, source.dataDir]); return !cancel },
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
  assert.ok(value.effects.some(effect => effect[0] === 'import' && effect[2] === path.join(root, 'data')), 'legacy data must be copied into the selected installation, not bound in place')
})
test('cancelling legacy data confirmation has no binding, migration, directory or registration effects', async () => {
  const value = await run({ legacy: true, cancel: true }); assert.equal(value.result, null); assert.deepEqual(value.effects, [])
})
test('a pending external first-use binding copies the original data after explicit confirmation', async () => {
  const value = await run({ legacy: true, bound: true })
  assert.equal(value.messages.length, 1); assert.equal(value.queries[0].root, old)
  assert.deepEqual(value.effects, [['create', path.join(root, 'data')], ['bind', path.join(root, 'data')], ['import', dataDir, path.join(root, 'data')], ['register', root]])
})


test('an existing GUI update uses its stopped-pair path and never asks to adopt legacy CLI data again', async () => {
  const value = await run({ previousDesktop: true })
  assert.deepEqual(value.queries, []); assert.deepEqual(value.messages, [])
  assert.deepEqual(value.effects, [['bind', dataDir], ['update', root, dataDir]])
})
test('cancelling an existing GUI update does not initialize a new instance or enter legacy conversion', async () => {
  const value = await run({ previousDesktop: true, cancel: true })
  assert.equal(value.result, null); assert.deepEqual(value.queries, [])
  assert.deepEqual(value.effects, [['bind', dataDir], ['update', root, dataDir]])
})

test('an older desktop package is rejected before binding or data conversion', async () => {
  await assert.rejects(run({ previousDesktop: true, previousVersion: '1.2.4' }), { code: 'CRABOT_DESKTOP_RELEASE_VERSION' })
})

for (const cancel of [false, true]) test('retained first use routes only to original data repair and never fresh or legacy admission; cancel=' + cancel, async () => {
  const value = await run({ retained: true, cancel })
  assert.deepEqual(value.effects, [['repair', root]]); assert.deepEqual(value.queries, [])
  if (cancel) assert.equal(value.result, null)
})

test('converted data resumes registration without rediscovering or copying the old installation', async () => {
  const value = await run({ bound: true, pendingLocal: true, converted: true, legacy: true })
  assert.deepEqual(value.queries, []); assert.deepEqual(value.messages, [])
  assert.deepEqual(value.effects, [['bind', path.join(root, 'data')], ['register', root]])
})

test('retry of an unfinished local copy delegates deletion to the importer under its lock', async () => {
  const value = await run({ bound: true, pendingLocal: true, legacy: true })
  assert.ok(value.effects.some(effect => effect[0] === 'restart-copy'))
  assert.equal(value.messages.length, 2)
})


test('first Windows launch presents preparation before reading the large candidate and closes it before proceeding', async () => {
  const progressEvents = []
  await run({ previousDesktop: true, progressEvents })
  assert.deepEqual(progressEvents.slice(0, 2), ['open', 'ready'])
  assert.equal(progressEvents[2][0], 'update')
  assert.match(progressEvents[2][1], /准备/)
  assert.equal(progressEvents[2][2], false)
  assert.deepEqual(progressEvents.slice(3), ['read-programs', 'close'])
})
test('a failed first-launch read closes preparation and preserves its actual error', async () => {
  const progressEvents = [], error = new Error('candidate file unreadable')
  await assert.rejects(run({ progressEvents, programFailure: error }), value => value === error)
  assert.deepEqual(progressEvents.slice(0, 2), ['open', 'ready'])
  assert.deepEqual(progressEvents.slice(3), ['read-programs', 'close'])
})
