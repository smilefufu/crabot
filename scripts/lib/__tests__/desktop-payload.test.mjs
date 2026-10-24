import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs, constants, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import asar from '@electron/asar'
import identity from '../process-identity.cjs'
import installation from '../desktop-installation.cjs'
import { writeCoreRelease, verifyCoreRelease } from '../core-release.mjs'
import { sealDesktopPayload, verifyDesktopPayload, prepareDesktopInstallation, commitDesktopInstallation } from '../desktop-payload.mjs'
const windows = process.platform === 'win32', launcher = windows ? 'crabot.exe' : 'crabot'
async function fixture(t, { version = '1.2.3', schema, functional = false } = {}) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'Crabot 离线安装 ')))
  t.after(() => fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const payload = path.join(parent, '离线包'), core = path.join(payload, 'core'), gui = path.join(payload, 'gui'), target = path.join(parent, '选择的 目录')
  const resources = path.join(gui, process.platform === 'darwin' ? 'Crabot.app/Contents/Resources' : 'resources')
  const exe = path.join(gui, process.platform === 'darwin' ? 'Crabot.app/Contents/MacOS/Crabot' : windows ? 'Crabot.exe' : 'crabot-desktop')
  await fs.mkdir(path.join(core, 'bin'), { recursive: true })
  const node = path.join(core, windows ? '.product-runtime/node/node.exe' : '.product-runtime/node/bin/node')
  await fs.mkdir(path.dirname(node), { recursive: true }); await fs.copyFile(process.execPath, node, constants.COPYFILE_FICLONE)
  await fs.copyFile(new URL('../../../crabot-native/build/Release/' + launcher, import.meta.url), path.join(core, 'bin', launcher))
  if (!windows) { await fs.chmod(node, 0o755); await fs.chmod(path.join(core, 'bin', launcher), 0o755) }
  for (const file of ['package.json', 'product-runtime.json']) await fs.writeFile(path.join(core, file), JSON.stringify({ version }))
  await fs.writeFile(path.join(core, 'cli.mjs'), `console.log(JSON.stringify({version:${JSON.stringify(version)},required:process.env.CRABOT_PRODUCT_REQUIRED}))`)
  if (schema) {
    await fs.mkdir(path.join(core, 'crabot-fixture/upgrade'), { recursive: true })
    await fs.writeFile(path.join(core, 'crabot-fixture/schema_version'), schema)
    await fs.writeFile(path.join(core, 'crabot-fixture/upgrade/scope.mjs'), `if(import.meta.url.includes('.preparing-pair-'))throw new Error('temporary migration path');export const migrationScope=()=>({reads:[],writes:['fixture/content']})`)
    await fs.writeFile(path.join(core, 'crabot-fixture/upgrade/from_v1_to_v2.mjs'), `throw new Error('online preparation must not run scripts')`)
  }
  if (functional) {
    // A finite Node migration fixture, not a full product environment. Other
    // command slots alias Node and are never executed by this acceptance.
    for (const name of ['lib', 'upgrade-lib']) {
      const from = fileURLToPath(new URL('../../../scripts/' + name, import.meta.url))
      await fs.cp(from, path.join(core, 'scripts', name), { recursive: true,
        filter: file => !path.relative(from, file).split(path.sep).some(part => ['__tests__', 'node_modules'].includes(part)) })
    }
    await fs.mkdir(path.join(core, 'scripts/desktop'), { recursive: true })
    for (const file of ['legacy-releases.json', 'legacy-python-bootstrap.json']) await fs.copyFile(new URL('../../desktop/' + file, import.meta.url), path.join(core, 'scripts/desktop', file))
    const native = path.join(core, 'crabot-native/build/Release/crabot-native.node')
    await fs.mkdir(path.dirname(native), { recursive: true })
    await fs.copyFile(new URL('../../../crabot-native/build/Release/crabot-native.node', import.meta.url), native)
    const relativeNode = path.relative(core, node).split(path.sep).join('/'), directory = path.posix.dirname(relativeNode)
    await fs.writeFile(path.join(core, 'product-runtime.json'), JSON.stringify({ schema_version: 1, version,
      platform: process.platform, arch: process.arch, versions: { node: process.versions.node, python: '3.12.12' },
      executables: Object.fromEntries(['node', 'python', 'uv', 'bash', 'git', 'rg'].map(name => [name, relativeNode])),
      path_entries: [directory], python_home: directory, memory_packages: directory, seed_wheels: [],
      files: { [relativeNode]: { size: (await fs.stat(node)).size, sha256: createHash('sha256').update(await fs.readFile(node)).digest('hex') } } }))
    // Keep the real parser self-contained in this minimal Node-only Core.
    const require = createRequire(import.meta.url)
    const tool = createRequire(new URL('../../../crabot-desktop/package.json', import.meta.url))
    const { build } = await import(pathToFileURL(tool.resolve('esbuild')).href)
    const parser = path.join(core, 'node_modules/@electron/asar')
    await fs.mkdir(parser, { recursive: true })
    await build({ entryPoints: [require.resolve('@electron/asar')], outfile: path.join(parser, 'index.cjs'), bundle: true,
      platform: 'node', format: 'cjs', external: ['original-fs'], logLevel: 'silent' })
    await fs.writeFile(path.join(parser, 'package.json'), JSON.stringify({ name: '@electron/asar', version: '3.4.1', main: 'index.cjs' }))
    await fs.writeFile(path.join(core, 'crabot-fixture/upgrade/scope.mjs'), `export const migrationScope=()=>({reads:[],writes:['fixture/content','fixture/executions']})`)
    await fs.writeFile(path.join(core, 'crabot-fixture/upgrade/from_v1_to_v2.mjs'),
      `import fs from 'node:fs';import path from 'node:path';const root=process.argv.find(arg=>arg.startsWith('--data-dir=')).slice(11);fs.writeFileSync(path.join(root,'content'),'converted by bundled Node');fs.appendFileSync(path.join(root,'executions'),'once\\n');`)
  }
  await writeCoreRelease(core, { schema_version: 1, version, platform: process.platform, arch: process.arch, commit: '1'.repeat(40), source_dirty: false })
  const release = await verifyCoreRelease(core), selection = { schema_version: 1, version, gui_id: randomUUID(), core_id: release.inventory_sha256 }
  await fs.writeFile(path.join(core, 'desktop-host.json'), JSON.stringify({ schema_version: 2, platform: process.platform, arch: process.arch }))
  await fs.mkdir(path.dirname(exe), { recursive: true }); await fs.mkdir(resources, { recursive: true })
  await fs.writeFile(exe, 'GUI fixture, never launched')
  const asarInput = path.join(parent, 'asar-input')
  await fs.mkdir(path.join(asarInput, 'dist'), { recursive: true })
  await fs.writeFile(path.join(asarInput, 'dist/desktop-release.json'), JSON.stringify(selection) + '\n')
  await asar.createPackage(asarInput, path.join(resources, 'app.asar'))
  const helper = path.join(resources, 'app.asar.unpacked/dist/bootstrap/crabot-native/build/Release/crabot-native.node')
  await fs.mkdir(path.dirname(helper), { recursive: true }); await fs.copyFile(new URL('../../../crabot-native/build/Release/crabot-native.node', import.meta.url), helper)
  await fs.writeFile(path.join(resources, 'desktop-release.json'), JSON.stringify(selection))
  await sealDesktopPayload(payload)
  return { parent, payload, core, gui, resources, selection, target }
}
test('complete offline payload prepares final stable roots and commits one pair without a service', async t => {
  const f = await fixture(t), phases = []
  const source = await verifyDesktopPayload(f.payload)
  assert.ok(source.bytes > 0n)
  const prepared = await prepareDesktopInstallation({ payload: f.payload, installRoot: f.target, progress: phase => phases.push(phase) })
  assert.deepEqual(phases, ['verifying', 'copying', 'prepared'])
  assert.equal((await verifyCoreRelease(prepared.coreRoot)).inventory_sha256, f.selection.core_id)
  assert.equal(prepared.coreRoot, path.join(f.target, 'releases', f.selection.core_id))
  assert.throws(() => installation.readDesktopSelection(f.target), { code: 'CRABOT_DESKTOP_INSTALLATION' })
  await assert.rejects(fs.lstat(path.join(f.target, 'current-release.json')), { code: 'ENOENT' })
  const selected = await commitDesktopInstallation(prepared)
  assert.equal(selected.coreRoot, prepared.coreRoot); assert.equal(selected.dataDir, path.join(f.target, 'data'))
  const result = await promisify(execFile)(selected.command, ['help'], { env: { ...process.env, PATH: '' } })
  assert.deepEqual(JSON.parse(result.stdout), { version: '1.2.3', required: '1' })
  await assert.rejects(fs.lstat(path.join(selected.dataDir, 'mm.pid')), { code: 'ENOENT' })
  await assert.rejects(fs.lstat(path.join(f.target, 'current-core')), { code: 'ENOENT' })
  await assert.rejects(prepareDesktopInstallation({ payload: f.payload, installRoot: f.target }), /已有已安装版本/)
})
test('changed payload, ordinary nonempty target, unsupported volume and insufficient space preserve the target', async t => {
  const f = await fixture(t), asar = path.join(f.resources, 'app.asar'), original = await fs.readFile(asar)
  await fs.writeFile(asar, 'changed GUI')
  await assert.rejects(prepareDesktopInstallation({ payload: f.payload, installRoot: f.target }), { code: 'CRABOT_CORE_INTEGRITY' })
  await assert.rejects(fs.lstat(f.target), { code: 'ENOENT' }); await fs.writeFile(asar, original)
  await fs.mkdir(f.target); await fs.writeFile(path.join(f.target, 'keep'), 'user files')
  await assert.rejects(prepareDesktopInstallation({ payload: f.payload, installRoot: f.target }), /不是空目录/)
  assert.equal(await fs.readFile(path.join(f.target, 'keep'), 'utf8'), 'user files'); await fs.rm(f.target, { recursive: true })
  const volume = t.mock.method(identity, 'inspectInstallFilesystem', () => ({ supported: false, filesystem: 'remote' }))
  await assert.rejects(prepareDesktopInstallation({ payload: f.payload, installRoot: f.target }), { code: 'CRABOT_INSTALL_FILESYSTEM' })
  await assert.rejects(fs.lstat(f.target), { code: 'ENOENT' }); volume.mock.restore()
  const space = t.mock.method(fs, 'statfs', async () => ({ bavail: 0n, bsize: 4096n }))
  await assert.rejects(prepareDesktopInstallation({ payload: f.payload, installRoot: f.target }), { code: 'CRABOT_UPDATE_SPACE' })
  await assert.rejects(fs.lstat(f.target), { code: 'ENOENT' }); space.mock.restore()
})
test('cancelled preparation is fenced and can be continued from the same complete offline payload', async t => {
  const f = await fixture(t), abort = new AbortController()
  await assert.rejects(prepareDesktopInstallation({ payload: f.payload, installRoot: f.target, signal: abort.signal, progress: phase => { if (phase === 'copying') abort.abort() } }), { name: 'AbortError' })
  await assert.rejects(fs.lstat(path.join(f.target, 'current-release.json')), { code: 'ENOENT' })
  assert.throws(() => installation.readDesktopSelection(f.target), { code: 'CRABOT_DESKTOP_INSTALLATION' })
  const prepared = await prepareDesktopInstallation({ payload: f.payload, installRoot: f.target })
  await commitDesktopInstallation(prepared)
  assert.equal(installation.readDesktopSelection(f.target).selection.core_id, f.selection.core_id)
})
test('changed prepared GUI is refused before selection; a commit interrupted after selection is resumable', async t => {
  const f = await fixture(t), prepared = await prepareDesktopInstallation({ payload: f.payload, installRoot: f.target })
  const resources = path.join(prepared.guiRoot, process.platform === 'darwin' ? 'Crabot.app/Contents/Resources' : 'resources'), file = path.join(resources, 'app.asar')
  const original = await fs.readFile(file); await fs.writeFile(file, 'changed after preparation')
  await assert.rejects(commitDesktopInstallation(prepared), /GUI 在提交前发生变化/)
  await assert.rejects(fs.lstat(path.join(f.target, 'current-release.json')), { code: 'ENOENT' })
  await fs.writeFile(file, original)
  const unlink = fs.unlink, fault = t.mock.method(fs, 'unlink', async name => {
    if (name === path.join(f.target, '.desktop-installing.json')) throw new Error('simulated interruption before installation fence removal')
    return unlink(name)
  })
  await assert.rejects(commitDesktopInstallation(prepared), /simulated interruption/); fault.mock.restore()
  assert.throws(() => installation.readDesktopSelection(f.target), { code: 'CRABOT_DESKTOP_INSTALLATION' })
  assert.equal((await commitDesktopInstallation(prepared)).selection.gui_id, f.selection.gui_id)
})

test('continuing an incomplete install repairs only its unselected program and preserves the damaged copy', async t => {
  const f = await fixture(t), prepared = await prepareDesktopInstallation({ payload: f.payload, installRoot: f.target })
  await fs.writeFile(path.join(prepared.coreRoot, 'cli.mjs'), 'damaged unselected program')
  const repaired = await prepareDesktopInstallation({ payload: f.payload, installRoot: f.target })
  const retained = (await fs.readdir(path.join(f.target, 'releases'))).find(name => name.startsWith('.damaged-'))
  assert.ok(retained)
  assert.equal(await fs.readFile(path.join(f.target, 'releases', retained, 'cli.mjs'), 'utf8'), 'damaged unselected program')
  await commitDesktopInstallation(repaired)
  assert.equal((await verifyCoreRelease(repaired.coreRoot)).inventory_sha256, f.selection.core_id)
})


test('paired update prepares final unselected programs and previews migrations while the old PID and data remain', async t => {
  const f = await fixture(t, { schema: 'v1' }), next = await fixture(t, { version: '1.2.4', schema: 'v2' })
  const installed = await prepareDesktopInstallation({ payload: f.payload, installRoot: f.target })
  const selected = await commitDesktopInstallation(installed)
  await fs.mkdir(path.join(selected.dataDir, 'fixture'))
  await fs.writeFile(path.join(selected.dataDir, 'fixture/SCHEMA_VERSION'), 'v1')
  await fs.writeFile(path.join(selected.dataDir, 'fixture/content'), 'USER DATA')
  await fs.writeFile(path.join(selected.dataDir, 'mm.pid'), String(process.pid))
  const { prepareDesktopPair } = await import('../desktop-pair-preparation.mjs')
  const prepared = await prepareDesktopPair({ payload: next.payload, installRoot: f.target })
  assert.deepEqual(prepared.source, f.selection); assert.deepEqual(prepared.selection, next.selection)
  assert.equal(prepared.coreRoot, path.join(f.target, 'releases', next.selection.core_id))
  assert.equal(prepared.guiRoot, path.join(f.target, 'app/releases', next.selection.gui_id))
  assert.equal(prepared.preview.modules[0].moduleId, 'crabot-fixture')
  assert.deepEqual(installation.readDesktopSelection(f.target).selection, f.selection)
  assert.equal(await fs.readFile(path.join(selected.dataDir, 'mm.pid'), 'utf8'), String(process.pid))
  assert.equal(await fs.readFile(path.join(selected.dataDir, 'fixture/content'), 'utf8'), 'USER DATA')
  assert.equal(await fs.readFile(path.join(selected.dataDir, 'fixture/SCHEMA_VERSION'), 'utf8'), 'v1')
  await assert.rejects(fs.stat(path.join(selected.dataDir, 'desktop-maintenance.json')), { code: 'ENOENT' })
  await assert.rejects(fs.stat(path.join(selected.dataDir, '.upgrade-migrations')), { code: 'ENOENT' })
  const copy = t.mock.method(fs, 'cp', async () => { throw new Error('cached complete programs must not be copied again') })
  try { assert.deepEqual((await prepareDesktopPair({ payload: next.payload, installRoot: f.target })).selection, next.selection) }
  finally { copy.mock.restore() }
})


async function installedPair(t) {
  const f = await fixture(t), next = await fixture(t, { version: '1.2.4' })
  const prepared = await prepareDesktopInstallation({ payload: f.payload, installRoot: f.target })
  const selected = await commitDesktopInstallation(prepared)
  await fs.writeFile(path.join(selected.dataDir, 'keep'), 'USER DATA')
  return { f, next, selected, prepare: (extra = {}) => import('../desktop-pair-preparation.mjs').then(({ prepareDesktopPair }) => prepareDesktopPair({ payload: next.payload, installRoot: f.target, ...extra })) }
}
for (const failure of ['payload', 'space']) {
  test('online pair preparation preserves the selected installation when ' + failure + ' fails', async t => {
    const { f, next, selected, prepare } = await installedPair(t)
    let space
    if (failure === 'payload') await fs.writeFile(path.join(next.resources, 'app.asar'), 'changed download')
    else space = t.mock.method(fs, 'statfs', async () => ({ bavail: 0n, bsize: 4096n }))
    try { await assert.rejects(prepare(), { code: failure === 'payload' ? 'CRABOT_CORE_INTEGRITY' : 'CRABOT_UPDATE_SPACE' }) }
    finally { space?.mock.restore() }
    assert.deepEqual(installation.readDesktopSelection(f.target).selection, f.selection)
    assert.equal(await fs.readFile(path.join(selected.dataDir, 'keep'), 'utf8'), 'USER DATA')
    await assert.rejects(fs.stat(path.join(f.target, 'releases', next.selection.core_id)), { code: 'ENOENT' })
  })
}
test('online preparation retains damaged cached programs rather than repairing or selecting them', async t => {
  const { f, selected, prepare } = await installedPair(t), cached = await prepare()
  await fs.writeFile(path.join(cached.coreRoot, 'cli.mjs'), 'DAMAGED RETAINED PROGRAM')
  await assert.rejects(prepare(), { code: 'CRABOT_CORE_INTEGRITY' })
  assert.deepEqual(installation.readDesktopSelection(f.target).selection, f.selection)
  assert.equal(await fs.readFile(path.join(cached.coreRoot, 'cli.mjs'), 'utf8'), 'DAMAGED RETAINED PROGRAM')
  assert.equal(await fs.readFile(path.join(selected.dataDir, 'keep'), 'utf8'), 'USER DATA')
})
test('a failed parallel copy is fully settled before only its own staging directory is removed', async t => {
  const { f, next, prepare } = await installedPair(t), cp = fs.cp, rm = fs.rm
  let guiFinished = false, cleanupObserved = false
  const copy = t.mock.method(fs, 'cp', async (from, ...args) => {
    if (String(from) === path.join(next.payload, 'core')) throw new Error('injected core copy failure')
    await new Promise(resolve => setTimeout(resolve, 40)); await cp(from, ...args); guiFinished = true
  })
  const cleanup = t.mock.method(fs, 'rm', async (file, ...args) => {
    if (path.basename(String(file)).startsWith('.preparing-pair-')) { cleanupObserved = true; assert.equal(guiFinished, true) }
    return rm(file, ...args)
  })
  try { await assert.rejects(prepare(), /injected core copy failure/) }
  finally { copy.mock.restore(); cleanup.mock.restore() }
  assert.equal(cleanupObserved, true)
  assert.deepEqual(installation.readDesktopSelection(f.target).selection, f.selection)
  assert.equal((await fs.readdir(f.target)).some(name => name.startsWith('.preparing-pair-')), false)
})
test('cancellation settles preparation without a data fence and can reuse the same complete payload', async t => {
  const { f, selected, prepare } = await installedPair(t), abort = new AbortController()
  await assert.rejects(prepare({ signal: abort.signal, progress: phase => { if (phase === 'copying') abort.abort() } }), { name: 'AbortError' })
  assert.deepEqual(installation.readDesktopSelection(f.target).selection, f.selection)
  assert.equal((await fs.readdir(f.target)).some(name => name.startsWith('.preparing-pair-')), false)
  await assert.rejects(fs.stat(path.join(selected.dataDir, 'desktop-maintenance.json')), { code: 'ENOENT' })
  await prepare()
})
test('changed selected pair during preview is refused without undoing another selector', async t => {
  const { f, next, selected, prepare } = await installedPair(t)
  await assert.rejects(prepare({ progress: phase => {
    if (phase === 'previewing') {
      // Synchronous metadata-only interference in the finite fixture.
      writeFileSync(path.join(f.target, 'current-release.json'), JSON.stringify(next.selection) + '\n')
    }
  } }), /当前安装或版本对发生变化/)
  assert.deepEqual(installation.readDesktopSelection(f.target).selection, next.selection)
  assert.equal(await fs.readFile(path.join(selected.dataDir, 'keep'), 'utf8'), 'USER DATA')
})
test('program mutation during preview cannot produce a successful preparation result', async t => {
  const { f, next, prepare } = await installedPair(t)
  const resources = path.join(f.target, 'app/releases', next.selection.gui_id, process.platform === 'darwin' ? 'Crabot.app/Contents/Resources' : 'resources')
  await assert.rejects(prepare({ progress: phase => {
    if (phase === 'previewing') writeFileSync(path.join(resources, 'app.asar'), 'CHANGED AFTER CHECK')
  } }), { code: 'CRABOT_CORE_INTEGRITY' })
  assert.deepEqual(installation.readDesktopSelection(f.target).selection, f.selection)
})


test('a new GUI reuses an identical selected Core without rewriting it or switching the source', async t => {
  const f = await fixture(t), next = await fixture(t)
  assert.equal(f.selection.core_id, next.selection.core_id)
  const installed = await prepareDesktopInstallation({ payload: f.payload, installRoot: f.target }), selected = await commitDesktopInstallation(installed)
  const before = await fs.stat(selected.coreRoot, { bigint: true }), cp = fs.cp
  const copy = t.mock.method(fs, 'cp', async (from, ...args) => {
    assert.notEqual(path.basename(String(from)), 'core', 'selected Core must only be verified')
    return cp(from, ...args)
  })
  let prepared
  try { prepared = await (await import('../desktop-pair-preparation.mjs')).prepareDesktopPair({ payload: next.payload, installRoot: f.target }) }
  finally { copy.mock.restore() }
  assert.equal(prepared.coreRoot, selected.coreRoot)
  assert.equal((await fs.stat(selected.coreRoot, { bigint: true })).ino, before.ino)
  assert.deepEqual(installation.readDesktopSelection(f.target).selection, f.selection)
})
test('a cached program proof binds the full payload and cannot be silently replaced', async t => {
  const { f, prepare } = await installedPair(t), prepared = await prepare()
  const bytes = await fs.readFile(prepared.proof.file)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), prepared.proof.sha256)
  await fs.appendFile(prepared.proof.file, ' ')
  await assert.rejects(prepare(), /完整清单无法核验/)
  assert.deepEqual(installation.readDesktopSelection(f.target).selection, f.selection)
  assert.equal(await fs.readFile(prepared.proof.file, 'utf8'), bytes.toString() + ' ')
})

async function stoppedPairFixture(t, { version = '1.2.4' } = {}) {
  const f = await fixture(t), source = await prepareDesktopInstallation({ payload: f.payload, installRoot: f.target })
  const current = await commitDesktopInstallation(source), next = await fixture(t, { version })
  await fs.mkdir(path.join(current.dataDir, 'admin'))
  await fs.writeFile(path.join(current.dataDir, 'admin/kept'), 'business data retained')
  const { prepareDesktopPair } = await import('../desktop-pair-preparation.mjs')
  const prepared = await prepareDesktopPair({ payload: next.payload, installRoot: f.target })
  const maintenance = await import('../version-maintenance.mjs')
  const { acquireCliLock, releaseCliLock } = await import('../cli-lock.mjs')
  const lock = await acquireCliLock(current.dataDir, 'pair-commit-fixture')
  let record, conversions = 0
  try {
    record = await maintenance.beginVersionMaintenance(current.dataDir, current.coreRoot, prepared.selection.version, current.selection.version, { dataProtection: 'scoped' })
    await maintenance.bindVersionMaintenanceTarget(current.dataDir, record.id, prepared.coreRoot)
    await maintenance.prepareScopedVersionMaintenance(current.dataDir, record.id)
    await maintenance.markVersionMaintenanceInstalling(current.dataDir, record.id)
    await maintenance.migrateStoppedVersionMaintenance({ dataDir: current.dataDir, root: prepared.coreRoot, id: record.id,
      migrate: async () => { conversions++ }, verifyComplete: async () => {} })
  } finally { releaseCliLock(lock) }
  const { commitPreparedDesktopPair } = await import('../desktop-pair-commit.mjs')
  const options = { maintenanceId: record.id, verifyData: async () => {
    const { previewMigrations } = await import('../../upgrade-lib/migrate.mjs')
    const preview = await previewMigrations(prepared.coreRoot, current.dataDir)
    return preview.modules.length === 0 && preview.shared.status === 'not_applicable'
  }, replaceEntries: async () => {} }
  return { ...f, current, prepared, record, options, maintenance, conversions: () => conversions,
    commit: (overrides = {}) => commitPreparedDesktopPair(prepared, { ...options, ...overrides }) }
}
test('stopped pair commit selects both exact programs and keeps protection until target health', async t => {
  const f = await stoppedPairFixture(t), { cliLockToken } = await import('../cli-lock.mjs')
  let replacements = 0
  const selected = await f.commit({ replaceEntries: async (source, target) => {
    replacements++
    assert.deepEqual(source.selection, f.current.selection); assert.equal(target, f.prepared)
    assert.ok(cliLockToken(path.join(f.target, 'cli.lock'))); assert.ok(cliLockToken(path.join(f.current.dataDir, 'cli.lock')))
  } })
  assert.deepEqual(selected.selection, f.prepared.selection)
  const native = await promisify(execFile)(selected.command, ['help'], { env: { ...process.env, PATH: '' } })
  assert.deepEqual(JSON.parse(native.stdout), { version: '1.2.4', required: '1' })
  assert.equal(f.maintenance.readVersionMaintenance(selected.dataDir).phase, 'verifying')
  assert.throws(() => f.maintenance.assertVersionMaintenanceAllowsStart(selected.dataDir), { code: 'CRABOT_MAINTENANCE_PENDING' })
  assert.equal(await fs.readFile(path.join(selected.dataDir, 'admin/kept'), 'utf8'), 'business data retained')
  await f.commit()
  assert.equal(replacements, 1); assert.equal(f.conversions(), 1)
  assert.equal(cliLockToken(path.join(f.target, 'cli.lock')), undefined)
  assert.equal(cliLockToken(path.join(selected.dataDir, 'cli.lock')), undefined)
  await assert.rejects(fs.stat(selected.dataDir + '.desktop-backups'), { code: 'ENOENT' })
  await assert.rejects(fs.stat(path.join(selected.dataDir, 'mm.pid')), { code: 'ENOENT' })
})
for (const changed of ['unfinished-phase', 'wrong-maintenance', 'active-pid', 'core', 'gui', 'proof', 'source', 'third-selection', 'data-proof', 'foreign-intent', 'selected-without-intent']) {
  test('pair commit preserves data and maintenance when preconditions fail: ' + changed, async t => {
    const f = await stoppedPairFixture(t), selector = path.join(f.target, 'current-release.json')
    let expected = await fs.readFile(selector, 'utf8'), overrides = {}, calls = 0
    if (changed === 'unfinished-phase') {
      const file = path.join(f.current.dataDir, 'desktop-maintenance.json'), record = f.maintenance.readVersionMaintenance(f.current.dataDir)
      await fs.writeFile(file, JSON.stringify({ ...record, phase: 'installing' }))
    } else if (changed === 'wrong-maintenance') overrides.maintenanceId = randomUUID()
    else if (changed === 'active-pid') await fs.writeFile(path.join(f.current.dataDir, 'mm.pid'), String(process.pid))
    else if (changed === 'core') await fs.appendFile(path.join(f.prepared.coreRoot, 'package.json'), ' ')
    else if (changed === 'gui') await fs.appendFile(path.join(f.prepared.guiRoot, process.platform === 'darwin' ? 'Crabot.app/Contents/Resources/app.asar' : 'resources/app.asar'), 'changed')
    else if (changed === 'proof') await fs.appendFile(f.prepared.proof.file, ' ')
    else if (changed === 'source') f.prepared.source = { ...f.prepared.source, gui_id: randomUUID() }
    else if (changed === 'data-proof') overrides.verifyData = async () => false
    else if (changed === 'foreign-intent') {
      const management = (await import('../desktop-management.cjs')).default
      const parent = management.ensurePrivateDataRoot(path.join(f.target, 'app/updates'))
      const directory = management.ensurePrivateDataRoot(path.join(parent, f.record.id)), file = path.join(directory, 'selection.json')
      if (windows) identity.writePrivateFile(file, '{"foreign":true}\n')
      else await fs.writeFile(file, '{"foreign":true}\n', { mode: 0o600 })
    } else {
      expected = JSON.stringify(changed === 'third-selection' ? { ...f.current.selection, gui_id: randomUUID() } : f.prepared.selection) + '\n'
      await fs.writeFile(selector, expected)
    }
    await assert.rejects(f.commit({ ...overrides, replaceEntries: async () => { calls++ } }))
    assert.equal(calls, 0); assert.equal(await fs.readFile(selector, 'utf8'), expected)
    assert.equal(f.maintenance.readVersionMaintenance(f.current.dataDir).id, f.record.id)
    assert.equal(await fs.readFile(path.join(f.current.dataDir, 'admin/kept'), 'utf8'), 'business data retained')
  })
}
test('failed OS entry replacement retains its intent and can finish the same stopped pair without reconversion', async t => {
  const f = await stoppedPairFixture(t)
  let calls = 0
  await assert.rejects(f.commit({ replaceEntries: async () => { calls++; throw new Error('OS response lost') } }), /OS response lost/)
  assert.deepEqual(installation.readDesktopSelection(f.target).selection, f.current.selection)
  const journal = path.join(f.target, 'app/updates', f.record.id, 'selection.json'), before = await fs.readFile(journal)
  await f.commit({ replaceEntries: async () => { calls++ } })
  assert.equal(calls, 2); assert.deepEqual(await fs.readFile(journal), before)
  assert.equal(f.conversions(), 1); assert.equal(f.maintenance.readVersionMaintenance(f.current.dataDir).phase, 'verifying')
})
for (const changed of ['program', 'intent', 'maintenance', 'lock']) test('pair commit checks again after OS entry work: ' + changed, async t => {
  const f = await stoppedPairFixture(t)
  await assert.rejects(f.commit({ replaceEntries: async () => {
    if (changed === 'program') await fs.appendFile(path.join(f.prepared.coreRoot, 'package.json'), ' ')
    else if (changed === 'intent') await fs.appendFile(path.join(f.target, 'app/updates', f.record.id, 'selection.json'), ' ')
    else if (changed === 'lock') {
      const { releaseCliLock } = await import('../cli-lock.mjs'); releaseCliLock(path.join(f.current.dataDir, 'cli.lock'))
    } else {
      const file = path.join(f.current.dataDir, 'desktop-maintenance.json'), record = f.maintenance.readVersionMaintenance(f.current.dataDir)
      await fs.writeFile(file, JSON.stringify({ ...record, id: randomUUID() }))
    }
  } }))
  assert.deepEqual(installation.readDesktopSelection(f.target).selection, f.current.selection)
  assert.throws(() => f.maintenance.assertVersionMaintenanceAllowsStart(f.current.dataDir), { code: 'CRABOT_MAINTENANCE_PENDING' })
})
test('pair selector rename with a lost reply can be verified and retried without opening old data', async t => {
  const f = await stoppedPairFixture(t), rename = fs.rename, selector = path.join(f.target, 'current-release.json')
  let lost = false
  const fault = t.mock.method(fs, 'rename', async (...args) => {
    await rename(...args)
    if (args[1] === selector && !lost) { lost = true; throw new Error('selector reply lost') }
  })
  try { await assert.rejects(f.commit(), /selector reply lost/) } finally { fault.mock.restore() }
  assert.equal(lost, true); assert.deepEqual(installation.readDesktopSelection(f.target).selection, f.prepared.selection)
  assert.throws(() => f.maintenance.assertVersionMaintenanceAllowsStart(f.current.dataDir), { code: 'CRABOT_MAINTENANCE_PENDING' })
  await f.commit()
  assert.equal(f.conversions(), 1)
  assert.equal(f.maintenance.readVersionMaintenance(f.current.dataDir).phase, 'verifying')
})

test('a changed maintenance fence discovered during final data verification cannot publish a new pair', async t => {
  const f = await stoppedPairFixture(t)
  let calls = 0
  await assert.rejects(f.commit({ verifyData: async () => {
    if (++calls === 2) {
      const file = path.join(f.current.dataDir, 'desktop-maintenance.json'), record = f.maintenance.readVersionMaintenance(f.current.dataDir)
      await fs.writeFile(file, JSON.stringify({ ...record, id: randomUUID() }))
    }
    return true
  } }))
  assert.deepEqual(installation.readDesktopSelection(f.target).selection, f.current.selection)
})
test('pair intent parent publication must be durable before OS entries or selector changes', { skip: windows }, async t => {
  const f = await stoppedPairFixture(t), open = fs.open, parent = path.join(f.target, 'app/updates')
  let reached = false, entries = false
  const fault = t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args)
    if (args[0] === parent) t.mock.method(handle, 'sync', async () => { reached = true; throw new Error('intent parent flush failed') })
    return handle
  })
  try { await assert.rejects(f.commit({ replaceEntries: async () => { entries = true } }), /intent parent flush failed/) }
  finally { fault.mock.restore() }
  assert.equal(reached, true); assert.equal(entries, false)
  assert.deepEqual(installation.readDesktopSelection(f.target).selection, f.current.selection)
  assert.equal(f.maintenance.readVersionMaintenance(f.current.dataDir).phase, 'verifying')
})


test('a GUI-only pair update reuses the selected immutable Core while replacing the GUI identity', async t => {
  const f = await stoppedPairFixture(t, { version: '1.2.3' })
  assert.equal(f.prepared.coreRoot, f.current.coreRoot)
  const before = await fs.stat(f.current.coreRoot, { bigint: true })
  const selected = await f.commit()
  assert.equal(selected.coreRoot, f.current.coreRoot)
  assert.notEqual(selected.selection.gui_id, f.current.selection.gui_id)
  assert.equal((await fs.stat(f.current.coreRoot, { bigint: true })).ino, before.ino)
  assert.equal(f.maintenance.readVersionMaintenance(f.current.dataDir).phase, 'verifying')
})


test('actual GUI controller runs one scoped Node conversion and commits the stopped pair while retaining protection', { skip: process.env.CRABOT_PAIRED_CONTROLLER_TEST !== '1', timeout: 90_000 }, async t => {
  const f = await fixture(t, { functional: true, schema: 'v1' })
  const initial = await prepareDesktopInstallation({ payload: f.payload, installRoot: f.target }), current = await commitDesktopInstallation(initial)
  await fs.mkdir(path.join(current.dataDir, 'fixture'))
  await fs.writeFile(path.join(current.dataDir, 'fixture/SCHEMA_VERSION'), 'v1')
  await fs.writeFile(path.join(current.dataDir, 'fixture/content'), 'before')
  const next = await fixture(t, { version: '1.2.4', functional: true, schema: 'v2' })
  const { prepareDesktopPair } = await import('../desktop-pair-preparation.mjs')
  const prepared = await prepareDesktopPair({ payload: next.payload, installRoot: f.target })
  // Explicitly run after desktop TypeScript compilation; the earlier generic
  // runtime stage does not have dist/controller.js on a clean checkout.
  // Target native DLLs are loaded in this child, which exits before Windows
  // cleanup. No MM, GUI, model or system registration is started here.
  const module = pathToFileURL(fileURLToPath(new URL('../../../crabot-desktop/dist/controller.js', import.meta.url))).href
  const code = `import {DesktopController} from ${JSON.stringify(module)};const [prepared,current]=JSON.parse(process.argv[1]);const c=new DesktopController({coreRoot:current.coreRoot,dataRoot:current.dataDir,appVersion:current.selection.version,platform:process.platform});c.host.status('stopped');let entries=0;try{const selected=await c.applyPreparedPair(prepared,async()=>{entries++});console.log('PAIRED_CONTROLLER '+JSON.stringify({entries,phase:c.host.snapshot().phase,dataDir:selected.dataDir}));}finally{c.close()}`
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code, JSON.stringify([prepared, current])],
    { env: { ...process.env, PATH: '' }, timeout: 45_000, maxBuffer: 64 * 1024 })
  const evidence = JSON.parse(result.stdout.split('\n').find(line => line.startsWith('PAIRED_CONTROLLER ')).slice('PAIRED_CONTROLLER '.length))
  assert.deepEqual(evidence, { entries: 1, phase: 'stopped', dataDir: current.dataDir })
  assert.deepEqual(installation.readDesktopSelection(f.target).selection, prepared.selection)
  assert.equal(await fs.readFile(path.join(current.dataDir, 'fixture/content'), 'utf8'), 'converted by bundled Node')
  assert.equal(await fs.readFile(path.join(current.dataDir, 'fixture/SCHEMA_VERSION'), 'utf8'), 'v2\n')
  assert.equal(await fs.readFile(path.join(current.dataDir, 'fixture/executions'), 'utf8'), 'once\n')
  const base = path.join(current.dataDir, '.upgrade-migrations/crabot-fixture-v1-v2')
  assert.equal(await fs.readFile(path.join(base, 'backup/fixture/content'), 'utf8'), 'before')
  assert.equal(JSON.parse(await fs.readFile(path.join(base, 'state.json'), 'utf8')).phase, 'completed')
  assert.equal(JSON.parse(await fs.readFile(path.join(current.dataDir, 'desktop-maintenance.json'), 'utf8')).phase, 'verifying')
  await assert.rejects(fs.stat(current.dataDir + '.desktop-backups'), { code: 'ENOENT' })
  await assert.rejects(fs.stat(path.join(current.dataDir, 'mm.pid')), { code: 'ENOENT' })
})

test('signed complete release intake reaches actual online preparation without stopping or migrating the old instance', { skip: !process.env.CRABOT_TEST_PYTHON }, async t => {
  const f = await fixture(t, { schema: 'v1' }), next = await fixture(t, { version: '1.2.4', schema: 'v2' })
  const installed = await prepareDesktopInstallation({ payload: f.payload, installRoot: f.target }), selected = await commitDesktopInstallation(installed)
  await fs.mkdir(path.join(selected.dataDir, 'fixture'))
  await fs.writeFile(path.join(selected.dataDir, 'fixture/SCHEMA_VERSION'), 'v1')
  await fs.writeFile(path.join(selected.dataDir, 'fixture/content'), 'USER DATA')
  await fs.writeFile(path.join(selected.dataDir, 'mm.pid'), String(process.pid))
  const { generateKeyPairSync } = await import('node:crypto'), keys = generateKeyPairSync('ed25519')
  const require = createRequire(new URL('../../../crabot-admin/package.json', import.meta.url)), AdmZip = require('adm-zip'), zip = new AdmZip()
  async function add(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) await add(file)
      else zip.addFile(path.relative(next.payload, file).split(path.sep).join('/'), await fs.readFile(file), '', (await fs.stat(file)).mode)
    }
  }
  await add(next.payload)
  const bytes = zip.toBuffer(), artifact = path.join(next.parent, 'Crabot.zip'); await fs.writeFile(artifact, bytes, { mode: 0o600 })
  const { signDesktopReleaseManifest } = await import('../../desktop/sign-release.mjs')
  const signed = signDesktopReleaseManifest({ schema_version: 1, app_id: 'com.crabot.desktop', platform: process.platform, arch: process.arch,
    selection: next.selection, artifact: { file: 'Crabot.zip', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } },
  [keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()])
  const { createDesktopReleaseIntake } = await import('../../../crabot-desktop/dist/release-intake.js')
  const { prepareDesktopPair } = await import('../desktop-pair-preparation.mjs')
  let prepared
  const intake = createDesktopReleaseIntake({ pinnedPublicKeys: [keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()],
    python: process.env.CRABOT_TEST_PYTHON, cacheRoot: path.join(f.target, 'data/signed-cache'), verifyPayload: verifyDesktopPayload,
    preparePair: async options => { prepared = await prepareDesktopPair(options); return prepared } })
  const { createDesktopReleaseDownloader } = await import('../../../crabot-desktop/dist/release-download.js')
  const downloader = createDesktopReleaseDownloader({ pinnedPublicKeys: [keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()],
    platform: process.platform, arch: process.arch, cacheRoot: path.join(f.target, 'data/download-cache'),
    fetch: async url => new Response(url.endsWith('.manifest.json') ? signed.manifest : url.endsWith('.signatures.json') ? signed.signatures : bytes) })
  const { createPairedUpdateDriver } = await import('../../../crabot-desktop/dist/paired-update.js')
  const driver = createPairedUpdateDriver({ platform: process.platform, arch: process.arch, downloader, intake,
    current: () => { const value = installation.readDesktopSelection(f.target); return { installRoot: value.root,
      installation_id: value.record.installation_id, selection: value.selection, coreRoot: value.coreRoot, guiRoot: value.guiRoot } },
    preparePlatform: async () => { throw Object.assign(new Error('Controlled stop before OS authorization or maintenance'), { code: 'PRE_STOP_FIXTURE' }) },
    apply: async () => { throw new Error('Live fixture instance must never be stopped') }, handoff: async () => { throw new Error('No GUI handoff in preparation fixture') } })
  t.after(() => driver.close())
  const candidate = await driver.check(() => {})
  assert.deepEqual(candidate, { kind: 'paired', version: next.selection.version })
  await assert.rejects(fs.lstat(path.join(f.target, 'releases', next.selection.core_id)), { code: 'ENOENT' })
  await assert.rejects(driver.install(candidate), { code: 'PRE_STOP_FIXTURE' })
  assert.deepEqual(prepared.source, f.selection); assert.deepEqual(prepared.selection, next.selection)
  assert.equal(prepared.coreRoot, path.join(f.target, 'releases', next.selection.core_id))
  assert.equal(prepared.guiRoot, path.join(f.target, 'app/releases', next.selection.gui_id))
  assert.equal(prepared.preview.modules[0].moduleId, 'crabot-fixture')
  assert.deepEqual(installation.readDesktopSelection(f.target).selection, f.selection)
  assert.equal(await fs.readFile(path.join(selected.dataDir, 'mm.pid'), 'utf8'), String(process.pid))
  assert.equal(await fs.readFile(path.join(selected.dataDir, 'fixture/content'), 'utf8'), 'USER DATA')
  assert.equal(await fs.readFile(path.join(selected.dataDir, 'fixture/SCHEMA_VERSION'), 'utf8'), 'v1')
  for (const name of ['desktop-maintenance.json', '.upgrade-migrations']) await assert.rejects(fs.lstat(path.join(selected.dataDir, name)), { code: 'ENOENT' })
  assert.deepEqual(await fs.readdir(path.join(f.target, 'data/signed-cache')), [])
  assert.equal((await fs.readdir(path.join(f.target, 'data/download-cache'))).length, 1, 'retry keeps the authenticated archive')
})
