import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs, constants, writeFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import asar from '@electron/asar'
import identity from '../process-identity.cjs'
import { stoppedLegacyModules } from './fixtures/stopped-legacy-modules.mjs'
import installation from '../desktop-installation.cjs'
import { writeCoreRelease, verifyCoreRelease } from '../core-release.mjs'
import { sealDesktopPayload, verifyDesktopPayload, prepareDesktopInstallation, commitDesktopInstallation } from '../desktop-payload.mjs'
const windows = process.platform === 'win32', launcher = windows ? 'crabot.exe' : 'crabot'
async function fixture(t, { version = '1.2.3', schema, functional = false, executableNode = true, shared = false, launcherSuffix = '', conversionFailure = false, coreTamper = false, realPython = false } = {}) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'Crabot 离线安装 ')))
  t.after(() => fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const payload = path.join(parent, '离线包'), core = path.join(payload, 'core'), gui = path.join(payload, 'gui'), target = path.join(parent, '选择的 目录')
  const resources = path.join(gui, process.platform === 'darwin' ? 'Crabot.app/Contents/Resources' : 'resources')
  const exe = path.join(gui, process.platform === 'darwin' ? 'Crabot.app/Contents/MacOS/Crabot' : windows ? 'Crabot.exe' : 'crabot-desktop')
  await fs.mkdir(path.join(core, 'bin'), { recursive: true })
  const node = path.join(core, windows ? '.product-runtime/node/node.exe' : '.product-runtime/node/bin/node')
  await fs.mkdir(path.dirname(node), { recursive: true })
  // Byte-only proof/repair cases never execute Core. Keep actual official Node
  // for native CLI launches, migrations and all functional runtime fixtures.
  if (executableNode || functional) await fs.copyFile(process.execPath, node, constants.COPYFILE_FICLONE)
  else await fs.writeFile(node, 'inert Node bytes; never executed\n')
  await fs.copyFile(new URL('../../../crabot-native/build/Release/' + launcher, import.meta.url), path.join(core, 'bin', launcher))
  if (!windows) { await fs.chmod(node, 0o755); await fs.chmod(path.join(core, 'bin', launcher), 0o755) }
  if (launcherSuffix) await fs.appendFile(path.join(core, 'bin', launcher), launcherSuffix)
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
    if (realPython) {
      const cached = JSON.parse(await fs.readFile(new URL('../../../product-runtime.json', import.meta.url), 'utf8'))
      const repository = fileURLToPath(new URL('../../../', import.meta.url)), originalHome = path.join(repository, cached.python_home)
      const pythonHome = path.join(core, '.product-runtime/python')
      await fs.cp(originalHome, pythonHome, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
      const python = path.join(pythonHome, path.relative(originalHome, await fs.realpath(path.join(repository, cached.executables.python))))
      const manifestFile = path.join(core, 'product-runtime.json'), manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'))
      const relativePython = path.relative(core, python).split(path.sep).join('/')
      manifest.executables.python = relativePython; manifest.python_home = '.product-runtime/python'
      manifest.versions.python = cached.versions.python
      manifest.files[relativePython] = { size: (await fs.stat(python)).size, sha256: createHash('sha256').update(await fs.readFile(python)).digest('hex') }
      await fs.writeFile(manifestFile, JSON.stringify(manifest))
      await fs.copyFile(new URL('../../desktop/inspect-legacy-python.py', import.meta.url), path.join(core, 'scripts/desktop/inspect-legacy-python.py'))
    }
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
      `import fs from 'node:fs';import path from 'node:path';const root=process.argv.find(arg=>arg.startsWith('--data-dir=')).slice(11);fs.writeFileSync(path.join(root,'content'),'converted by bundled Node');fs.appendFileSync(path.join(root,'executions'),'once\\n');${coreTamper ? "fs.appendFileSync(path.resolve(process.argv[1],'../../../cli.mjs'),'corrupted')" : ''}${conversionFailure ? 'process.exit(13)' : ''}`)
  }
  if (shared) { await fs.mkdir(path.join(core, 'crabot-agent'), { recursive: true }); await fs.writeFile(path.join(core, 'crabot-agent/shared_request_version'), '1\n') }
  await writeCoreRelease(core, { schema_version: 1, version, platform: process.platform, arch: process.arch, commit: '1'.repeat(40), source_dirty: false })
  const release = await verifyCoreRelease(core), selection = { schema_version: 1, version, gui_id: randomUUID(), core_id: release.inventory_sha256 }
  await fs.writeFile(path.join(core, 'desktop-host.json'), JSON.stringify({ schema_version: 2, platform: process.platform, arch: process.arch }))
  await fs.mkdir(path.dirname(exe), { recursive: true }); await fs.mkdir(resources, { recursive: true })
  await fs.writeFile(exe, 'GUI fixture, never launched')
  await fs.writeFile(path.join(resources, 'crabot-copy-cleanup' + (windows ? '.exe' : '')), 'inert cleanup fixture; never executed')
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
test('sealing a new complete GUI rejects a missing native copy-cleanup component', async t => {
  const f = await fixture(t)
  await fs.unlink(path.join(f.resources, 'crabot-copy-cleanup' + (windows ? '.exe' : '')))
  await assert.rejects(sealDesktopPayload(f.payload), { code: 'ENOENT' })
})
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
  const code = `
    import {DesktopController} from ${JSON.stringify(module)};
    import {readFile} from 'node:fs/promises';
    import path from 'node:path';
    import {pathToFileURL} from 'node:url';
    const [prepared,current]=JSON.parse(process.argv[1]);
    let captures=0, restores=0, entries=0;
    const notices=[];
    const c=new DesktopController({coreRoot:current.coreRoot,dataRoot:current.dataDir,appVersion:current.selection.version,platform:process.platform,
      loginStartup:{captureForUpdate:async()=>{captures++;return 'off'},restoreForUpdate:async()=>{throw new Error('Source may not restore target login')}}});
    c.host.status('stopped');
    let target, lock;
    const locks=await import(pathToFileURL(path.join(prepared.coreRoot,'scripts/lib/cli-lock.mjs')).href);
    const maintenance=await import(pathToFileURL(path.join(prepared.coreRoot,'scripts/lib/version-maintenance.mjs')).href);
    try {
      const selected=await c.applyPreparedPair(prepared,async()=>{entries++});
      const record=maintenance.readVersionMaintenance(current.dataDir);
      const sidecar=path.join(prepared.installRoot,'app/updates',record.id,'login-startup.json');
      target=new DesktopController({coreRoot:prepared.coreRoot,dataRoot:current.dataDir,appVersion:prepared.selection.version,platform:process.platform,
        loginStartup:{captureForUpdate:async()=>{throw new Error('Target may not capture source intent')},restoreForUpdate:async(intent,source)=>{
          if(intent!=='off'||!source.includes(current.selection.gui_id))throw new Error('Wrong intent/source');
          restores++; if(restores===1)throw new Error('Unknown OS result');
          return {supported:true,enabled:false,approvalRequired:false};
        }},loginStartupRecovered:state=>{notices.push(state===null?'unconfirmed':'off')}});
      lock=await locks.acquireStartupLock(current.dataDir,'finite-login-recovery');
      const first=await target.recoverLoginStartup();
      const pending=JSON.parse(await readFile(sidecar,'utf8')).phase;
      const second=await target.recoverLoginStartup();
      const consumed=await target.recoverLoginStartup();
      if(first!==null||second?.enabled!==false||second?.approvalRequired!==false||consumed!==undefined)throw new Error('Login result or consumed replay changed');
      // This component has not run business health. Native notices belong only
      // to recoverVersion after service/maintenance settlement, never here.
      if(notices.length)throw new Error('Login component presented a premature native notice');
      const phase=JSON.parse(await readFile(sidecar,'utf8')).phase;
      console.log('PAIRED_CONTROLLER '+JSON.stringify({entries,phase:c.host.snapshot().phase,dataDir:selected.dataDir,
        login:{captures,restores,notices,results:[first===null?'unconfirmed':'invalid',second?.enabled===false?'off':'invalid'],pending,phase,maintenance:maintenance.readVersionMaintenance(current.dataDir).phase}}));
    }finally{if(lock)locks.releaseCliLock(lock);target?.close();c.close()}
  `
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code, JSON.stringify([prepared, current])],
    { env: { ...process.env, PATH: '' }, timeout: 45_000, maxBuffer: 64 * 1024 })
  const evidence = JSON.parse(result.stdout.split('\n').find(line => line.startsWith('PAIRED_CONTROLLER ')).slice('PAIRED_CONTROLLER '.length))
  assert.deepEqual(evidence, { entries: 1, phase: 'stopped', dataDir: current.dataDir,
    login: { captures: 1, restores: 2, notices: [], results: ['unconfirmed', 'off'], pending: 'pending', phase: 'consumed', maintenance: 'verifying' } })
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


for (const changed of [null, 'no-lock', 'journal', 'maintenance', 'program', 'source-selected']) test('read-only committed pair recovery binding: ' + changed, async t => {
  const f = await stoppedPairFixture(t), { readCommittedDesktopPair } = await import('../desktop-pair-commit.mjs')
  const { acquireStartupLock, releaseCliLock } = await import('../cli-lock.mjs')
  await f.commit()
  const before = await fs.readFile(path.join(f.current.dataDir, 'admin/kept'))
  let lock
  try {
    if (changed !== 'no-lock') lock = await acquireStartupLock(f.current.dataDir, 'finite-login-recovery')
    if (changed === 'journal') await fs.appendFile(path.join(f.target, 'app/updates', f.record.id, 'selection.json'), ' ')
    if (changed === 'maintenance') {
      const file = path.join(f.current.dataDir, 'desktop-maintenance.json'), record = f.maintenance.readVersionMaintenance(f.current.dataDir)
      await fs.writeFile(file, JSON.stringify({ ...record, source_inventory_sha256: 'd'.repeat(64) }))
    }
    if (changed === 'program') await fs.appendFile(path.join(f.prepared.coreRoot, 'package.json'), ' ')
    if (changed === 'source-selected') await fs.writeFile(path.join(f.target, 'current-release.json'), JSON.stringify(f.current.selection) + '\n')
    if (changed) await assert.rejects(readCommittedDesktopPair(f.target, f.record.id))
    else {
      const restored = await readCommittedDesktopPair(f.target, f.record.id)
      const { preview, ...expected } = f.prepared
      assert.deepEqual(restored, expected)
      assert.equal(Object.hasOwn(restored, 'preview'), false)
      assert.equal(f.maintenance.readVersionMaintenance(f.current.dataDir).phase, 'verifying')
    }
    assert.deepEqual(await fs.readFile(path.join(f.current.dataDir, 'admin/kept')), before)
    await assert.rejects(fs.stat(path.join(f.current.dataDir, 'mm.pid')), { code: 'ENOENT' })
  } finally { if (lock) releaseCliLock(lock) }
})

for (const scenario of ['current', 'bad-core', 'changed-selection', 'bad-signature', 'close-before-network', 'close-at-session', 'changed-during-check']) test('actual paired update host checks preserve the running source: ' + scenario,
  { skip: process.env.CRABOT_PAIRED_CONTROLLER_TEST !== '1', timeout: 60_000 }, async t => {
    const f = await fixture(t, { functional: true, schema: 'v1' })
    const prepared = await prepareDesktopInstallation({ payload: f.payload, installRoot: f.target }), current = await commitDesktopInstallation(prepared)
    await fs.mkdir(path.join(current.dataDir, 'admin')); await fs.writeFile(path.join(current.dataDir, 'admin/kept'), 'source business data')
    await fs.writeFile(path.join(current.dataDir, 'mm.pid'), String(process.pid))
    const { generateKeyPairSync } = await import('node:crypto'), keys = generateKeyPairSync('ed25519')
    const { signDesktopReleaseManifest } = await import('../../desktop/sign-release.mjs')
    const signed = signDesktopReleaseManifest({ schema_version: 1, app_id: 'com.crabot.desktop', platform: process.platform, arch: process.arch,
      selection: current.selection, artifact: { file: 'Crabot.zip', size: 1, sha256: 'a'.repeat(64) } }, [keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()])
    if (scenario === 'bad-core') await fs.appendFile(path.join(current.coreRoot, 'package.json'), ' ')
    if (scenario === 'changed-selection') await fs.writeFile(path.join(f.target, 'current-release.json'), JSON.stringify({ ...current.selection, gui_id: randomUUID() }) + '\n')
    const module = pathToFileURL(fileURLToPath(new URL('../../../crabot-desktop/dist/paired-update-host.js', import.meta.url))).href
    const code = `
      import {createPairedUpdateHost} from ${JSON.stringify(module)};
      import assert from 'node:assert/strict'; import {writeFile} from 'node:fs/promises'; import path from 'node:path';
      const [current,key,raw,envelope,scenario]=JSON.parse(process.argv[1]);
      let sessions=0,requests=0,closed=0,driver;
      const forbidden=()=>assert.fail('No install, OS mutation or GUI execution during a check');
      const transport=()=>{sessions++;if(scenario==='close-at-session')driver.close();return{close:async()=>{closed++},fetch:async(url,options)=>{
        requests++; assert.equal(options.credentials,'omit'); assert.equal(options.redirect,'manual'); assert.equal(options.method,'GET');
        if(scenario==='changed-during-check'&&requests===1)await writeFile(path.join(current.root,'current-release.json'),JSON.stringify({...current.selection,gui_id:'11111111-1111-4111-8111-111111111111'})+'\\n');
        const manifest=url.endsWith('.manifest.json');
        const body=Buffer.from(manifest?raw:envelope,'base64');
        return new Response(manifest&&scenario==='bad-signature'?Buffer.concat([body,Buffer.from(' ')]):body);
      }}};
      driver=await createPairedUpdateHost({pinnedPublicKeys:[key],coreRoot:current.coreRoot,dataRoot:current.dataDir,appVersion:current.selection.version,
        verifyBinding:()=>{if(scenario==='close-before-network')driver.close()},transport,controller:{applyPreparedPair:forbidden},
        entries:{home:current.root,platform:process.platform,env:{},shell:{readShortcutLink:forbidden,writeShortcutLink:forbidden}},
        app:{relaunch:forbidden,quit:forbidden,once:forbidden,off:forbidden},beginExit:forbidden});
      if(scenario==='current')assert.equal(await driver.check(()=>{}),null);
      else await assert.rejects(driver.check(()=>{}),error=>scenario.startsWith('close-')?error.name==='AbortError'
        : error.code===(scenario==='bad-core'?'CRABOT_CORE_INTEGRITY':scenario==='bad-signature'?'CRABOT_DESKTOP_RELEASE_SIGNATURE':'CRABOT_DESKTOP_INSTALLATION'));
      if(scenario==='close-at-session')assert.equal(closed,1,'A session created across close must be released without a second close');
      driver.close();driver.close();await new Promise(resolve=>setImmediate(resolve));
      console.log('PAIRED_HOST '+JSON.stringify({sessions,requests,closed}));
    `
    const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code,
      JSON.stringify([current, signed.publicKeys[0], signed.manifest.toString('base64'), signed.signatures.toString('base64'), scenario])],
    { env: { ...process.env, PATH: '' }, timeout: 45_000, maxBuffer: 64 * 1024 })
    const evidence = JSON.parse(result.stdout.split('\n').find(line => line.startsWith('PAIRED_HOST ')).slice('PAIRED_HOST '.length))
    const initialized = ['current', 'bad-signature', 'changed-during-check'].includes(scenario)
    assert.deepEqual(evidence, { sessions: initialized || scenario === 'close-at-session' ? 1 : 0, requests: initialized ? 2 : 0,
      closed: initialized || scenario === 'close-at-session' ? 1 : 0 })
    assert.equal(await fs.readFile(path.join(current.dataDir, 'mm.pid'), 'utf8'), String(process.pid))
    assert.equal(await fs.readFile(path.join(current.dataDir, 'admin/kept'), 'utf8'), 'source business data')
    await assert.rejects(fs.stat(path.join(current.dataDir, 'desktop-maintenance.json')), { code: 'ENOENT' })
    await assert.rejects(fs.stat(path.join(current.dataDir, 'runtime-cache')), { code: 'ENOENT' })
  })

test('fresh commit cannot consume preparation protection after business data appears', async t => {
  const f = await fixture(t), prepared = await prepareDesktopInstallation({ payload: f.payload, installRoot: f.target })
  const data = path.join(f.target, 'data'), file = path.join(data, 'existing-business.json')
  await fs.writeFile(file, '{"keep":"original data"}\n')
  await assert.rejects(commitDesktopInstallation(prepared), { code: 'CRABOT_DESKTOP_INSTALLATION' })
  assert.equal(await fs.readFile(file, 'utf8'), '{"keep":"original data"}\n')
  assert.equal(JSON.parse(await fs.readFile(path.join(f.target, '.desktop-installing.json'), 'utf8')).phase, 'prepared')
  await assert.rejects(fs.stat(path.join(f.target, 'current-release.json')), { code: 'ENOENT' })
})

async function repairFixture(t, { executableNode = false } = {}) {
  const f = await fixture(t, { executableNode }), prepared = await prepareDesktopInstallation({ payload: f.payload, installRoot: f.target })
  const selected = await commitDesktopInstallation(prepared), data = selected.dataDir
  await fs.mkdir(path.join(data, 'workspaces/default'), { recursive: true })
  await fs.writeFile(path.join(data, 'workspaces/default', 'user.txt'), 'user project remains')
  await fs.writeFile(path.join(data, 'desktop-maintenance.json'), 'original version protection, never clear')
  return { ...f, prepared, selected, data, options: { payload: f.payload, installRoot: f.target, verifyStopped: async () => {} } }
}
const repairApi = () => import('../desktop-repair.mjs')
test('exact-pair repair restores only GUI/Core, preserves data and original protection, and keeps CLI binding', async t => {
  const f = await repairFixture(t, { executableNode: true }), { prepareDesktopRepair, commitDesktopRepair } = await repairApi()
  const gui = path.join(f.prepared.guiRoot, path.relative(f.gui, f.resources), 'app.asar')
  await fs.writeFile(path.join(f.prepared.coreRoot, 'cli.mjs'), 'damaged Core bytes'); await fs.writeFile(gui, 'damaged GUI bytes')
  const before = await fs.readFile(path.join(f.target, 'current-release.json')), launcherBefore = await fs.readFile(f.selected.command)
  const repaired = await prepareDesktopRepair(f.options)
  assert.throws(() => installation.readDesktopSelection(f.target), { code: 'CRABOT_DESKTOP_INSTALLATION' })
  await assert.rejects(commitDesktopInstallation(repaired), { code: 'CRABOT_DESKTOP_INSTALLATION' })
  const selected = await commitDesktopRepair(repaired, { verifyStopped: f.options.verifyStopped })
  assert.deepEqual(selected.selection, f.selection); assert.deepEqual(await fs.readFile(path.join(f.target, 'current-release.json')), before)
  assert.deepEqual(await fs.readFile(f.selected.command), launcherBefore)
  assert.equal(await fs.readFile(path.join(f.data, 'workspaces/default', 'user.txt'), 'utf8'), 'user project remains')
  assert.equal(await fs.readFile(path.join(f.data, 'desktop-maintenance.json'), 'utf8'), 'original version protection, never clear')
  assert.equal((await fs.readdir(path.join(f.target, 'releases'))).filter(name => name.startsWith('.damaged-')).length, 1)
  assert.equal((await fs.readdir(path.join(f.target, 'app/releases'))).filter(name => name.startsWith('.damaged-')).length, 1)
  const result = await promisify(execFile)(selected.command, ['help'], { env: { ...process.env, PATH: '' } })
  assert.deepEqual(JSON.parse(result.stdout), { version: '1.2.3', required: '1' })
})
test('exact-pair repair can restore missing program directories without recreating data', async t => {
  const f = await repairFixture(t), { prepareDesktopRepair, commitDesktopRepair } = await repairApi()
  await fs.rename(f.prepared.coreRoot, path.join(f.parent, 'retained-core')); await fs.rename(f.prepared.guiRoot, path.join(f.parent, 'retained-gui'))
  const reference = installation.readDesktopPairReference(f.target)
  const repaired = await prepareDesktopRepair(f.options); await commitDesktopRepair(repaired, { verifyStopped: f.options.verifyStopped })
  assert.deepEqual(installation.readDesktopPairReference(f.target), reference)
  assert.equal(await fs.readFile(path.join(f.data, 'workspaces/default', 'user.txt'), 'utf8'), 'user project remains')
})

async function assertRepairData(f) {
  assert.equal(await fs.readFile(path.join(f.data, 'workspaces/default/user.txt'), 'utf8'), 'user project remains')
  assert.equal(await fs.readFile(path.join(f.data, 'desktop-maintenance.json'), 'utf8'), 'original version protection, never clear')
}
for (const changed of ['other-pair', 'missing-proof', 'invalid-proof', 'linked-proof', 'no-stop-proof', 'running', 'lost-lock', 'changed-root']) test('exact-pair repair refuses ambiguous authority before publication: ' + changed, async t => {
  const f = await repairFixture(t), { prepareDesktopRepair } = await repairApi()
  const original = await fs.readFile(path.join(f.prepared.coreRoot, 'cli.mjs')), proof = path.join(f.target, '.desktop-install-payload.json')
  if (changed === 'other-pair') f.options.payload = (await fixture(t)).payload
  else if (changed === 'missing-proof') await fs.unlink(proof)
  else if (changed === 'invalid-proof') await fs.writeFile(proof, 'broken original manifest')
  else if (changed === 'linked-proof') { await fs.rename(proof, proof + '.retained'); await fs.link(proof + '.retained', proof) }
  else if (changed === 'no-stop-proof') delete f.options.verifyStopped
  else if (changed === 'running') await fs.writeFile(path.join(f.data, 'mm.pid'), String(process.pid))
  else if (changed === 'lost-lock') {
    const { releaseCliLock } = await import('../cli-lock.mjs')
    f.options.verifyStopped = async () => releaseCliLock(path.join(f.data, 'cli.lock'))
  } else {
    f.options.verifyStopped = async () => {
      const file = path.join(f.target, 'desktop-installation.json'), record = JSON.parse(await fs.readFile(file, 'utf8'))
      await fs.writeFile(file, JSON.stringify({ ...record, installation_id: randomUUID() }) + '\n')
    }
  }
  await assert.rejects(prepareDesktopRepair(f.options), { code: 'CRABOT_DESKTOP_INSTALLATION' })
  await assert.rejects(fs.lstat(path.join(f.target, '.desktop-installing.json')), { code: 'ENOENT' })
  assert.deepEqual(await fs.readFile(path.join(f.prepared.coreRoot, 'cli.mjs')), original)
  await assertRepairData(f)
})
test('exact-pair repair cancellation finishes copy cleanup without publishing or fencing the installed pair', async t => {
  const f = await repairFixture(t), { prepareDesktopRepair } = await repairApi(), abort = new AbortController()
  await fs.writeFile(path.join(f.prepared.coreRoot, 'cli.mjs'), 'old damaged program')
  await assert.rejects(prepareDesktopRepair({ ...f.options, signal: abort.signal, progress: phase => { if (phase === 'copying') abort.abort() } }), { name: 'AbortError' })
  await assert.rejects(fs.lstat(path.join(f.target, '.desktop-installing.json')), { code: 'ENOENT' })
  assert.equal((await fs.readdir(f.target)).some(name => name.startsWith('.preparing-repair-')), false)
  assert.equal(await fs.readFile(path.join(f.prepared.coreRoot, 'cli.mjs'), 'utf8'), 'old damaged program')
  await assertRepairData(f)
})
test('exact-pair repair reuses the same protected job after a program publication reply is lost', async t => {
  const f = await repairFixture(t), { prepareDesktopRepair, commitDesktopRepair } = await repairApi()
  const gui = path.join(f.prepared.guiRoot, path.relative(f.gui, f.resources), 'app.asar')
  await fs.writeFile(path.join(f.prepared.coreRoot, 'cli.mjs'), 'old damaged Core'); await fs.writeFile(gui, 'old damaged GUI')
  const rename = fs.rename, fault = t.mock.method(fs, 'rename', async (from, to) => {
    await rename(from, to)
    if (to === f.prepared.coreRoot && from.includes('.preparing-repair-')) throw new Error('publication reply lost')
  })
  await assert.rejects(prepareDesktopRepair(f.options), AggregateError); fault.mock.restore()
  const file = path.join(f.target, '.desktop-installing.json'), pending = JSON.parse(await fs.readFile(file, 'utf8'))
  assert.equal(pending.phase, 'preparing')
  assert.throws(() => installation.readDesktopSelection(f.target), { code: 'CRABOT_DESKTOP_INSTALLATION' })
  assert.equal(await fs.readFile(gui, 'utf8'), 'old damaged GUI'); await assertRepairData(f)
  const repaired = await prepareDesktopRepair(f.options)
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).id, pending.id)
  assert.equal((await fs.readdir(path.join(f.target, 'releases'))).filter(name => name.startsWith('.damaged-')).length, 1)
  // Transport/schema parsers may reorder fields; descriptor order is not authority.
  await commitDesktopRepair(Object.fromEntries(Object.entries(repaired).reverse()), { verifyStopped: f.options.verifyStopped })
  assert.deepEqual(installation.readDesktopSelection(f.target).selection, f.selection)
  await assertRepairData(f)
})
test('exact-pair repair rejects a changed preparation job between program publications', async t => {
  const f = await repairFixture(t), { prepareDesktopRepair } = await repairApi()
  const gui = path.join(f.prepared.guiRoot, path.relative(f.gui, f.resources), 'app.asar')
  await fs.writeFile(path.join(f.prepared.coreRoot, 'cli.mjs'), 'damaged Core'); await fs.writeFile(gui, 'damaged GUI')
  const file = path.join(f.target, '.desktop-installing.json'), rename = fs.rename
  let replacement
  const fault = t.mock.method(fs, 'rename', async (from, to) => {
    await rename(from, to)
    if (to === f.prepared.coreRoot && from.includes('.preparing-repair-')) {
      replacement = { ...JSON.parse(await fs.readFile(file, 'utf8')), id: randomUUID() }
      await fs.writeFile(file, JSON.stringify(replacement) + '\n')
    }
  })
  await assert.rejects(prepareDesktopRepair(f.options), { code: 'CRABOT_DESKTOP_INSTALLATION' }); fault.mock.restore()
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), replacement)
  assert.equal(await fs.readFile(gui, 'utf8'), 'damaged GUI'); await assertRepairData(f)
})
test('exact-pair repair commit keeps protection after program mutation and retries only the same tuple', async t => {
  const f = await repairFixture(t), { prepareDesktopRepair, commitDesktopRepair } = await repairApi()
  const prepared = await prepareDesktopRepair(f.options), commitOptions = { verifyStopped: f.options.verifyStopped }
  await assert.rejects(commitDesktopRepair({ ...prepared, coreRoot: f.core }, commitOptions), { code: 'CRABOT_DESKTOP_INSTALLATION' })
  await assert.rejects(commitDesktopRepair({ ...prepared, extra: true }, commitOptions), { code: 'CRABOT_DESKTOP_INSTALLATION' })
  const gui = path.join(prepared.guiRoot, path.relative(f.gui, f.resources), 'app.asar')
  await fs.writeFile(gui, 'changed after repair preparation')
  await assert.rejects(commitDesktopRepair(prepared, commitOptions), { code: 'CRABOT_CORE_INTEGRITY' })
  assert.equal(JSON.parse(await fs.readFile(path.join(f.target, '.desktop-installing.json'), 'utf8')).phase, 'prepared')
  await assertRepairData(f)
  await commitDesktopRepair(await prepareDesktopRepair(f.options), commitOptions)
  await assertRepairData(f)
})

for (const scenario of ['current-proof', 'current-proof-conflict', 'current-proof-link', 'missing-data', 'stop-refused']) test('exact-pair repair respects original proof priority and existing data identity: ' + scenario, async t => {
  const f = await repairFixture(t), { prepareDesktopRepair, commitDesktopRepair } = await repairApi()
  if (scenario.startsWith('current-proof')) {
    const directory = path.join(f.target, 'app/payloads'), { privateJson } = await import('../desktop-preparation-files.mjs')
    if (windows) identity.createPrivateDirectory(directory)
    else await fs.mkdir(directory, { mode: 0o700 })
    const proof = path.join(directory, f.selection.gui_id + '.json')
    await privateJson(proof, JSON.parse(await fs.readFile(path.join(f.payload, 'desktop-payload.json'), 'utf8')))
    if (scenario === 'current-proof') await fs.writeFile(path.join(f.target, '.desktop-install-payload.json'), 'old initial installation proof, no longer current')
    else if (scenario === 'current-proof-conflict') await fs.appendFile(proof, ' ')
    else { await fs.rename(proof, proof + '.retained'); await fs.symlink(proof + '.retained', proof, 'file') }
  } else if (scenario === 'missing-data') await fs.rename(f.data, path.join(f.parent, 'data-retained'))
  else f.options.verifyStopped = async () => { throw new Error('actual GUI still uses selected program') }
  if (scenario === 'current-proof') {
    await commitDesktopRepair(await prepareDesktopRepair(f.options), { verifyStopped: f.options.verifyStopped })
    await assertRepairData(f)
  } else {
    await assert.rejects(prepareDesktopRepair(f.options), error => scenario === 'stop-refused'
      ? error.message === 'actual GUI still uses selected program' : error.code === 'CRABOT_DESKTOP_INSTALLATION')
    await assert.rejects(fs.lstat(path.join(f.target, '.desktop-installing.json')), { code: 'ENOENT' })
    if (scenario === 'missing-data') {
      await assert.rejects(fs.lstat(f.data), { code: 'ENOENT' })
      assert.equal(await fs.readFile(path.join(f.parent, 'data-retained/workspaces/default/user.txt'), 'utf8'), 'user project remains')
    } else await assertRepairData(f)
  }
})
test('exact-pair repair publication ignores late cancellation and commit can recover a lost unlink response', async t => {
  const f = await repairFixture(t), { prepareDesktopRepair, commitDesktopRepair } = await repairApi(), abort = new AbortController()
  await fs.writeFile(path.join(f.prepared.coreRoot, 'cli.mjs'), 'damaged Core')
  const rename = fs.rename, fault = t.mock.method(fs, 'rename', async (from, to) => {
    await rename(from, to)
    if (to === f.prepared.coreRoot && from.includes('.preparing-repair-')) abort.abort()
  })
  const prepared = await prepareDesktopRepair({ ...f.options, signal: abort.signal }); fault.mock.restore()
  assert.equal(abort.signal.aborted, true)
  const fence = path.join(f.target, '.desktop-installing.json'), unlink = fs.unlink
  const lost = t.mock.method(fs, 'unlink', async file => { await unlink(file); if (file === fence) throw new Error('fence removal reply lost') })
  await assert.rejects(commitDesktopRepair(prepared, { verifyStopped: f.options.verifyStopped }), /fence removal reply lost/); lost.mock.restore()
  assert.deepEqual(installation.readDesktopSelection(f.target).selection, f.selection)
  await assertRepairData(f)
  // Reverify the package and actual bytes before explicitly completing repair.
  await commitDesktopRepair(await prepareDesktopRepair(f.options), { verifyStopped: f.options.verifyStopped })
  assert.equal((await fs.readdir(path.join(f.target, 'releases'))).filter(name => name.startsWith('.damaged-')).length, 1)
  await assertRepairData(f)
})

for (const stage of ['prepare', 'commit']) test('ordinary exact-pair repair cannot bypass an independent removal fence: ' + stage, async t => {
  const f = await repairFixture(t), { prepareDesktopRepair, commitDesktopRepair } = await repairApi()
  const prepared = stage === 'commit' ? await prepareDesktopRepair(f.options) : undefined
  const marker = path.join(f.target, '.desktop-removal.json')
  await fs.writeFile(marker, 'independent removal protection, cannot clear through repair')
  await assert.rejects(stage === 'prepare' ? prepareDesktopRepair(f.options) : commitDesktopRepair(prepared, { verifyStopped: f.options.verifyStopped }), { code: 'CRABOT_DESKTOP_REMOVAL_PENDING' })
  assert.equal(await fs.readFile(marker, 'utf8'), 'independent removal protection, cannot clear through repair')
  if (stage === 'prepare') await assert.rejects(fs.lstat(path.join(f.target, '.desktop-installing.json')), { code: 'ENOENT' })
  else assert.equal(JSON.parse(await fs.readFile(path.join(f.target, '.desktop-installing.json'), 'utf8')).phase, 'prepared')
  await assertRepairData(f)
})

test('fresh install retains a standalone private original GUI payload proof for later repair', async t => {
  const f = await fixture(t), prepared = await prepareDesktopInstallation({ payload: f.payload, installRoot: f.target })
  const file = path.join(f.target, '.desktop-install-payload.json'), stat = await fs.lstat(file)
  assert.equal(stat.nlink, 1)
  if (windows) assert.equal(identity.isPrivateFile(file), true)
  else { assert.equal(stat.uid, process.getuid()); assert.equal(stat.mode & 0o777, 0o600) }
  assert.equal(await fs.readFile(file, 'utf8'), JSON.stringify((await verifyDesktopPayload(f.payload)).record) + '\n')
  await commitDesktopInstallation(prepared)
})
test('private preparation JSON supports large inventories and still refuses existing targets without leftovers', async t => {
  const parent = await fs.mkdtemp(path.join(tmpdir(), 'crabot-large-private-proof-'))
  t.after(() => fs.rm(parent, { recursive: true, force: true }))
  const file = path.join(parent, 'proof.json'), value = { inventory: 'x'.repeat(128 * 1024) }
  const { privateJson } = await import('../desktop-preparation-files.mjs')
  await privateJson(file, value)
  assert.equal(await fs.readFile(file, 'utf8'), JSON.stringify(value) + '\n')
  if (windows) assert.equal(identity.isPrivateFile(file), true)
  else assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
  assert.equal((await fs.stat(file)).nlink, 1)
  await assert.rejects(privateJson(file, { changed: true }), { code: 'EEXIST' })
  assert.deepEqual(await fs.readdir(parent), ['proof.json'])
  assert.equal(await fs.readFile(file, 'utf8'), JSON.stringify(value) + '\n')
})

async function removalProofFixture(t, { schema, functional = false, shared = false } = {}) {
  const f = await fixture(t, { executableNode: false, schema, functional, shared }), prepared = await prepareDesktopInstallation({ payload: f.payload, installRoot: f.target })
  await commitDesktopInstallation(prepared)
  await fs.writeFile(path.join(f.target, 'data', 'retained-user-file'), 'user content')
  const backend = await import('../desktop-removal-proof.mjs'), operation = randomUUID()
  const entries = await fs.readdir(f.target), dataEntries = await fs.readdir(path.join(f.target, 'data'))
  const proof = await backend.captureDesktopRemovalProof(f.target, operation)
  assert.deepEqual(await fs.readdir(f.target), entries)
  assert.deepEqual(await fs.readdir(path.join(f.target, 'data')), dataEntries)
  const { privateJson } = await import('../desktop-preparation-files.mjs')
  const management = (await import('../desktop-management.cjs')).default
  management.ensurePrivateDataRoot(path.join(f.target, 'app/removals'))
  const directory = management.ensurePrivateDataRoot(path.join(f.target, 'app/removals', operation))
  const file = path.join(directory, 'proof.json'), record = { schema_version: 1, installation_id: prepared.installation_id,
    operation_id: operation, source_selection: f.selection, phase: 'preparing', proof_sha256: '' }
  const publish = async (value = proof, text = JSON.stringify(value) + '\n') => {
    await fs.rm(file, { force: true }); await privateJson(file, value)
    if (text !== JSON.stringify(value) + '\n') await fs.writeFile(file, text, { flag: 'r+' })
    record.proof_sha256 = createHash('sha256').update(text).digest('hex')
    await privateJson(path.join(f.target, '.desktop-removal.json'), record, Boolean(await fs.lstat(path.join(f.target, '.desktop-removal.json')).catch(() => null)))
  }
  await publish()
  return { ...f, prepared, proof, file, record, publish, backend }
}
test('removal proof captures verified original bytes without data or transaction writes and reads after Core removal', async t => {
  const f = await removalProofFixture(t)
  assert.equal(f.proof.installation_id, f.prepared.installation_id)
  assert.deepEqual(f.proof.source_selection, f.selection)
  assert.equal(f.proof.core.inventory, await fs.readFile(path.join(f.prepared.coreRoot, 'core-files.json'), 'utf8'))
  assert.deepEqual(await f.backend.readDesktopRemovalProof(f.target), { record: f.record, proof: f.proof })
  await fs.rm(f.prepared.coreRoot, { recursive: true })
  assert.deepEqual(await f.backend.readDesktopRemovalProof(f.target), { record: f.record, proof: f.proof })
  assert.equal(await fs.readFile(path.join(f.target, 'data/retained-user-file'), 'utf8'), 'user content')
  assert.throws(() => installation.readDesktopSelection(f.target), { code: 'CRABOT_DESKTOP_REMOVAL_PENDING' })
})
for (const changed of ['digest', 'bom', 'noncanonical', 'reordered', 'installation', 'operation', 'selection', 'platform', 'inventory-bytes', 'inventory-path', 'gui-path', 'gui-link', 'metadata', 'unknown-field', 'hardlink', 'parent-link']) {
  test('removal proof rejects changed or unsafe historical bytes without loading Core: ' + changed, async t => {
    const f = await removalProofFixture(t), value = structuredClone(f.proof)
    if (changed === 'digest') await fs.appendFile(f.file, ' ')
    else if (changed === 'bom') await fs.writeFile(f.file, '\uFEFF' + JSON.stringify(value) + '\n', { flag: 'r+' })
    else if (changed === 'noncanonical') await f.publish(value, JSON.stringify(value, null, 2) + '\n')
    else if (changed === 'reordered') { const { schema_version, ...rest } = value; await f.publish({ ...rest, schema_version }) }
    else if (changed === 'installation') { value.installation_id = randomUUID(); await f.publish(value) }
    else if (changed === 'operation') { value.operation_id = randomUUID(); await f.publish(value) }
    else if (changed === 'selection') { value.source_selection.gui_id = randomUUID(); await f.publish(value) }
    else if (changed === 'platform') { value.payload.platform = 'foreign'; await f.publish(value) }
    else if (changed === 'inventory-bytes') { value.core.inventory += ' '; await f.publish(value) }
    else if (changed === 'inventory-path') {
      const inventory = JSON.parse(value.core.inventory)
      inventory.files['../data/retained-user-file'] = Object.values(inventory.files).find(entry => entry.type === 'file')
      value.core.inventory = JSON.stringify(inventory) + '\n'
      const core = JSON.parse(value.core.release); core.inventory_sha256 = createHash('sha256').update(value.core.inventory).digest('hex')
      value.core.release = JSON.stringify(core); value.source_selection.core_id = core.inventory_sha256
      value.payload.selection.core_id = core.inventory_sha256; f.record.source_selection.core_id = core.inventory_sha256
      await f.publish(value)
    } else if (changed === 'gui-path') { value.payload.gui['/outside'] = { type: 'file', size: 0, sha256: '0'.repeat(64), ...(!windows && { mode: 0o600 }) }; await f.publish(value) }
    else if (changed === 'gui-link') { value.payload.gui['escape'] = { type: 'link', target: '../data' }; await f.publish(value) }
    else if (changed === 'metadata') { const core = JSON.parse(value.core.release); core.version = '99.0.0'; value.core.release = JSON.stringify(core); await f.publish(value) }
    else if (changed === 'unknown-field') { value.command = 'unexpected'; await f.publish(value) }
    else if (changed === 'hardlink') await fs.link(f.file, f.file + '.retained')
    else { const directory = path.dirname(f.file); await fs.rename(directory, directory + '.retained'); await fs.symlink(directory + '.retained', directory, windows ? 'junction' : 'dir') }
    await assert.rejects(f.backend.readDesktopRemovalProof(f.target), { code: 'CRABOT_DESKTOP_REMOVAL' })
    assert.equal(await fs.readFile(path.join(f.target, 'data/retained-user-file'), 'utf8'), 'user content')
    assert.throws(() => installation.readDesktopSelection(f.target), { code: 'CRABOT_DESKTOP_REMOVAL_PENDING' })
  })
}
for (const changed of ['gui', 'core', 'original-proof', 'operation', 'cancelled']) test('removal proof capture refuses unverified sources and leaves no transaction: ' + changed, async t => {
  const f = await fixture(t, { executableNode: false }), prepared = await prepareDesktopInstallation({ payload: f.payload, installRoot: f.target })
  await commitDesktopInstallation(prepared)
  const backend = await import('../desktop-removal-proof.mjs'), abort = new AbortController()
  if (changed === 'gui') await fs.appendFile(path.join(prepared.guiRoot, process.platform === 'darwin' ? 'Crabot.app/Contents/MacOS/Crabot' : windows ? 'Crabot.exe' : 'crabot-desktop'), 'changed')
  else if (changed === 'core') await fs.appendFile(path.join(prepared.coreRoot, 'cli.mjs'), 'changed')
  else if (changed === 'original-proof') await fs.rm(path.join(f.target, '.desktop-install-payload.json'))
  else if (changed === 'cancelled') abort.abort(new Error('cancelled capture'))
  const entries = await fs.readdir(f.target), dataEntries = await fs.readdir(path.join(f.target, 'data'))
  await assert.rejects(backend.captureDesktopRemovalProof(f.target, changed === 'operation' ? '../outside' : randomUUID(), { signal: abort.signal }), changed === 'cancelled' ? /cancelled capture/ : { code: 'CRABOT_DESKTOP_REMOVAL' })
  assert.deepEqual(await fs.readdir(f.target), entries)
  assert.deepEqual(await fs.readdir(path.join(f.target, 'data')), dataEntries)
})
for (const changed of ['oversized', 'changed-open-file', 'changed-parent']) test('removal proof bounds allocation and pins open bytes and private job parents: ' + changed, async t => {
  const f = await removalProofFixture(t), physical = (await import('../physical-fs.cjs')).default.promises
  if (changed === 'oversized') { const handle = await fs.open(f.file, 'r+'); try { await handle.truncate(128 * 1024 * 1024 + 1) } finally { await handle.close() } }
  const open = physical.open.bind(physical)
  let proofReads = 0, injected = false
  const spy = t.mock.method(physical, 'open', async function(file, ...args) {
    const handle = await open(file, ...args)
    if (file === f.file) {
      proofReads++
      const read = handle.read.bind(handle)
      t.mock.method(handle, 'read', async function(...values) {
        const response = await read(...values)
        if (!injected) {
          injected = true
          if (changed === 'changed-open-file') await fs.appendFile(f.file, ' ')
          else if (changed === 'changed-parent') { const directory = path.dirname(f.file); await fs.rename(directory, directory + '.retained'); (await import('../desktop-management.cjs')).default.ensurePrivateDataRoot(directory) }
        }
        return response
      })
    }
    return handle
  })
  try { await assert.rejects(f.backend.readDesktopRemovalProof(f.target), { code: 'CRABOT_DESKTOP_REMOVAL' }) }
  finally { spy.mock.restore() }
  assert.equal(proofReads, changed === 'oversized' ? 0 : 1)
  assert.equal(await fs.readFile(path.join(f.target, 'data/retained-user-file'), 'utf8'), 'user content')
})

test('GUI byte verification works independently after the paired Core has been removed', async t => {
  const f = await fixture(t), record = (await verifyDesktopPayload(f.payload)).record
  await fs.rm(f.core, { recursive: true })
  const { verifyDesktopGui } = await import('../desktop-payload.mjs')
  const checked = await verifyDesktopGui(f.gui, record)
  assert.equal(checked.bytes, Object.values(record.gui).reduce((sum, entry) => sum + BigInt(entry.size ?? 0), 0n))
  await fs.writeFile(path.join(f.gui, 'unexpected-user-file'), 'retain unknown files')
  await assert.rejects(verifyDesktopGui(f.gui, record), { code: 'CRABOT_CORE_INTEGRITY' })
})
for (const mode of ['success', 'cancelled', 'space', 'copy-changed', 'selection-changed', 'lock-lost', 'final-cancel', 'active-version', 'bad-version', 'active-workspace']) {
  test('private macOS/Windows removal GUI preparation never publishes a removal or starts business: ' + mode, { skip: process.platform === 'linux' }, async t => {
    const f = await fixture(t, { executableNode: false }), prepared = await prepareDesktopInstallation({ payload: f.payload, installRoot: f.target })
    await commitDesktopInstallation(prepared)
    await fs.writeFile(path.join(f.target, 'data/retained-user-file'), 'unchanged')
    const { prepareDesktopRemovalGui } = await import('../desktop-removal-host.mjs')
    const physical = (await import('../physical-fs.cjs')).default.promises, management = (await import('../desktop-management.cjs')).default
    const create = management.ensurePrivateDataRoot.bind(management), roots = [], copy = physical.cp.bind(physical), abort = new AbortController()
    const rootSpy = t.mock.method(management, 'ensurePrivateDataRoot', file => {
      const result = create(file)
      if (path.basename(file).startsWith('crabot-removal-host-')) roots.push(result)
      return result
    })
    t.after(async () => { rootSpy.mock.restore(); for (const root of roots) await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
    if (mode === 'space') t.mock.method(physical, 'statfs', async () => ({ bavail: 0n, bsize: 4096n }))
    if (mode === 'copy-changed') t.mock.method(physical, 'cp', async (...args) => { await copy(...args); if (roots.some(root => args[1] === path.join(root, 'gui'))) await fs.writeFile(path.join(args[1], 'unknown'), 'changed copy') })
    if (mode === 'active-version') await fs.writeFile(path.join(f.target, 'data/desktop-maintenance.json'), JSON.stringify({ schema_version: 3 }))
    else if (mode === 'bad-version') await fs.mkdir(path.join(f.target, 'data/desktop-maintenance.json'))
    else if (mode === 'active-workspace') { await fs.mkdir(path.join(f.target, 'data/workspace-control')); await fs.mkdir(path.join(f.target, 'data/workspace-control/relocation-active')) }
    const progress = phase => {
      if (mode === 'cancelled' && phase === 'copying' || mode === 'final-cancel' && phase === 'prepared') abort.abort(new Error('cancelled host'))
      if (mode === 'selection-changed' && phase === 'copying') writeFileSync(path.join(f.target, 'current-release.json'), JSON.stringify({ ...f.selection, gui_id: randomUUID() }) + '\n')
      if (mode === 'lock-lost' && phase === 'copying') {
        const require = createRequire(import.meta.url)
        require('../cli-lock.mjs').releaseCliLock(path.join(f.target, 'cli.lock'))
      }
    }
    const pending = prepareDesktopRemovalGui({ installRoot: f.target, operationId: randomUUID(), signal: abort.signal, progress })
    if (mode === 'success') {
      const host = await pending
      assert.deepEqual(await fs.readdir(host.directory), ['gui'])
      assert.deepEqual(host.proof.source_selection, f.selection)
      assert.equal(host.guiRoot, path.join(host.directory, 'gui'))
      if (windows) assert.equal(identity.isPrivateDirectory(host.directory), true)
      else { const stat = await fs.lstat(host.directory); assert.equal(stat.mode & 0o777, 0o700); assert.equal(stat.uid, process.getuid()) }
      assert.notEqual(host.guiRoot, prepared.guiRoot)
      assert.deepEqual(await fs.readFile(host.executable), await fs.readFile(path.join(prepared.guiRoot, path.relative(host.guiRoot, host.executable))))
      assert.equal((await import('../desktop-payload.mjs')).verifyDesktopGui instanceof Function, true)
      await (await import('../desktop-payload.mjs')).verifyDesktopGui(host.guiRoot, host.proof.payload)
    } else {
      await assert.rejects(pending, mode.includes('cancel') ? /cancelled host/ : mode === 'space' ? { code: 'CRABOT_UPDATE_SPACE' } : undefined)
      for (const root of roots) await assert.rejects(fs.lstat(root), { code: 'ENOENT' })
    }
    await assert.rejects(fs.lstat(path.join(f.target, '.desktop-removal.json')), { code: 'ENOENT' })
    await assert.rejects(fs.lstat(path.join(f.target, 'app/removals')), { code: 'ENOENT' })
    assert.equal(await fs.readFile(path.join(f.target, 'data/retained-user-file'), 'utf8'), 'unchanged')
    assert.equal(await fs.readFile(path.join(prepared.coreRoot, 'cli.mjs'), 'utf8'), `console.log(JSON.stringify({version:${JSON.stringify('1.2.3')},required:process.env.CRABOT_PRODUCT_REQUIRED}))`)
  })
}

test('initial removal host inspection rejects an ordinary Node caller without publishing any operation', async t => {
  const f = await fixture(t, { executableNode: false }), prepared = await prepareDesktopInstallation({ payload: f.payload, installRoot: f.target })
  await commitDesktopInstallation(prepared)
  const { inspectInitialRemovalGuiHost } = await import('../desktop-removal-frame.mjs')
  const before = await fs.readdir(f.target), data = await fs.readdir(path.join(f.target, 'data'))
  await assert.rejects(inspectInitialRemovalGuiHost({ installRoot: f.target, operationId: randomUUID() }), { code: 'CRABOT_DESKTOP_REMOVAL', stage: 'transport' })
  assert.deepEqual(await fs.readdir(f.target), before); assert.deepEqual(await fs.readdir(path.join(f.target, 'data')), data)
})


test('initial removal publication refuses ordinary Node and releases both locks without a fence or blank data', async t => {
  const f = await fixture(t, { executableNode: false }), prepared = await prepareDesktopInstallation({ payload: f.payload, installRoot: f.target })
  await commitDesktopInstallation(prepared)
  const { beginInitialDesktopRemoval } = await import('../desktop-removal-job.mjs')
  const { acquireExistingCliLock, releaseCliLock } = await import('../cli-lock.mjs')
  await assert.rejects(beginInitialDesktopRemoval({ installRoot: f.target, operationId: randomUUID() }), { code: 'CRABOT_DESKTOP_REMOVAL', stage: 'transport' })
  await assert.rejects(fs.lstat(path.join(f.target, '.desktop-removal.json')), { code: 'ENOENT' })
  await assert.rejects(fs.lstat(path.join(f.target, 'app/removals')), { code: 'ENOENT' })
  for (const directory of [f.target, path.join(f.target, 'data')]) {
    const lock = await acquireExistingCliLock(directory, 'verify-release', 0); releaseCliLock(lock)
  }
  await fs.rm(path.join(f.target, 'data'), { recursive: true })
  await assert.rejects(beginInitialDesktopRemoval({ installRoot: f.target, operationId: randomUUID() }))
  await assert.rejects(fs.lstat(path.join(f.target, 'data')), { code: 'ENOENT' })
})

for (const mode of ['missing', 'intact', 'damaged', 'completed', 'wrong-operation', 'older-package', 'changed-proof', 'no-stop-proof', 'running', 'module', 'changed-command', 'copy-cancel', 'copy-failure', 'publication-lost', 'prepared-lost', 'changed-job', 'changed-data', 'lost-lock', 'late-proof', 'missing-source-proof', 'metadata-change', 'missing-data', 'publication-cancel', 'late-cache-mode', 'cached-no-copy', 'core-only', 'gui-only', 'damaged-metadata', 'cache-race', 'foreign-program']) test('removal-fenced original programs reinstall without starting or clearing protection: ' + mode, { skip: windows && mode === 'late-cache-mode' }, async t => {
  const f = await removalProofFixture(t), { privateJson, readPending } = await import('../desktop-preparation-files.mjs')
  const { acquireExistingCliLock, releaseCliLock, cliLockToken, hasInheritedCliLock } = await import('../cli-lock.mjs')
  f.record.phase = mode === 'completed' ? 'completed' : 'removing'; await f.publish()
  const data = path.join(f.target, 'data'), fence = path.join(f.target, '.desktop-removal.json'), marker = path.join(f.target, '.desktop-installing.json')
  const fenceBytes = await fs.readFile(fence), selector = await fs.readFile(path.join(f.target, 'current-release.json'))
  const command = path.join(f.target, 'bin', launcher)
  if (mode === 'damaged-metadata') {
    const file = path.join(f.prepared.coreRoot, 'core-release.json'), record = JSON.parse(await fs.readFile(file))
    await fs.writeFile(file, JSON.stringify({ ...record, commit: '2'.repeat(40) }) + '\n')
  } else if (mode === 'damaged') {
    await fs.writeFile(path.join(f.prepared.coreRoot, 'cli.mjs'), 'damaged original Core')
    await fs.writeFile(path.join(f.prepared.coreRoot, 'custom-user-file'), 'preserve changed program directory content')
    await fs.writeFile(path.join(f.prepared.guiRoot, path.relative(f.gui, f.resources), 'app.asar'), 'damaged GUI')
  } else if (!['intact', 'cached-no-copy', 'foreign-program'].includes(mode)) {
    if (!['gui-only', 'cache-race'].includes(mode)) { await fs.rm(f.prepared.coreRoot, { recursive: true }); await fs.unlink(command) }
    if (mode !== 'core-only') await fs.rm(f.prepared.guiRoot, { recursive: true })
  }
  if (mode === 'missing-source-proof') await fs.unlink(path.join(f.target, '.desktop-install-payload.json'))
  if (mode === 'missing-data') await fs.rename(data, data + '-original')
  if (mode === 'metadata-change') { const file = path.join(f.core, 'core-release.json'), record = JSON.parse(await fs.readFile(file)); await fs.writeFile(file, JSON.stringify({ ...record, commit: '2'.repeat(40) }) + '\n') }
  let stoppedCalls = 0
  const options = { installRoot: f.target, payload: f.payload, operationId: f.record.operation_id, verifyStopped: async () => {
    stoppedCalls++
    for (const directory of [f.target, data]) {
      const token = cliLockToken(path.join(directory, 'cli.lock')); assert.ok(token); assert.equal(hasInheritedCliLock(directory, token), true)
    }
  } }
  if (mode === 'wrong-operation') options.operationId = randomUUID()
  if (mode === 'older-package') options.payload = (await fixture(t, { version: '1.2.2', executableNode: false })).payload
  if (mode === 'changed-proof') await fs.appendFile(f.file, ' ')
  if (mode === 'no-stop-proof') delete options.verifyStopped
  if (mode === 'running') await fs.writeFile(path.join(data, 'mm.pid'), String(process.pid))
  if (mode === 'module') { await fs.mkdir(path.join(data, 'module-runtime-registry/records'), { recursive: true }); await fs.writeFile(path.join(data, 'module-runtime-registry/records/unknown.json'), '{}') }
  if (mode === 'changed-command') await fs.writeFile(command, 'custom command, preserve')
  const abort = new AbortController()
  if (mode === 'publication-cancel') options.signal = abort.signal
  if (mode === 'copy-cancel') { options.signal = abort.signal; options.progress = phase => { if (phase === 'copying') abort.abort() } }
  const cp = fs.cp, rename = fs.rename
  let injected = false, dataMoved = false, dataMoveError
  if (['copy-failure', 'changed-data'].includes(mode)) t.mock.method(fs, 'cp', async (...args) => {
    if (mode === 'copy-failure') throw Object.assign(new Error('fixture failed copy'), { code: 'EIO' })
    const result = await cp(...args)
    if (!injected) {
      injected = true
      try { await fs.rename(data, data + '-original'); dataMoved = true }
      catch (error) { dataMoveError = error; throw error }
      await fs.mkdir(data, { mode: 0o700 })
    }
    return result
  })
  if (mode === 'lost-lock') options.verifyStopped = async () => releaseCliLock(path.join(data, 'cli.lock'))
  let fault
  if (['publication-lost', 'prepared-lost', 'changed-job', 'publication-cancel'].includes(mode)) fault = t.mock.method(fs, 'rename', async (from, to) => {
    const result = await rename(from, to)
    if (to === f.prepared.coreRoot && from.includes('.preparing-reinstall-')) {
      if (mode === 'publication-cancel') abort.abort()
      if (mode === 'publication-lost') throw Object.assign(new Error('fixture program reply lost'), { code: 'EIO' })
      if (mode === 'changed-job') await privateJson(fence, { ...f.record, phase: 'completed' }, true)
    }
    if (mode === 'prepared-lost' && to === marker && (await readPending(f.target))?.phase === 'prepared') throw Object.assign(new Error('fixture prepared reply lost'), { code: 'EIO' })
    return result
  })
  if (mode === 'late-proof') {
    const lstat = fs.lstat, verify = options.verifyStopped
    let afterStopProof = false
    options.verifyStopped = async () => { await verify(); afterStopProof = true }
    t.mock.method(fs, 'lstat', async (...args) => {
      const inject = args[0] === marker && afterStopProof
      if (args[0] === marker) afterStopProof = false
      const stat = await lstat(...args)
      if (inject && !injected) { injected = true; await fs.appendFile(f.file, ' ') }
      return stat
    })
  }
  if (mode === 'late-cache-mode') {
    const cache = path.join(f.target, 'app/payloads'), file = path.join(cache, f.selection.gui_id + '.json'), lstat = fs.lstat
    await fs.mkdir(cache, { mode: 0o700 }); await privateJson(file, f.proof.payload)
    let reads = 0
    t.mock.method(fs, 'lstat', async (...args) => { if (args[0] === file && ++reads === 3) await fs.chmod(file, 0o644); return lstat(...args) })
  }
  const copiedPrograms = []
  if (['cached-no-copy', 'core-only', 'gui-only', 'damaged-metadata', 'cache-race'].includes(mode)) {
    t.mock.method(fs, 'cp', async (...args) => {
      copiedPrograms.push(path.basename(args[0])); const result = await cp(...args)
      if (mode === 'cache-race' && !injected) { injected = true; await fs.appendFile(path.join(f.prepared.coreRoot, 'cli.mjs'), ' changed cached Core') }
      return result
    })
    if (mode === 'cached-no-copy') t.mock.method(fs, 'statfs', async () => ({ bavail: 512n * 1024n * 1024n + 1n, bsize: 1n }))
  }
  if (mode === 'foreign-program') { const owned = identity.isOwnedDirectory; t.mock.method(identity, 'isOwnedDirectory', directory => directory !== f.prepared.guiRoot && owned(directory)) }
  const { prepareDesktopRemovalReinstall } = await import('../desktop-reinstall.mjs')
  if (['wrong-operation', 'older-package', 'changed-proof', 'no-stop-proof', 'running', 'module', 'changed-command', 'copy-cancel', 'copy-failure', 'changed-job', 'changed-data', 'lost-lock', 'late-proof', 'metadata-change', 'missing-data', 'late-cache-mode', 'cache-race', 'foreign-program'].includes(mode)) {
    await assert.rejects(prepareDesktopRemovalReinstall(options))
    if (!['changed-job', 'late-proof', 'late-cache-mode'].includes(mode)) await assert.rejects(fs.lstat(marker), { code: 'ENOENT' })
    if (mode === 'changed-command') assert.equal(await fs.readFile(command, 'utf8'), 'custom command, preserve')
  } else {
    if (fault && mode !== 'publication-cancel') { await assert.rejects(prepareDesktopRemovalReinstall(options)); fault.mock.restore() }
    const pending = await readPending(f.target)
    const result = await prepareDesktopRemovalReinstall(options)
    assert.deepEqual(result, f.prepared); assert.deepEqual(await verifyDesktopPayload(f.payload).then(value => value.record), f.proof.payload)
    assert.equal((await readPending(f.target)).phase, 'prepared')
    if (pending) assert.equal((await readPending(f.target)).id, pending.id)
    if (['cached-no-copy', 'core-only', 'gui-only', 'damaged-metadata'].includes(mode)) assert.deepEqual(copiedPrograms, mode === 'cached-no-copy' ? [] : [mode === 'gui-only' ? 'gui' : 'core'])
    copiedPrograms.length = 0
    assert.deepEqual(await prepareDesktopRemovalReinstall({ ...options, signal: undefined }), result)
    if (['cached-no-copy', 'core-only', 'gui-only', 'damaged-metadata'].includes(mode)) assert.deepEqual(copiedPrograms, [])
    const retained = await (await import('../desktop-program-proof.mjs')).readOriginalDesktopPayload(f.target, f.selection)
    assert.equal(retained.file, path.join(f.target, 'app/payloads', f.selection.gui_id + '.json')); assert.equal(retained.text, JSON.stringify(f.proof.payload) + '\n')
    assert.deepEqual(await fs.readFile(command), await fs.readFile(path.join(f.core, 'bin', launcher)))
    assert.ok(stoppedCalls > 0)
    if (mode === 'damaged-metadata') assert.equal(await fs.readFile(path.join(f.prepared.coreRoot, 'core-release.json'), 'utf8'), f.proof.core.release)
    if (mode === 'damaged') {
      const directory = (await fs.readdir(path.dirname(f.prepared.coreRoot))).find(name => name.startsWith('.damaged-'))
      assert.ok(directory); assert.equal(await fs.readFile(path.join(path.dirname(f.prepared.coreRoot), directory, 'custom-user-file'), 'utf8'), 'preserve changed program directory content')
    }
  }
  if (mode === 'changed-data') {
    assert.equal(injected, true)
    if (!dataMoved) {
      assert.equal(windows, true, 'Unix must exercise the actual directory identity change')
      assert.ok(['EPERM', 'EACCES', 'EBUSY'].includes(dataMoveError?.code), 'Only a native locked-directory refusal may leave the original path')
      await assert.rejects(fs.lstat(data + '-original'), { code: 'ENOENT' })
    }
    console.info('CRABOT_REINSTALL_DATA_RENAME ' + JSON.stringify({ moved: dataMoved, native_refusal: dataMoveError?.code ?? null }))
  }
  if (mode === 'cache-race') { assert.equal(injected, true); await assert.rejects(fs.lstat(f.prepared.guiRoot), { code: 'ENOENT' }) }
  if (mode === 'late-proof') { assert.equal(injected, true); await assert.rejects(fs.lstat(f.prepared.coreRoot), { code: 'ENOENT' }) }
  if (mode !== 'changed-job') assert.deepEqual(await fs.readFile(fence), fenceBytes)
  assert.deepEqual(await fs.readFile(path.join(f.target, 'current-release.json')), selector)
  assert.equal(await fs.readFile(path.join(dataMoved || mode === 'missing-data' ? data + '-original' : data, 'retained-user-file'), 'utf8'), 'user content')
  assert.throws(() => installation.readDesktopSelection(f.target), { code: mode === 'missing-data' ? 'CRABOT_DESKTOP_INSTALLATION' : 'CRABOT_DESKTOP_REMOVAL_PENDING' })
  if (mode === 'missing-data') await assert.rejects(fs.lstat(data), { code: 'ENOENT' })
  for (const directory of mode === 'missing-data' ? [f.target] : [f.target, data]) { const lock = await acquireExistingCliLock(directory, 'verify-reinstall-release', 0); releaseCliLock(lock) }
})


for (const mode of ['compatible', 'migration', 'newer', 'invalid', 'missing-programs', 'wrong-operation', 'running', 'source-change', 'fence-change', 'prepared', 'completed', 'cancelled', 'other-preparation', 'late-lock']) test('removal reinstall inspects data versions without target code or data changes: ' + mode, async t => {
  const f = await removalProofFixture(t, { schema: 'v2' }), data = path.join(f.target, 'data'), directory = path.join(data, 'fixture')
  const { privateJson } = await import('../desktop-preparation-files.mjs'), locks = await import('../cli-lock.mjs')
  await fs.mkdir(directory); await fs.writeFile(path.join(directory, 'content'), 'keep user bytes')
  const version = mode === 'migration' ? 'v1' : mode === 'newer' ? 'v3' : mode === 'invalid' ? 'invalid' : 'v2'
  await fs.writeFile(path.join(directory, 'SCHEMA_VERSION'), version + '\n')
  if (mode === 'missing-programs') { await fs.rm(f.prepared.coreRoot, { recursive: true }); await fs.rm(f.prepared.guiRoot, { recursive: true }) }
  if (mode === 'completed') { f.record.phase = 'completed'; await f.publish() }
  if (mode === 'source-change') await fs.writeFile(path.join(f.core, 'crabot-fixture/schema_version'), 'v3')
  if (mode === 'running') await fs.writeFile(path.join(data, 'mm.pid'), String(process.pid))
  if (['prepared', 'other-preparation', 'late-lock'].includes(mode)) await privateJson(path.join(f.target, '.desktop-installing.json'), { schema_version: 1, id: randomUUID(), installation_id: f.prepared.installation_id,
    selection: f.selection, phase: 'prepared', payload_sha256: mode === 'other-preparation' ? '0'.repeat(64) : createHash('sha256').update(JSON.stringify(f.proof.payload) + '\n').digest('hex') })
  const marker = path.join(f.target, '.desktop-removal.json'), before = await fs.readFile(marker)
  let exitsChecked = 0
  const input = { installRoot: f.target, payload: f.payload, operationId: mode === 'wrong-operation' ? randomUUID() : f.record.operation_id,
    verifyStopped: async () => {
      exitsChecked++
      for (const root of [f.target, data]) assert.equal(locks.hasInheritedCliLock(root, locks.cliLockToken(path.join(root, 'cli.lock'))), true)
      if (mode === 'fence-change') await privateJson(marker, { ...f.record, phase: 'completed' }, true)
    }, ...(mode === 'cancelled' ? { signal: AbortSignal.abort() } : {}) }
  if (mode === 'late-lock') {
    const readFile = fs.readFile; let reads = 0
    t.mock.method(fs, 'readFile', async (...args) => { if (args[0] === path.join(f.target, '.desktop-installing.json') && ++reads === 4) locks.releaseCliLock(path.join(data, 'cli.lock')); return readFile(...args) })
  }
  const { inspectDesktopReinstallData } = await import('../desktop-reinstall-data.mjs')
  if (['newer', 'invalid', 'wrong-operation', 'running', 'source-change', 'fence-change', 'cancelled', 'other-preparation', 'late-lock'].includes(mode)) {
    await assert.rejects(inspectDesktopReinstallData(input), mode === 'newer' ? { code: 'CRABOT_DATA_NEWER_THAN_CODE' } : mode === 'invalid' ? { code: 'CRABOT_SCHEMA_VERSION_INVALID' } : undefined)
  } else {
    const pending = await inspectDesktopReinstallData(input)
    if (mode === 'migration') assert.deepEqual(pending, [{ moduleId: 'crabot-fixture', codeVersion: 'v2', dataVersion: 'v1', dataDir: directory }])
    else assert.deepEqual(pending, [])
    assert.ok(exitsChecked > 0)
  }
  assert.equal(await fs.readFile(path.join(directory, 'SCHEMA_VERSION'), 'utf8'), version + '\n')
  assert.equal(await fs.readFile(path.join(directory, 'content'), 'utf8'), 'keep user bytes')
  assert.equal(await fs.readFile(path.join(data, 'retained-user-file'), 'utf8'), 'user content')
  await assert.rejects(fs.lstat(path.join(directory, 'executions')), { code: 'ENOENT' })
  if (mode !== 'fence-change') assert.deepEqual(await fs.readFile(marker), before)
  if (!['prepared', 'other-preparation', 'late-lock'].includes(mode)) await assert.rejects(fs.lstat(path.join(f.target, '.desktop-installing.json')), { code: 'ENOENT' })
  assert.throws(() => installation.readDesktopSelection(f.target), { code: 'CRABOT_DESKTOP_REMOVAL_PENDING' })
})


for (const mode of ['migration', 'current', 'injected-environment', 'unprepared', 'missing-program', 'changed-program', 'changed-metadata', 'foreign-program', 'broken-shared', 'wrong-operation', 'running', 'cancelled', 'changed-phase', 'late-lock', 'late-job', 'late-cancel']) test('prepared reinstall previews real scopes with bundled Node and keeps all data protected: ' + mode, { timeout: 60000 }, async t => {
  const f = await removalProofFixture(t, { schema: 'v2', functional: true, shared: true }), data = path.join(f.target, 'data'), directory = path.join(data, 'fixture')
  const { prepareDesktopRemovalReinstall } = await import('../desktop-reinstall.mjs')
  if (mode !== 'unprepared') await prepareDesktopRemovalReinstall({ payload: f.payload, installRoot: f.target, operationId: f.record.operation_id, verifyStopped: async () => {} })
  await fs.mkdir(directory); await fs.writeFile(path.join(directory, 'content'), 'preserve this data')
  const version = mode === 'current' ? 'v2' : 'v1'
  await fs.writeFile(path.join(directory, 'SCHEMA_VERSION'), version + '\n')
  if (mode === 'missing-program') await fs.rm(f.prepared.coreRoot, { recursive: true })
  if (mode === 'changed-program') await fs.appendFile(path.join(f.prepared.coreRoot, 'cli.mjs'), 'changed target')
  if (mode === 'changed-metadata') await fs.appendFile(path.join(f.prepared.coreRoot, 'desktop-host.json'), ' ')
  if (mode === 'foreign-program') { const owned = identity.isOwnedDirectory; t.mock.method(identity, 'isOwnedDirectory', directory => directory !== f.prepared.coreRoot && owned(directory)) }
  if (mode === 'broken-shared') { await fs.mkdir(path.join(data, 'agent'), { recursive: true }); await fs.writeFile(path.join(data, 'agent/shared-request-upgrade.json'), '{}') }
  if (mode === 'running') await fs.writeFile(path.join(data, 'mm.pid'), String(process.pid))
  const removal = path.join(f.target, '.desktop-removal.json'), before = await fs.readFile(removal), preparation = await fs.readFile(path.join(f.target, '.desktop-installing.json')).catch(() => null)
  let checked = 0
  const input = { payload: f.payload, installRoot: f.target, operationId: mode === 'wrong-operation' ? randomUUID() : f.record.operation_id,
    verifyStopped: async () => { checked++; if (mode === 'changed-phase') { const { privateJson } = await import('../desktop-preparation-files.mjs'); await privateJson(removal, { ...f.record, phase: 'completed' }, true) } },
    ...(mode === 'cancelled' ? { signal: AbortSignal.abort() } : {}) }
  let injected = false
  if (mode === 'injected-environment') {
    const previous = { NODE_OPTIONS: process.env.NODE_OPTIONS, DATA_DIR: process.env.DATA_DIR }
    t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
    process.env.NODE_OPTIONS = '--require=nonexistent-injection-must-not-run.cjs'; process.env.DATA_DIR = path.join(f.parent, 'wrong-data')
  }
  if (['late-lock', 'late-job', 'late-cancel'].includes(mode)) {
    const open = fs.open, locks = await import('../cli-lock.mjs'), abort = new AbortController(); let reads = 0
    input.signal = abort.signal
    t.mock.method(fs, 'open', async (...args) => {
      const handle = await open(...args)
      if (args[0] === path.join(f.prepared.coreRoot, 'desktop-host.json') && ++reads === 2) {
        injected = true
        if (mode === 'late-lock') locks.releaseCliLock(path.join(data, 'cli.lock'))
        else if (mode === 'late-cancel') abort.abort()
        else writeFileSync(removal, JSON.stringify({ ...f.record, phase: 'completed' }) + '\n')
      }
      return handle
    })
  }
  const { previewPreparedDesktopReinstallData } = await import('../desktop-reinstall-data.mjs')
  if (['migration', 'current', 'injected-environment'].includes(mode)) {
    const preview = await previewPreparedDesktopReinstallData(input)
    assert.ok(checked > 0); assert.equal(preview.shared.status, 'pending'); assert.equal(preview.shared.files, 0)
    assert.equal(preview.modules.length, mode === 'current' ? 0 : 1)
    assert.equal(preview.backup_bytes, mode === 'current' ? 0 : Buffer.byteLength('preserve this data') + 3)
    if (mode !== 'current') {
      assert.equal(preview.modules[0].dataDir, directory)
      assert.equal(preview.modules[0].codeVersion, 'v2'); assert.equal(preview.modules[0].dataVersion, 'v1')
      assert.ok(preview.modules[0].scope.writes.includes(path.join('fixture', 'content')))
    }
  } else await assert.rejects(previewPreparedDesktopReinstallData(input))
  assert.equal(await fs.readFile(path.join(directory, 'content'), 'utf8'), 'preserve this data')
  assert.equal(await fs.readFile(path.join(directory, 'SCHEMA_VERSION'), 'utf8'), version + '\n')
  assert.equal(await fs.readFile(path.join(data, 'retained-user-file'), 'utf8'), 'user content')
  for (const name of ['fixture/executions', '.upgrade-migrations', 'shared-request-upgrade-v2']) await assert.rejects(fs.lstat(path.join(data, name)), { code: 'ENOENT' })
  if (['late-lock', 'late-job', 'late-cancel'].includes(mode)) assert.equal(injected, true, 'The real Node preview must finish before this fault')
  if (!['changed-phase', 'late-job'].includes(mode)) assert.deepEqual(await fs.readFile(removal), before)
  assert.deepEqual(await fs.readFile(path.join(f.target, '.desktop-installing.json')).catch(() => null), preparation)
  assert.throws(() => installation.readDesktopSelection(f.target), { code: 'CRABOT_DESKTOP_REMOVAL_PENDING' })
})

test('restored original pair hands off to existing version protection without starting or claiming health', async t => {
  const f = await removalProofFixture(t, { schema: 'v2', functional: true })
  f.record.phase = 'completed'; await f.publish()
  const data = path.join(f.target, 'data'), directory = path.join(data, 'fixture')
  await fs.mkdir(directory); await fs.writeFile(path.join(directory, 'SCHEMA_VERSION'), 'v1'); await fs.writeFile(path.join(directory, 'content'), 'before')
  const { prepareDesktopRemovalReinstall } = await import('../desktop-reinstall.mjs')
  await prepareDesktopRemovalReinstall({ payload: f.payload, installRoot: f.target, operationId: f.record.operation_id, verifyStopped: async () => {} })
  const code = `
    const {handoffPreparedDesktopReinstall}=await import(process.argv[1]);
    console.log(JSON.stringify(await handoffPreparedDesktopReinstall({payload:process.argv[2],installRoot:process.argv[3],operationId:process.argv[4],registerEntries:async()=>{}})));
  `
  const runtime = (await import('../product-runtime.cjs')).default.loadProductRuntime(f.prepared.coreRoot, { required: true, full: true })
  const result = await promisify(execFile)(runtime.executables.node, ['--input-type=module', '-e', code,
    pathToFileURL(path.join(f.prepared.coreRoot, 'scripts/lib/desktop-reinstall-data.mjs')).href, f.payload, f.target, f.record.operation_id],
    { env: { PATH: '', ...(windows ? { SystemRoot: process.env.SystemRoot } : {}) }, timeout: 45000, maxBuffer: 65536 })
  const handoff = JSON.parse(result.stdout)
  assert.equal(handoff.verification_pending, true); assert.equal(handoff.health_verified, false)
  assert.deepEqual(installation.readDesktopSelection(f.target).selection, f.selection)
  const maintenance = (await import('../version-maintenance.mjs'))
  assert.equal(maintenance.readVersionMaintenance(data).phase, 'installing')
  assert.throws(() => maintenance.assertVersionMaintenanceAllowsStart(data), { code: 'CRABOT_MAINTENANCE_PENDING' })
  assert.equal(await fs.readFile(path.join(directory, 'content'), 'utf8'), 'before', 'target main, not installer handoff, owns necessary conversion')
  await assert.rejects(fs.lstat(path.join(directory, 'executions')), { code: 'ENOENT' })
  await assert.rejects(fs.lstat(path.join(data, 'mm.pid')), { code: 'ENOENT' })
  assert.equal(await fs.readFile(path.join(data, 'retained-user-file'), 'utf8'), 'user content')
})

for (const fault of ['entries', 'preparing-reply', 'installing-reply', 'program-fence-reply', 'removal-fence-reply']) test('reinstall handoff preserves effective protection after a lost result: ' + fault, async t => {
  const f = await removalProofFixture(t, { schema: 'v2', functional: true })
  f.record.phase = 'completed'; await f.publish()
  const data = path.join(f.target, 'data'), versionFile = path.join(data, 'desktop-maintenance.json')
  const { prepareDesktopRemovalReinstall } = await import('../desktop-reinstall.mjs')
  await prepareDesktopRemovalReinstall({ payload: f.payload, installRoot: f.target, operationId: f.record.operation_id, verifyStopped: async () => {} })
  const runtime = (await import('../product-runtime.cjs')).default.loadProductRuntime(f.prepared.coreRoot, { required: true, full: true })
  const module = pathToFileURL(path.join(f.prepared.coreRoot, 'scripts/lib/desktop-reinstall-data.mjs')).href
  const code = `
    import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import{syncBuiltinESMExports}from'node:module';
    const [module,payload,root,id,fault]=process.argv.slice(1),data=path.join(root,'data');
    const versions=await import(new URL('./version-maintenance.mjs',module));
    const rename=fs.renameSync,unlink=fs.promises.unlink;let fired=false;
    fs.renameSync=(from,to)=>{rename(from,to);if(!fired&&to===path.join(data,'desktop-maintenance.json')&&['preparing-reply','installing-reply'].includes(fault)){
      const record=JSON.parse(fs.readFileSync(to));if(record.phase===fault.split('-')[0]){fired=true;throw new Error('synthetic lost publication reply')}}};
    fs.promises.unlink=async file=>{
      if([path.join(root,'.desktop-installing.json'),path.join(root,'.desktop-removal.json')].includes(file)){
        assert.ok(['installing','verifying'].includes(versions.readVersionMaintenance(data).phase));
        assert.throws(()=>versions.assertVersionMaintenanceAllowsStart(data),{code:'CRABOT_MAINTENANCE_PENDING'});
      }
      await unlink(file);
      if(!fired&&((fault==='program-fence-reply'&&file===path.join(root,'.desktop-installing.json'))||(fault==='removal-fence-reply'&&file===path.join(root,'.desktop-removal.json')))){fired=true;throw new Error('synthetic lost unlink reply')}
    };
    syncBuiltinESMExports();
    const {handoffPreparedDesktopReinstall}=await import(module);
    try{await handoffPreparedDesktopReinstall({payload,installRoot:root,operationId:id,registerEntries:async()=>{if(fault==='entries')throw new Error('synthetic entry failure')}})}
    catch(error){if(fault==='none')throw error;console.log(JSON.stringify({failed:true}));process.exitCode=17}
  `
  const execute = mode => promisify(execFile)(runtime.executables.node, ['--input-type=module', '-e', code, module, f.payload, f.target, f.record.operation_id, mode],
    { env: { PATH: '', ...(windows ? { SystemRoot: process.env.SystemRoot } : {}) }, timeout: 45000, maxBuffer: 65536 })
  await assert.rejects(execute(fault), error => error.code === 17)
  const versions = await import('../version-maintenance.mjs'), record = versions.readVersionMaintenance(data)
  if (fault === 'entries') assert.equal(record, null)
  else assert.throws(() => versions.assertVersionMaintenanceAllowsStart(data), { code: 'CRABOT_MAINTENANCE_PENDING' })
  if (fault === 'removal-fence-reply') assert.deepEqual(installation.readDesktopSelection(f.target).selection, f.selection)
  else {
    assert.throws(() => installation.readDesktopSelection(f.target), { code: 'CRABOT_DESKTOP_REMOVAL_PENDING' })
    await execute('none')
    assert.deepEqual(installation.readDesktopSelection(f.target).selection, f.selection)
    assert.equal(versions.readVersionMaintenance(data).phase, 'installing')
    if (record) assert.equal(versions.readVersionMaintenance(data).id, record.id, 'retry keeps the same maintenance job')
  }
  await assert.rejects(fs.lstat(path.join(data, 'mm.pid')), { code: 'ENOENT' })
  assert.equal(await fs.readFile(path.join(data, 'retained-user-file'), 'utf8'), 'user content')
  await assert.rejects(fs.lstat(versionFile + '.new'), { code: 'ENOENT' })
})

for (const mode of ['wrong-operation', 'active-module', 'program-changed', 'lost-lock', 'foreign-maintenance']) test('reinstall handoff rejects changed ownership or programs without releasing protection: ' + mode, async t => {
  const f = await removalProofFixture(t, { schema: 'v2', functional: true })
  f.record.phase = 'completed'; await f.publish()
  const data = path.join(f.target, 'data')
  const { prepareDesktopRemovalReinstall } = await import('../desktop-reinstall.mjs')
  await prepareDesktopRemovalReinstall({ payload: f.payload, installRoot: f.target, operationId: f.record.operation_id, verifyStopped: async () => {} })
  if (mode === 'active-module') { await fs.mkdir(path.join(data, 'module-runtime-registry/records'), { recursive: true }); await fs.writeFile(path.join(data, 'module-runtime-registry/records/active.json'), '{}') }
  const code = `
    import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
    const [module,payload,root,id,mode]=process.argv.slice(1);
    const versions=await import(new URL('./version-maintenance.mjs',module)),locks=await import(new URL('./cli-lock.mjs',module));
    const {handoffPreparedDesktopReinstall}=await import(module);
    if(mode==='foreign-maintenance'){
      const lock=await locks.acquireExistingCliLock(path.join(root,'data'),'other-job');
      try{await versions.beginVersionMaintenance(path.join(root,'data'),fileURLToPath(new URL('../../',module)),'9.9.9',undefined,{dataProtection:'scoped'})}finally{locks.releaseCliLock(lock)}
    }
    await handoffPreparedDesktopReinstall({payload,installRoot:root,operationId:id,registerEntries:async prepared=>{
      if(mode==='program-changed')fs.appendFileSync(path.join(prepared.coreRoot,'package.json'),'changed');
      if(mode==='lost-lock')locks.releaseCliLock(path.join(root,'data','cli.lock'));
    }});
  `
  const runtime = (await import('../product-runtime.cjs')).default.loadProductRuntime(f.prepared.coreRoot, { required: true, full: true })
  await assert.rejects(promisify(execFile)(runtime.executables.node, ['--input-type=module', '-e', code,
    pathToFileURL(path.join(f.prepared.coreRoot, 'scripts/lib/desktop-reinstall-data.mjs')).href, f.payload, f.target, mode === 'wrong-operation' ? randomUUID() : f.record.operation_id, mode],
    { env: { PATH: '', ...(windows ? { SystemRoot: process.env.SystemRoot } : {}) }, timeout: 45000, maxBuffer: 65536 }))
  assert.throws(() => installation.readDesktopSelection(f.target), { code: 'CRABOT_DESKTOP_REMOVAL_PENDING' })
  assert.ok(await fs.stat(path.join(f.target, '.desktop-installing.json')))
  assert.equal(await fs.readFile(path.join(data, 'retained-user-file'), 'utf8'), 'user content')
  await assert.rejects(fs.lstat(path.join(data, 'mm.pid')), { code: 'ENOENT' })
})

for (const [outcome, version] of [['ready'], ['health-failed'], ['migration-interrupted'], ['ready', '1.2.3'], ['ready', '1.2.4'], ['health-failed', '1.2.4'], ['migration-interrupted', '1.2.4']]) test('actual GUI controller runs restored-pair recovery and keeps failed health protected: ' + outcome + (version ? ' new target ' + version : ''), { skip: process.env.CRABOT_PAIRED_CONTROLLER_TEST !== '1' }, async t => {
  const f = await removalProofFixture(t, { schema: 'v2', functional: true })
  f.record.phase = 'completed'; await f.publish()
  const data = path.join(f.target, 'data'), directory = path.join(data, 'fixture')
  await fs.mkdir(directory); await fs.writeFile(path.join(directory, 'SCHEMA_VERSION'), 'v1'); await fs.writeFile(path.join(directory, 'content'), 'before')
  const { prepareDesktopRemovalReinstall } = await import('../desktop-reinstall.mjs')
  const incoming = version ? await fixture(t, { version, schema: 'v2', functional: true }) : f
  if (version) await fs.rm(f.prepared.coreRoot, { recursive: true })
  const prepared = await prepareDesktopRemovalReinstall({ payload: incoming.payload, installRoot: f.target, operationId: f.record.operation_id, verifyStopped: async () => {} })
  const code = `
    import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
    const [module,payload,root,id,outcome,controllerModule,appVersion]=process.argv.slice(1),core=fileURLToPath(new URL('../../',module)),data=path.join(root,'data');
    const {handoffPreparedDesktopReinstall}=await import(module);
    const handoff=await handoffPreparedDesktopReinstall({payload,installRoot:root,operationId:id,registerEntries:async()=>{}});
    const versions=await import(new URL('./version-maintenance.mjs',module));
    const {applyStartupMigrations}=await import(new URL('./core-preparation.mjs',module));
    const {DesktopController}=await import(controllerModule);
    const controller=new DesktopController({coreRoot:core,dataRoot:data,appVersion,platform:process.platform});
    let starts=0,healthy=outcome==='ready';
    // Only the service/health seam is controlled. Ordinary controller admission,
    // scoped conversion, backups and version-fence finalization are actual code.
    controller.startCore=async()=>{
      starts++;
      if(outcome!=='migration-interrupted')await applyStartupMigrations(core,data,{PATH:'',CRABOT_PRODUCT_REQUIRED:'1',...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot}:{})});
      if(healthy)controller.host.publish({phase:'ready',app_version:appVersion,platform:process.platform,instance_id:'1'.repeat(64),generation:'11111111-1111-4111-8111-111111111111',admin_url:'http://127.0.0.1:3000'});
      else controller.host.status('error');
    };
    try{
      if(outcome==='ready')assert.equal(await controller.recoverVersion(),true);
      else{
        await assert.rejects(controller.recoverVersion());
        assert.equal(versions.readVersionMaintenance(data).id,handoff.maintenance_id);
        assert.throws(()=>versions.assertVersionMaintenanceAllowsStart(data));
        healthy=true;
        if(outcome==='migration-interrupted'){await assert.rejects(controller.recoverVersion(),{code:'CRABOT_MIGRATION_INTERRUPTED'});assert.equal(starts,1)}
        else assert.equal(await controller.recoverVersion(),true);
      }
      const pending=versions.readVersionMaintenance(data);
      assert.equal(pending!==null,outcome==='migration-interrupted');
      if(!pending)versions.assertVersionMaintenanceAllowsStart(data);
      console.log(JSON.stringify({starts,protected:pending!==null}));
    }finally{controller.close()}
  `
  const runtime = (await import('../product-runtime.cjs')).default.loadProductRuntime(prepared.coreRoot, { required: true, full: true })
  const result = await promisify(execFile)(runtime.executables.node, ['--input-type=module', '-e', code,
    pathToFileURL(path.join(prepared.coreRoot, 'scripts/lib/desktop-reinstall-data.mjs')).href, incoming.payload, f.target, f.record.operation_id, outcome,
    new URL('../../../crabot-desktop/dist/controller.js', import.meta.url).href, version || '1.2.3'],
    { env: { PATH: '', ...(windows ? { SystemRoot: process.env.SystemRoot } : {}) }, timeout: 45000, maxBuffer: 65536 })
  assert.deepEqual(JSON.parse(result.stdout), { starts: outcome === 'health-failed' ? 2 : 1, protected: outcome === 'migration-interrupted' })
  assert.equal(await fs.readFile(path.join(directory, 'SCHEMA_VERSION'), 'utf8'), outcome === 'migration-interrupted' ? 'v1' : 'v2\n')
  assert.equal(await fs.readFile(path.join(directory, 'content'), 'utf8'), outcome === 'migration-interrupted' ? 'before' : 'converted by bundled Node')
  if (outcome !== 'migration-interrupted') assert.equal(await fs.readFile(path.join(directory, 'executions'), 'utf8'), 'once\n', 'health retry must not replay a committed migration')
  await assert.rejects(fs.lstat(path.join(data, 'mm.pid')), { code: 'ENOENT' })
  assert.equal(await fs.readFile(path.join(data, 'retained-user-file'), 'utf8'), 'user content')
})

for (const failed of [false, true]) test('trusted installer registers entries through the actual target Node and waits for its exit: ' + (failed ? 'entry failure' : 'pending health'), async t => {
  const f = await removalProofFixture(t, { schema: 'v2', functional: true })
  f.record.phase = 'completed'; await f.publish()
  const data = path.join(f.target, 'data')
  const { prepareDesktopRemovalReinstall } = await import('../desktop-reinstall.mjs')
  await prepareDesktopRemovalReinstall({ payload: f.payload, installRoot: f.target, operationId: f.record.operation_id, verifyStopped: async () => {} })
  const { runPreparedDesktopReinstallHandoff } = await import('../desktop-reinstall-data.mjs')
  const { acquireExistingCliLock, releaseCliLock } = await import('../cli-lock.mjs')
  let entries = 0
  const pending = runPreparedDesktopReinstallHandoff({ payload: f.payload, installRoot: f.target, operationId: f.record.operation_id, registerEntries: async prepared => {
    entries++
    assert.deepEqual(prepared, f.prepared)
    for (const directory of [f.target, data]) await assert.rejects(acquireExistingCliLock(directory, 'must-not-steal-target-lock', 0))
    assert.throws(() => installation.readDesktopSelection(f.target), { code: 'CRABOT_DESKTOP_REMOVAL_PENDING' })
    if (failed) throw new Error('OS entry registration failed')
  } })
  if (failed) {
    await assert.rejects(pending, { code: 'CRABOT_DESKTOP_REMOVAL' })
    assert.throws(() => installation.readDesktopSelection(f.target), { code: 'CRABOT_DESKTOP_REMOVAL_PENDING' })
    assert.equal((await import('../version-maintenance.mjs')).readVersionMaintenance(data), null)
  } else {
    const result = await pending
    assert.equal(result.health_verified, false); assert.equal(result.verification_pending, true)
    assert.equal(result.executable, installation.readDesktopSelection(f.target).executable)
  }
  assert.equal(entries, 1)
  for (const directory of [f.target, data]) { const lock = await acquireExistingCliLock(directory, 'handoff-child-exited', 0); releaseCliLock(lock) }
  assert.equal(await fs.readFile(path.join(data, 'retained-user-file'), 'utf8'), 'user content')
  await assert.rejects(fs.lstat(path.join(data, 'mm.pid')), { code: 'ENOENT' })
})

for (const mode of ['fresh', 'completed', 'not-removing', 'cancelled', 'changed-package']) test('actual GUI controller runs retained installer backend routing: ' + mode, { skip: process.env.CRABOT_PAIRED_CONTROLLER_TEST !== '1', timeout: 120000 }, async t => {
  const { prepareRetainedDesktopReinstall } = await import('../../../crabot-desktop/dist/retained-reinstall.js')
  const f = await removalProofFixture(t, { schema: 'v2', functional: true })
  const data = path.join(f.target, 'data'), abort = new AbortController(), phases = []
  f.record.phase = mode === 'not-removing' ? 'preparing' : 'completed'; await f.publish()
  if (mode === 'changed-package') await fs.appendFile(path.join(f.gui, process.platform === 'darwin' ? 'Crabot.app/Contents/MacOS/Crabot' : windows ? 'Crabot.exe' : 'crabot-desktop'), 'changed')
  if (mode === 'cancelled') abort.abort()
  let registered = 0
  const options = { payload: f.payload, installRoot: mode === 'fresh' ? path.join(f.parent, 'fresh-not-created') : f.target, signal: abort.signal,
    registerEntries: async () => { registered++ }, progress: phase => phases.push(phase) }
  if (mode === 'fresh') {
    assert.equal(await prepareRetainedDesktopReinstall(options), null)
    await assert.rejects(fs.lstat(options.installRoot), { code: 'ENOENT' })
  } else if (mode === 'completed') {
    const native = (await import('../../../crabot-desktop/dist/bootstrap/scripts/lib/process-identity.cjs')).default
    const observe = native.inspectProgramReferences, observations = []
    t.mock.method(native, 'inspectProgramReferences', async options => {
      const result = await observe(options)
      observations.push({ complete: result.complete, incomplete: result.incomplete, references: result.processes.length, unknown_stages: result.unknown_stages,
        unknown: await Promise.all(result.unknown_details.filter(item => item.os_error !== 1).slice(0, 8).map(async item => {
          let current
          try { const value = native.inspectProcess(item.pid); if (value) current = { pid: value.pid, parent: value.parent, started: value.started, executable: value.executable } } catch {}
          return { ...item, current, ...(process.platform === 'linux' ? {
            comm: (await fs.readFile('/proc/' + item.pid + '/comm', 'utf8').catch(() => 'unavailable')).trim().slice(0, 64) } : {}) }
        })) })
      return result
    })
    const result = await prepareRetainedDesktopReinstall(options).catch(error => { throw new Error(error.code + ': ' + JSON.stringify(observations)) })
    assert.equal(result.verification_pending, true); assert.equal(result.health_verified, false)
    assert.equal(result.executable, installation.readDesktopSelection(f.target).executable)
    assert.equal(phases.at(-1), 'handing-off'); assert.equal(registered, 1)
  } else {
    await assert.rejects(prepareRetainedDesktopReinstall(options))
    assert.throws(() => installation.readDesktopSelection(f.target), { code: 'CRABOT_DESKTOP_REMOVAL_PENDING' })
    assert.equal(registered, 0)
  }
  assert.equal(await fs.readFile(path.join(data, 'retained-user-file'), 'utf8'), 'user content')
  await assert.rejects(fs.lstat(path.join(data, 'mm.pid')), { code: 'ENOENT' })
})

for (const [damaged, version] of [[false], [true], [false, '1.2.3'], [false, '1.2.4']]) test('actual GUI controller runs ordinary retained installer without declaring unverified service complete: ' + (damaged ? 'invalid package' : 'pending health') + (version ? ' new target ' + version : ''),
  { skip: process.env.CRABOT_PAIRED_CONTROLLER_TEST !== '1', timeout: 120000 }, async t => {
    const f = await removalProofFixture(t, { schema: 'v2', functional: true })
    f.record.phase = 'completed'; await f.publish()
    const incoming = version ? await fixture(t, { version, schema: 'v2', functional: true }) : f
    const selection = (await verifyDesktopPayload(incoming.payload)).record.selection
    if (version) await fs.rm(f.prepared.coreRoot, { recursive: true })
    const resources = path.join(f.parent, 'installer-resources'), home = path.join(f.parent, 'isolated-home'), reportFile = path.join(f.parent, 'installer-report.json')
    await fs.mkdir(resources); await fs.mkdir(home)
    await fs.rename(incoming.payload, path.join(resources, 'offline'))
    if (damaged) await fs.appendFile(path.join(resources, 'offline/core/cli.mjs'), 'changed')
    const installer = path.join(f.parent, 'installer')
    await fs.cp(new URL('../../../crabot-desktop/dist/', import.meta.url), path.join(installer, 'dist'), { recursive: true })
    await fs.cp(path.join(resources, 'offline/core/scripts'), path.join(installer, 'dist/bootstrap/scripts'), { recursive: true })
    await fs.mkdir(path.join(installer, 'node_modules'), { recursive: true })
    await fs.symlink(fileURLToPath(new URL('../../../crabot-client', import.meta.url)), path.join(installer, 'node_modules/crabot-client'), windows ? 'junction' : 'dir')
    await fs.cp(path.join(resources, 'offline/core/node_modules/@electron/asar'), path.join(installer, 'node_modules/@electron/asar'), { recursive: true })
    const options = { root: f.target, home, resources, report: reportFile, application: path.join(f.target, 'app/releases', selection.gui_id, 'Crabot.app'), entry: path.join(installer, 'dist/installer-main.js') }
    if (version) {
      const { registerInstallationEntries } = await import('../../../crabot-desktop/dist/installation-entries.js')
      const shell = { writeShortcutLink() { throw new Error('Native shortcut creation belongs to the Electron actor') }, readShortcutLink() { throw new Error('Native shortcut reading belongs to the Electron actor') } }
      if (!windows) await registerInstallationEntries(f.prepared, { home, platform: process.platform, env: { XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share') }, shell, registerMac: async () => {} })
    }
    const config = path.join(f.parent, 'installer-config.json'); await fs.writeFile(config, JSON.stringify(options))
    const require = createRequire(new URL('../../../crabot-desktop/package.json', import.meta.url)), env = { ...process.env, HOME: home,
      APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'), XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share') }
    for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'DATA_DIR', 'CRABOT_HOME', 'CRABOT_DEV', 'CRABOT_PORT_OFFSET']) delete env[key]
    let report
    try {
      const launched = promisify(execFile)(require('electron'), [fileURLToPath(new URL('../../../crabot-desktop/tests/retained-installer.cjs', import.meta.url)), config],
        { cwd: f.parent, env, timeout: 115000, maxBuffer: 65536 })
      if (damaged) await assert.rejects(launched, error => error.code === 1)
      else await launched.catch(async error => {
        const actual = JSON.parse(await fs.readFile(reportFile, 'utf8').catch(() => 'null'))
        throw new Error('Installer actor failed: ' + JSON.stringify({dialogs:actual?.dialogs,observations:actual?.observations}) + '\n' + error.stderr)
      })
      report = JSON.parse(await fs.readFile(reportFile, 'utf8'))
      assert.equal(report.actual_installer_main, true); assert.equal(report.windows, 1, JSON.stringify(report.dialogs)); assert.equal(report.sandboxed, true)
      assert.equal(report.dialogs.at(-1).title, damaged ? '安装尚未完成' : '继续恢复服务')
      assert.equal(report.dialogs.some(value => value.title === '安装完成'), false)
      assert.equal(report.business_mm_started, false); assert.equal(report.actual_product_gui, false)
      assert.equal(report.macRegistration, !damaged && process.platform === 'darwin' ? 1 : 0)
      if (damaged) assert.throws(() => installation.readDesktopSelection(f.target), { code: 'CRABOT_DESKTOP_REMOVAL_PENDING' })
      else {
        assert.match(report.dialogs.at(-1).message, /尚待启动核验/)
        assert.deepEqual(installation.readDesktopSelection(f.target).selection, selection)
        const versions = await import('../version-maintenance.mjs')
        assert.throws(() => versions.assertVersionMaintenanceAllowsStart(path.join(f.target, 'data')), { code: 'CRABOT_MAINTENANCE_PENDING' })
      }
      await assert.rejects(fs.lstat(path.join(f.target, 'data/mm.pid')), { code: 'ENOENT' })
      assert.equal(await fs.readFile(path.join(f.target, 'data/retained-user-file'), 'utf8'), 'user content')
    } finally {
      report ??= JSON.parse(await fs.readFile(reportFile, 'utf8').catch(() => 'null'))
      if (report?.profile && await fs.realpath(path.dirname(report.profile)) === await fs.realpath(tmpdir()) && /^crabot-installer-[A-Za-z0-9]+$/.test(path.basename(report.profile))) await fs.rm(report.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })

for (const version of ['1.2.3', '1.2.4']) test('retained program preparation accepts an authorized same-or-newer pair after the old Core was removed: ' + version, async t => {
  const f = await removalProofFixture(t, { schema: 'v1', functional: true })
  f.record.phase = 'completed'; await f.publish()
  const next = await fixture(t, { version, schema: 'v2', functional: true })
  await fs.rm(f.prepared.coreRoot, { recursive: true })
  const { prepareDesktopRemovalReinstall } = await import('../desktop-reinstall.mjs')
  const prepared = await prepareDesktopRemovalReinstall({ payload: next.payload, installRoot: f.target, operationId: f.record.operation_id, verifyStopped: async () => {} })
  assert.deepEqual(prepared.selection, next.selection)
  const { verifyDesktopPrograms } = await import('../desktop-payload.mjs')
  await verifyDesktopPrograms(prepared.coreRoot, prepared.guiRoot, (await verifyDesktopPayload(next.payload)).record)
  assert.deepEqual(installation.readDesktopPairReference(f.target).selection, f.selection)
  assert.throws(() => installation.readDesktopSelection(f.target), { code: 'CRABOT_DESKTOP_REMOVAL_PENDING' })
  assert.equal(await fs.readFile(path.join(f.target, 'data/retained-user-file'), 'utf8'), 'user content')
  await assert.rejects(fs.lstat(path.join(f.target, 'data/mm.pid')), { code: 'ENOENT' })
})

for (const [source, target] of [['1.2.3', '1.2.3'], ['1.2.3', '1.2.4'], ['1.9.9', '2.0.0'], ['1.2.3-rc.2', '1.2.3-rc.10'], ['1.2.3-rc.10', '1.2.3'], ['1.2.3-1', '1.2.3-alpha'], ['1.2.3-rc', '1.2.3-rc.1'], ['1.2.3-rc.01.a', '1.2.3-rc.1.b']]) test('retained repair accepts same/newer version ordering: ' + source + ' -> ' + target, async () => {
  const { assertReinstallVersion } = await import('../desktop-reinstall.mjs')
  assert.doesNotThrow(() => assertReinstallVersion(source, target))
})
for (const [source, target] of [['1.2.4', '1.2.3'], ['10.0.0', '2.0.0'], ['1.2.3', '1.2.3-rc.10'], ['1.2.3-rc.10', '1.2.3-rc.2'], ['1.2.3-alpha', '1.2.3-1'], ['1.2.3-rc.1', '1.2.3-rc'], ['1.2.3-rc.01.b', '1.2.3-rc.1.a'], ['invalid', '1.2.3'], ['1.2.3', 'latest']]) test('retained repair rejects older/invalid versions: ' + source + ' -> ' + target, async () => {
  const { assertReinstallVersion } = await import('../desktop-reinstall.mjs')
  assert.throws(() => assertReinstallVersion(source, target))
})
for (const mode of ['missing', 'known-old', 'known-new', 'custom', 'lost-publication', 'late-custom']) test('newer retained program preparation replaces only a recognized application launcher: ' + mode, async t => {
  const f = await removalProofFixture(t, { executableNode: false })
  f.record.phase = 'completed'; await f.publish()
  // Different, byte-only launcher variant. This test never executes that file.
  const next = await fixture(t, { version: '1.2.4', executableNode: false, launcherSuffix: '\nnew fixture launcher bytes\n' })
  const command = path.join(f.target, 'bin', launcher), target = await fs.readFile(path.join(next.core, 'bin', launcher))
  if (mode === 'missing') await fs.unlink(command)
  if (mode === 'known-new') await fs.writeFile(command, target)
  if (mode === 'custom') await fs.writeFile(command, 'user command')
  const before = await fs.lstat(command, { bigint: true }).catch(() => null)
  const rename = fs.rename, copy = fs.copyFile
  let injected = false
  const renamed = t.mock.method(fs, 'rename', async (from, to) => {
    await rename(from, to)
    if (!injected && mode === 'lost-publication' && to === command) { injected = true; throw new Error('launcher publication reply lost') }
  })
  const copied = t.mock.method(fs, 'copyFile', async (from, to, ...args) => {
    await copy(from, to, ...args)
    if (!injected && mode === 'late-custom' && to.startsWith(command + '.tmp-')) { injected = true; await fs.writeFile(command, 'late user command') }
  })
  const { prepareDesktopRemovalReinstall } = await import('../desktop-reinstall.mjs')
  const options = { payload: next.payload, installRoot: f.target, operationId: f.record.operation_id, verifyStopped: async () => {} }
  if (['custom', 'lost-publication', 'late-custom'].includes(mode)) {
    await assert.rejects(prepareDesktopRemovalReinstall(options))
    if (mode !== 'custom') assert.equal(injected, true)
    if (mode !== 'lost-publication') assert.equal(await fs.readFile(command, 'utf8'), mode === 'custom' ? 'user command' : 'late user command')
    else { renamed.mock.restore(); copied.mock.restore(); await prepareDesktopRemovalReinstall(options) }
  } else await prepareDesktopRemovalReinstall(options)
  if (!['custom', 'late-custom'].includes(mode)) assert.deepEqual(await fs.readFile(command), target)
  if (mode === 'known-new') assert.equal((await fs.lstat(command, { bigint: true })).ino, before.ino)
  assert.equal((await fs.readdir(path.dirname(command))).some(name => name.startsWith(launcher + '.tmp-')), false)
  assert.deepEqual(installation.readDesktopPairReference(f.target).selection, f.selection)
  assert.throws(() => installation.readDesktopSelection(f.target), { code: 'CRABOT_DESKTOP_REMOVAL_PENDING' })
  assert.equal(await fs.readFile(path.join(f.target, 'data/retained-user-file'), 'utf8'), 'user content')
})

for (const version of ['1.2.3', '1.2.4']) test('new retained target handoff preserves historical source facts without reconstructing the removed Core: ' + version, async t => {
  const f = await removalProofFixture(t, { schema: 'v1', functional: true })
  f.record.phase = 'completed'; await f.publish()
  const proof = await fs.readFile(f.file), data = path.join(f.target, 'data'), directory = path.join(data, 'fixture')
  await fs.mkdir(directory); await fs.writeFile(path.join(directory, 'SCHEMA_VERSION'), 'v1'); await fs.writeFile(path.join(directory, 'content'), 'before')
  const next = await fixture(t, { version, schema: 'v2', functional: true })
  await fs.rm(f.prepared.coreRoot, { recursive: true })
  const { prepareDesktopRemovalReinstall } = await import('../desktop-reinstall.mjs')
  const prepared = await prepareDesktopRemovalReinstall({ payload: next.payload, installRoot: f.target, operationId: f.record.operation_id, verifyStopped: async () => {} })
  const runtime = (await import('../product-runtime.cjs')).default.loadProductRuntime(prepared.coreRoot, { required: true, full: true })
  const code = `const{handoffPreparedDesktopReinstall}=await import(process.argv[1]);console.log(JSON.stringify(await handoffPreparedDesktopReinstall({payload:process.argv[2],installRoot:process.argv[3],operationId:process.argv[4],registerEntries:async()=>{}})));`
  const { stdout } = await promisify(execFile)(runtime.executables.node, ['--input-type=module', '-e', code,
    pathToFileURL(path.join(prepared.coreRoot, 'scripts/lib/desktop-reinstall-data.mjs')).href, next.payload, f.target, f.record.operation_id],
    { env: { PATH: '', ...(windows ? { SystemRoot: process.env.SystemRoot } : {}) }, timeout: 45000, maxBuffer: 65536 })
  assert.equal(JSON.parse(stdout).verification_pending, true)
  assert.deepEqual(installation.readDesktopSelection(f.target).selection, next.selection)
  const versions = await import('../version-maintenance.mjs'), record = versions.readVersionMaintenance(data)
  assert.equal(record.source_version, f.selection.version); assert.equal(record.source_inventory_sha256, f.selection.core_id)
  assert.equal(record.install_root, f.prepared.coreRoot); assert.equal(record.target_version, version)
  assert.deepEqual(record.target_core, { root: prepared.coreRoot, inventory_sha256: next.selection.core_id })
  assert.equal(record.phase, 'installing'); assert.throws(() => versions.assertVersionMaintenanceAllowsStart(data), { code: 'CRABOT_MAINTENANCE_PENDING' })
  await assert.rejects(fs.lstat(f.prepared.coreRoot), { code: 'ENOENT' })
  assert.deepEqual(await fs.readFile(f.file), proof)
  assert.equal(await fs.readFile(path.join(directory, 'content'), 'utf8'), 'before')
  await assert.rejects(fs.lstat(path.join(directory, 'executions')), { code: 'ENOENT' })
  await assert.rejects(fs.lstat(path.join(data, 'mm.pid')), { code: 'ENOENT' })
})

for (const mode of ['selector-lost', 'wrong-selector', 'foreign-maintenance', 'launcher-changed']) test('new-target handoff keeps guards and resumes only its verified selection: ' + mode, async t => {
  const f = await removalProofFixture(t, { schema: 'v1', functional: true })
  f.record.phase = 'completed'; await f.publish()
  const next = await fixture(t, { version: '1.2.4', schema: 'v2', functional: true })
  await fs.rm(f.prepared.coreRoot, { recursive: true })
  const { prepareDesktopRemovalReinstall } = await import('../desktop-reinstall.mjs'), { privateJson, readPending } = await import('../desktop-preparation-files.mjs')
  const options = { payload: next.payload, installRoot: f.target, operationId: f.record.operation_id, verifyStopped: async () => {} }
  const prepared = await prepareDesktopRemovalReinstall(options), initial = await readPending(f.target), data = path.join(f.target, 'data')
  if (mode === 'wrong-selector') await privateJson(path.join(f.target, 'current-release.json'), { ...f.selection, gui_id: randomUUID() }, true)
  if (mode === 'launcher-changed') await fs.writeFile(path.join(f.target, 'bin', launcher), 'keep user command')
  const runtime = (await import('../product-runtime.cjs')).default.loadProductRuntime(prepared.coreRoot, { required: true, full: true })
  const code = `
    import fs from 'node:fs';import path from 'node:path';import{fileURLToPath}from'node:url';
    const [module,payload,root,id,mode]=process.argv.slice(1);
    const versions=await import(new URL('./version-maintenance.mjs',module)),locks=await import(new URL('./cli-lock.mjs',module));
    if(mode==='foreign-maintenance'){
      const lock=await locks.acquireExistingCliLock(path.join(root,'data'),'foreign-maintenance');
      try{await versions.beginVersionMaintenance(path.join(root,'data'),fileURLToPath(new URL('../../',module)),'9.0.0',undefined,{dataProtection:'scoped'})}finally{locks.releaseCliLock(lock)}
    }
    const rename=fs.promises.rename;
    fs.promises.rename=async(from,to)=>{await rename(from,to);if(mode==='selector-lost'&&to===path.join(root,'current-release.json'))throw new Error('selector publication reply lost')};
    const {handoffPreparedDesktopReinstall}=await import(module);
    try{console.log(JSON.stringify(await handoffPreparedDesktopReinstall({payload,installRoot:root,operationId:id,registerEntries:async()=>{}})))}
    catch(error){console.log(JSON.stringify({rejected:true}));process.exitCode=17}
  `
  const execute = async value => promisify(execFile)(runtime.executables.node, ['--input-type=module', '-e', code,
    pathToFileURL(path.join(prepared.coreRoot, 'scripts/lib/desktop-reinstall-data.mjs')).href, next.payload, f.target, f.record.operation_id, value],
    { env: { PATH: '', ...(windows ? { SystemRoot: process.env.SystemRoot } : {}) }, timeout: 45000, maxBuffer: 65536 })
  await assert.rejects(execute(mode), error => error.code === 17)
  assert.throws(() => installation.readDesktopSelection(f.target), { code: 'CRABOT_DESKTOP_REMOVAL_PENDING' })
  const versions = await import('../version-maintenance.mjs'), record = versions.readVersionMaintenance(data)
  if (mode === 'selector-lost') {
    assert.deepEqual(installation.readDesktopPairReference(f.target).selection, next.selection)
    assert.equal(record.phase, 'installing')
    const copied = t.mock.method(fs, 'cp', async () => { throw new Error('valid programs must not be copied again') })
    await prepareDesktopRemovalReinstall(options); copied.mock.restore()
    assert.equal((await readPending(f.target)).id, initial.id)
    assert.equal(versions.readVersionMaintenance(data).id, record.id)
    await execute('continue')
    assert.deepEqual(installation.readDesktopSelection(f.target).selection, next.selection)
    assert.equal(versions.readVersionMaintenance(data).id, record.id)
  } else if (mode === 'foreign-maintenance') assert.equal(record.target_version, '9.0.0')
  else assert.equal(record, null)
  if (mode === 'launcher-changed') assert.equal(await fs.readFile(path.join(f.target, 'bin', launcher), 'utf8'), 'keep user command')
  assert.equal(await fs.readFile(path.join(data, 'retained-user-file'), 'utf8'), 'user content')
  await assert.rejects(fs.lstat(path.join(data, 'mm.pid')), { code: 'ENOENT' })
})

for (const [capture, assertion] of [['captureStoppedDesktopRemoval', 'assertStopped'], ['captureDesktopRemovalJob', 'assertJob']]) test('original removal role still rejects a different selected pair without other guards: ' + capture, async t => {
  const f = await removalProofFixture(t)
  f.record.phase = 'removing'; await f.publish()
  const { privateJson } = await import('../desktop-preparation-files.mjs'), locks = await import('../cli-lock.mjs')
  await privateJson(path.join(f.target, 'current-release.json'), { ...f.selection, gui_id: randomUUID() }, true)
  const root = await locks.acquireExistingCliLock(f.target, 'original-removal-role'), data = await locks.acquireExistingCliLock(path.join(f.target, 'data'), 'original-removal-role')
  try {
    const roles = await import('../desktop-removal-context.mjs'), context = await roles[capture]({ installRoot: f.target, operationId: f.record.operation_id })
    assert.throws(() => context[assertion](), { code: 'CRABOT_DESKTOP_REMOVAL' })
  } finally { locks.releaseCliLock(data); locks.releaseCliLock(root) }
})

for (const version of ['1.2.3', '1.2.4']) test('new retained pair previews actual migration scopes after the original Core is deleted: ' + version, async t => {
  const f = await removalProofFixture(t, { schema: 'v1', functional: true })
  const next = await fixture(t, { version, schema: 'v2', functional: true })
  const data = path.join(f.target, 'data'), directory = path.join(data, 'fixture')
  await fs.mkdir(directory); await fs.writeFile(path.join(directory, 'SCHEMA_VERSION'), 'v1'); await fs.writeFile(path.join(directory, 'content'), 'before')
  await fs.rm(f.prepared.coreRoot, { recursive: true })
  const input = { payload: next.payload, installRoot: f.target, operationId: f.record.operation_id, verifyStopped: async () => {} }
  const { inspectDesktopReinstallData, previewPreparedDesktopReinstallData } = await import('../desktop-reinstall-data.mjs')
  const versions = await inspectDesktopReinstallData(input)
  assert.equal(versions[0].codeVersion, 'v2'); assert.equal(versions[0].dataVersion, 'v1')
  const { prepareDesktopRemovalReinstall } = await import('../desktop-reinstall.mjs')
  await prepareDesktopRemovalReinstall(input)
  const preview = await previewPreparedDesktopReinstallData(input)
  assert.equal(preview.modules[0].codeVersion, 'v2'); assert.equal(preview.modules[0].dataVersion, 'v1')
  assert.ok(preview.modules[0].scope.writes.includes(path.join('fixture', 'content')))
  assert.equal(await fs.readFile(path.join(directory, 'content'), 'utf8'), 'before')
  assert.equal(await fs.readFile(path.join(directory, 'SCHEMA_VERSION'), 'utf8'), 'v1')
  await assert.rejects(fs.lstat(path.join(directory, 'executions')), { code: 'ENOENT' })
  assert.deepEqual(installation.readDesktopPairReference(f.target).selection, f.selection)
})

for (const allowed of [false, true, 'higher', 'all-programs']) test('retained product acceptance prepares its isolated removal fixture: ' + allowed, async t => {
  const previous = process.env.GITHUB_ACTIONS
  t.after(() => { if (previous === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = previous })
  process.env.GITHUB_ACTIONS = String(Boolean(allowed))
  const f = await fixture(t, { schema: 'v2', functional: true })
  const prepared = await prepareDesktopInstallation({ payload: f.payload, installRoot: f.target })
  await commitDesktopInstallation(prepared)
  const { prepareRetainedProductReinstall } = await import('../../../.github/scripts/accept-retained-product-reinstall.mjs')
  if (!allowed) {
    await assert.rejects(prepareRetainedProductReinstall({ installRoot: f.target, payload: f.payload }), /isolated CI user/)
    await assert.rejects(fs.lstat(path.join(f.target, '.desktop-removal.json')), { code: 'ENOENT' })
  } else {
    // These payload files never execute. Native reference detection and the
    // real product acceptance retain actual OS observations in their own suites.
    t.mock.method(identity, 'inspectProgramReferences', async () => ({ complete: true, incomplete: false,
      processes: [], unknown_pids: [], unknown_details: [] }))
    const incoming = allowed === 'higher' ? await fixture(t, { version: '1.2.4', schema: 'v2', functional: true }) : f
    const result = await prepareRetainedProductReinstall({ installRoot: f.target, payload: incoming.payload, removeAllPrograms: allowed === 'all-programs' })
    assert.deepEqual(result.selection, incoming.selection)
    assert.equal(result.partial_removal_fixture, allowed !== 'all-programs'); assert.equal(result.complete_program_removal, allowed === 'all-programs'); assert.equal(result.complete_uninstall_tested, false)
    if (!windows) for (const directory of [f.target, path.join(f.target, 'data')]) assert.equal((await fs.stat(directory)).mode & 0o777, 0o755)
    assert.ok(await fs.stat(path.join(result.coreRoot, 'cli.mjs')))
    assert.equal(await fs.readFile(result.sentinel, 'utf8'), 'preserved across program removal and real GUI recovery\n')
    const { readVersionMaintenance, assertVersionMaintenanceAllowsStart } = await import('../version-maintenance.mjs')
    assert.equal(readVersionMaintenance(path.join(f.target, 'data')).id, result.maintenanceId)
    assert.throws(() => assertVersionMaintenanceAllowsStart(path.join(f.target, 'data')), { code: 'CRABOT_MAINTENANCE_PENDING' })
    await assert.rejects(fs.lstat(path.join(f.target, 'data/mm.pid')), { code: 'ENOENT' })
  }
})

for (const mode of ['same', 'higher', 'completed', 'older', 'wrong-operation', 'preparing', 'changed-payload', 'cancelled', 'changed-job']) {
  test('trusted installer prepares an incoming maintenance GUI without the removed original: ' + mode, { skip: process.platform === 'linux' }, async t => {
    const { prepareInstallerDesktopRemovalGui } = await import('../desktop-removal-host.mjs')
    assert.equal(typeof prepareInstallerDesktopRemovalGui, 'function')
    const f = await removalProofFixture(t), incoming = await fixture(t, { version: mode === 'higher' ? '1.2.4' : mode === 'older' ? '1.2.2' : '1.2.3', executableNode: false })
    f.record.phase = mode === 'completed' ? 'completed' : mode === 'preparing' ? 'preparing' : 'removing'; await f.publish()
    await fs.rm(f.prepared.coreRoot, { recursive: true }); await fs.rm(f.prepared.guiRoot, { recursive: true })
    const record = await fs.readFile(path.join(f.target, '.desktop-removal.json')), proof = await fs.readFile(f.file)
    if (mode === 'changed-payload') await fs.appendFile(path.join(incoming.core, 'cli.mjs'), 'changed')
    const input = { payload: incoming.payload, installRoot: f.target, operationId: mode === 'wrong-operation' ? randomUUID() : f.record.operation_id,
      signal: mode === 'cancelled' ? AbortSignal.abort() : new AbortController().signal,
      progress: phase => { if (mode === 'changed-job' && phase === 'copying') writeFileSync(path.join(f.target, '.desktop-removal.json'), JSON.stringify({ ...f.record, phase: 'completed' }) + '\n') } }
    if (['same', 'higher', 'completed'].includes(mode)) {
      const prepared = await prepareInstallerDesktopRemovalGui(input)
      t.after(() => fs.rm(prepared.directory, { recursive: true, force: true })) // This preparation never starts a child.
      assert.deepEqual(prepared.proof, f.proof); assert.deepEqual(prepared.record, f.record)
      assert.deepEqual(prepared.hostPayload, (await verifyDesktopPayload(incoming.payload)).record)
      assert.notEqual(prepared.hostPayload.selection.gui_id, prepared.proof.source_selection.gui_id)
      await (await import('../desktop-payload.mjs')).verifyDesktopGui(prepared.guiRoot, prepared.hostPayload)
      assert.deepEqual(await fs.readdir(prepared.directory), ['gui'])
    } else await assert.rejects(prepareInstallerDesktopRemovalGui(input))
    if (mode !== 'changed-job') assert.deepEqual(await fs.readFile(path.join(f.target, '.desktop-removal.json')), record)
    assert.deepEqual(await fs.readFile(f.file), proof)
    assert.deepEqual(installation.readDesktopPairReference(f.target).selection, f.selection)
    await assert.rejects(fs.lstat(f.prepared.coreRoot), { code: 'ENOENT' }); await assert.rejects(fs.lstat(f.prepared.guiRoot), { code: 'ENOENT' })
    await assert.rejects(fs.lstat(path.join(f.target, 'data/desktop-maintenance.json')), { code: 'ENOENT' })
    assert.equal(await fs.readFile(path.join(f.target, 'data/retained-user-file'), 'utf8'), 'user content')
  })
}

for (const mode of ['none', 'removing', 'stopping', 'completed', 'installing', 'data-maintenance', 'new-pair']) {
  test('installer offers continuation only before retained repair has prepared another program set: ' + mode, async t => {
    const f = await removalProofFixture(t)
    f.record.phase = ['stopping', 'completed'].includes(mode) ? mode : 'removing'
    if (mode === 'none') await fs.unlink(path.join(f.target, '.desktop-removal.json'))
    else await f.publish()
    if (mode === 'installing') await fs.writeFile(path.join(f.target, '.desktop-installing.json'), '{}', { mode: 0o600 })
    if (mode === 'data-maintenance') await fs.writeFile(path.join(f.target, 'data/desktop-maintenance.json'), '{}', { mode: 0o600 })
    if (mode === 'new-pair') await fs.writeFile(path.join(f.target, 'current-release.json'), JSON.stringify({ ...f.selection, gui_id: randomUUID() }) + '\n')
    const file = path.join(f.target, '.desktop-removal.json'), before = mode === 'none' ? null : await fs.readFile(file)
    const { inspectRetainedDesktopRemoval } = await import('../../../crabot-desktop/dist/retained-reinstall.js')
    const actual = await inspectRetainedDesktopRemoval(f.target)
    if (mode === 'none') { assert.equal(actual, null); await assert.rejects(fs.lstat(file), { code: 'ENOENT' }) }
    else {
      assert.deepEqual(actual.record, f.record); assert.equal(actual.canContinue, mode === 'removing')
      assert.deepEqual(await fs.readFile(file), before)
    }
    assert.equal(await fs.readFile(path.join(f.target, 'data/retained-user-file'), 'utf8'), 'user content')
  })
}


async function legacyProgramFixture(t, options = {}) {
  const f = await fixture(t, { ...options, schema: 'v2', executableNode: false })
  const { materializeLegacyRelease } = await import('./fixtures/legacy-release.mjs')
  const { discoverLegacyUserInstall } = await import('../legacy-desktop.mjs')
  const data = path.join(f.target, 'data')
  await fs.mkdir(data, { recursive: true, mode: 0o700 }); await materializeLegacyRelease(f.target, options.legacyVersion)
  await fs.mkdir(path.join(data, 'fixture')); await fs.writeFile(path.join(data, 'fixture/SCHEMA_VERSION'), 'v1')
  await fs.writeFile(path.join(data, 'fixture/content'), 'old project data')
  // Online preparation neither trusts nor uses a PID hint to stop business.
  await fs.writeFile(path.join(data, 'mm.pid'), String(process.pid))
  const legacy = await discoverLegacyUserInstall({ root: f.target, dataDir: data })
  return { ...f, data, legacy }
}

test('legacy online program preparation preserves old entries and data while staging the exact final pair', async t => {
  const f = await legacyProgramFixture(t), phases = []
  if (!windows) await fs.chmod(f.data, 0o755)
  const { prepareLegacyDesktopPrograms, verifyLegacyDesktopPrograms } = await import('../legacy-desktop-programs.mjs')
  const entry = await fs.readFile(path.join(f.target, 'cli.mjs')), data = await fs.readdir(f.data)
  const readdir = fs.readdir
  let scans = 0
  const scan = t.mock.method(fs, 'readdir', (directory, ...args) => {
    if (args[0]?.withFileTypes && String(directory).startsWith(f.target + path.sep)
      && ['core', f.selection.core_id].includes(path.basename(String(directory)))) scans++
    return readdir(directory, ...args)
  })
  let prepared
  try { prepared = await prepareLegacyDesktopPrograms({ payload: f.payload, installation: f.legacy, progress: phase => phases.push(phase) }) }
  finally { scan.mock.restore() }
  assert.equal(scans, 1, 'A new target pair needs one complete post-copy scan, not a second scan after read-only preview')
  assert.deepEqual(phases, ['verifying', 'copying', 'previewing', 'prepared'])
  assert.deepEqual(prepared.installation, f.legacy)
  assert.equal(prepared.coreRoot, path.join(f.target, 'releases', f.selection.core_id))
  assert.equal(prepared.guiRoot, path.join(f.target, 'app/releases', f.selection.gui_id))
  assert.equal(prepared.preview.modules.length, 1)
  await verifyLegacyDesktopPrograms(prepared)
  assert.deepEqual(await fs.readFile(path.join(f.target, 'cli.mjs')), entry)
  assert.deepEqual(await fs.readdir(f.data), data)
  assert.equal(await fs.readFile(path.join(f.data, 'fixture/content'), 'utf8'), 'old project data')
  for (const file of ['desktop-installation.json', 'current-release.json', '.desktop-installing.json', '.desktop-takeover']) await assert.rejects(fs.lstat(path.join(f.target, file)), { code: 'ENOENT' })
  const cp = t.mock.method(fs, 'cp', () => assert.fail('retry must reuse verified immutable programs'))
  const again = await prepareLegacyDesktopPrograms({ payload: f.payload, installation: f.legacy })
  cp.mock.restore(); assert.deepEqual(again, prepared)
  if (!windows) assert.equal((await fs.stat(f.data)).mode & 0o777, 0o755)
})

for (const changed of ['copy', 'after-prepare']) test('legacy preparation and handoff reject corrupt programs before fencing old entries: ' + changed, async t => {
  const f = await legacyProgramFixture(t)
  const { prepareLegacyDesktopPrograms } = await import('../legacy-desktop-programs.mjs')
  const original = await fs.readFile(path.join(f.target, 'cli.mjs'))
  if (changed === 'copy') {
    const cp = fs.cp
    t.mock.method(fs, 'cp', async (from, to, ...args) => {
      await cp(from, to, ...args)
      if (from === path.join(f.payload, 'core')) await fs.appendFile(path.join(to, 'cli.mjs'), 'corrupt')
    })
    await assert.rejects(prepareLegacyDesktopPrograms({ payload: f.payload, installation: f.legacy }), { code: 'CRABOT_CORE_INTEGRITY' })
  } else {
    const prepared = await prepareLegacyDesktopPrograms({ payload: f.payload, installation: f.legacy })
    await fs.appendFile(path.join(prepared.coreRoot, 'cli.mjs'), 'corrupt')
    const { runPreparedLegacyDesktopTakeover } = await import('../legacy-desktop-handoff.mjs')
    await assert.rejects(runPreparedLegacyDesktopTakeover({ prepared,
      registerEntries: () => assert.fail('Corrupt programs must not reach registration') }), { code: 'CRABOT_CORE_INTEGRITY' })
  }
  assert.deepEqual(await fs.readFile(path.join(f.target, 'cli.mjs')), original)
  assert.equal(await fs.readFile(path.join(f.data, 'fixture/content'), 'utf8'), 'old project data')
  await assert.rejects(fs.lstat(path.join(f.target, '.desktop-takeover')), { code: 'ENOENT' })
})

test('legacy handoff retains the target failure code before data migration', async t => {
  const f = await legacyProgramFixture(t, { functional: true })
  const { prepareLegacyDesktopPrograms } = await import('../legacy-desktop-programs.mjs')
  const { runPreparedLegacyDesktopTakeover } = await import('../legacy-desktop-handoff.mjs')
  const prepared = await prepareLegacyDesktopPrograms({ payload: f.payload, installation: f.legacy })
  const original = await fs.readFile(path.join(f.target, 'cli.mjs'))
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(runPreparedLegacyDesktopTakeover({ prepared,
    registerEntries: () => assert.fail('Unverified old runtime must not reach registration') }), error => {
    assert.equal(error.code, 'CRABOT_MAINTENANCE_PENDING')
    assert.equal(error.cause?.code, 'CRABOT_LEGACY_RUNTIME_UNVERIFIED')
    return true
  })
  assert.equal(await fs.readFile(path.join(f.data, 'fixture/content'), 'utf8'), 'old project data')
  await assert.rejects(fs.lstat(path.join(f.data, 'desktop-maintenance.json')), { code: 'ENOENT' })
  assert.deepEqual(await fs.readFile(path.join(f.target, 'cli.mjs')), original)
})

for (const changed of ['source', 'external-data', 'missing-data', 'unknown-program', 'cancelled', 'redirected-app']) test('legacy online staging rejects changed or unsupported inputs without touching data: ' + changed, { skip: process.platform === 'win32' && changed === 'redirected-app' }, async t => {
  const f = await legacyProgramFixture(t), abort = new AbortController()
  const { prepareLegacyDesktopPrograms } = await import('../legacy-desktop-programs.mjs')
  let legacy = f.legacy
  if (changed === 'source') legacy = { ...legacy, fingerprint: 'a'.repeat(64) }
  if (changed === 'external-data') legacy = { ...legacy, dataRoot: f.parent }
  if (changed === 'missing-data') await fs.rename(f.data, f.data + '-retained')
  if (changed === 'unknown-program') {
    await fs.mkdir(path.join(f.target, 'releases', f.selection.core_id), { recursive: true })
    await fs.writeFile(path.join(f.target, 'releases', f.selection.core_id, 'keep'), 'unknown program')
  }
  if (changed === 'cancelled') abort.abort()
  if (changed === 'redirected-app') await fs.symlink(f.parent, path.join(f.target, 'app'), 'dir')
  const original = await fs.readFile(path.join(f.target, 'cli.mjs'))
  await assert.rejects(prepareLegacyDesktopPrograms({ payload: f.payload, installation: legacy, signal: abort.signal }))
  const data = changed === 'missing-data' ? f.data + '-retained' : f.data
  assert.equal(await fs.readFile(path.join(data, 'fixture/content'), 'utf8'), 'old project data')
  assert.deepEqual(await fs.readFile(path.join(f.target, 'cli.mjs')), original)
  for (const file of ['desktop-installation.json', 'current-release.json', '.desktop-takeover']) await assert.rejects(fs.lstat(path.join(f.target, file)), { code: 'ENOENT' })
  if (changed === 'missing-data') await assert.rejects(fs.lstat(f.data), { code: 'ENOENT' })
  if (changed === 'unknown-program') assert.equal(await fs.readFile(path.join(f.target, 'releases', f.selection.core_id, 'keep'), 'utf8'), 'unknown program')
})


for (const changed of ['insufficient-space', 'corrupt-proof', 'prepared-cancellation']) test('legacy online preparation retains a usable old install after ' + changed, async t => {
  const f = await legacyProgramFixture(t), abort = new AbortController()
  const { prepareLegacyDesktopPrograms, verifyLegacyDesktopPrograms } = await import('../legacy-desktop-programs.mjs')
  if (changed === 'insufficient-space') t.mock.method(fs, 'statfs', async () => ({ bavail: 0n, bsize: 4096n }))
  const options = { payload: f.payload, installation: f.legacy, signal: abort.signal,
    progress: phase => { if (phase === 'prepared' && changed === 'prepared-cancellation') abort.abort() } }
  if (changed === 'corrupt-proof') {
    const prepared = await prepareLegacyDesktopPrograms(options)
    await fs.appendFile(prepared.proof.file, 'changed')
    await assert.rejects(verifyLegacyDesktopPrograms(prepared))
    await assert.rejects(prepareLegacyDesktopPrograms(options))
  } else await assert.rejects(prepareLegacyDesktopPrograms(options))
  const { discoverLegacyUserInstall } = await import('../legacy-desktop.mjs')
  assert.deepEqual(await discoverLegacyUserInstall({ root: f.target, dataDir: f.data }), f.legacy)
  assert.equal(await fs.readFile(path.join(f.data, 'fixture/content'), 'utf8'), 'old project data')
  await assert.rejects(fs.lstat(path.join(f.data, 'desktop-maintenance.json')), { code: 'ENOENT' })
  if (changed === 'insufficient-space') await assert.rejects(fs.lstat(path.join(f.target, 'releases', f.selection.core_id)), { code: 'ENOENT' })
})


for (const conversionFailure of [false, true, 'stale-modules']) test('actual target Node takes over stopped legacy data once and retains dedicated health protection; failure=' + conversionFailure, async t => {
  const f = await legacyProgramFixture(t, { functional: true, conversionFailure: conversionFailure === true, legacyVersion: conversionFailure === 'stale-modules' ? 'v2026.10.14.1' : undefined })
  await fs.unlink(path.join(f.data, 'mm.pid'))
  const { prepareLegacyDesktopPrograms } = await import('../legacy-desktop-programs.mjs')
  const prepared = await prepareLegacyDesktopPrograms({ payload: f.payload, installation: f.legacy })
  const node = path.join(prepared.coreRoot, windows ? '.product-runtime/node/node.exe' : '.product-runtime/node/bin/node')
  const module = path.join(prepared.coreRoot, 'scripts/lib/legacy-desktop-takeover.mjs')
  const stale = conversionFailure === 'stale-modules' ? await stoppedLegacyModules(f.data) : undefined
  if (stale) { const { fenceLegacyEntries } = await import('../legacy-entry-fence.mjs'); await fenceLegacyEntries(f.legacy) }
  // Interpreter inspection is substituted; the sealed target Node, locks,
  // old entry bytes and actual scoped migration/rollback run here. No MM starts.
  const script = `import{pathToFileURL}from'node:url';const [module,prepared]=process.argv.slice(1);const {convertLegacyDesktopData}=await import(pathToFileURL(module).href);const value=await convertLegacyDesktopData({prepared:JSON.parse(prepared),inspectEnvironment:async()=>({status:'absent'})});console.log(JSON.stringify(value))`
  const run = () => promisify(execFile)(node, ['--input-type=module', '--eval', script, module, JSON.stringify(prepared)], { timeout: 30_000, maxBuffer: 65536 })
  if (conversionFailure === true) {
    await assert.rejects(run())
    assert.equal(await fs.readFile(path.join(f.data, 'fixture/content'), 'utf8'), 'old project data')
    await assert.rejects(fs.lstat(path.join(f.data, 'fixture/executions')), { code: 'ENOENT' })
    await assert.rejects(run())
  } else {
    const result = JSON.parse((await run()).stdout.trim())
    if (stale) assert.deepEqual(await fs.readdir(stale.records), [])
    assert.equal(result.verification_pending, true); assert.equal(result.health_verified, false)
    assert.equal(await fs.readFile(path.join(f.data, 'fixture/content'), 'utf8'), 'converted by bundled Node')
    assert.equal(await fs.readFile(path.join(f.data, 'fixture/executions'), 'utf8'), 'once\n')
    assert.deepEqual(JSON.parse((await run()).stdout.trim()), result)
    assert.equal(await fs.readFile(path.join(f.data, 'fixture/executions'), 'utf8'), 'once\n')
    await fs.writeFile(path.join(f.data, 'mm.pid'), String(process.pid))
    await assert.rejects(run())
    await fs.unlink(path.join(f.data, 'mm.pid'))
  }
  const { readVersionMaintenance, assertVersionMaintenanceAllowsStart } = await import('../version-maintenance.mjs')
  const maintenance = readVersionMaintenance(f.data)
  assert.equal(maintenance.schema_version, 4); assert.equal(maintenance.phase, 'verifying'); assert.equal(maintenance.backup, null)
  assert.throws(() => assertVersionMaintenanceAllowsStart(f.data), { code: 'CRABOT_MAINTENANCE_PENDING' })
  const { inspectLegacyEntryFence } = await import('../legacy-entry-fence.mjs')
  assert.equal((await inspectLegacyEntryFence(f.target)).phase, 'data_changing')
  await assert.rejects(fs.lstat(f.data + '.desktop-backups'), { code: 'ENOENT' })
  assert.equal((await fs.readdir(path.join(f.data, '.upgrade-migrations'))).length, 1)
  for (const file of ['desktop-installation.json', 'current-release.json', 'desktop-managed.json']) await assert.rejects(fs.lstat(path.join(file === 'desktop-managed.json' ? f.data : f.target, file)), { code: 'ENOENT' })
})


test('target takeover never converts an existing legacy maintenance record into scoped admission', async t => {
  const f = await legacyProgramFixture(t, { functional: true }); await fs.unlink(path.join(f.data, 'mm.pid'))
  const { prepareLegacyDesktopPrograms } = await import('../legacy-desktop-programs.mjs')
  const { fenceLegacyEntries } = await import('../legacy-entry-fence.mjs')
  const { beginLegacyUserVersionMaintenance, readVersionMaintenance } = await import('../version-maintenance.mjs')
  const { acquireCliLock, releaseCliLock } = await import('../cli-lock.mjs')
  const prepared = await prepareLegacyDesktopPrograms({ payload: f.payload, installation: f.legacy }), entry = await fenceLegacyEntries(f.legacy)
  const lock = await acquireCliLock(f.data, 'legacy-original-record-test')
  let original
  try { original = await beginLegacyUserVersionMaintenance({ dataDir: f.data, installation: f.legacy, entryFenceId: entry.id, targetRoot: prepared.coreRoot }) }
  finally { releaseCliLock(lock) }
  const node = path.join(prepared.coreRoot, windows ? '.product-runtime/node/node.exe' : '.product-runtime/node/bin/node')
  const script = `import{pathToFileURL}from'node:url';const [module,prepared]=process.argv.slice(1);const {convertLegacyDesktopData}=await import(pathToFileURL(module).href);await convertLegacyDesktopData({prepared:JSON.parse(prepared),inspectEnvironment:async()=>({status:'absent'})})`
  await assert.rejects(promisify(execFile)(node, ['--input-type=module', '--eval', script, path.join(prepared.coreRoot, 'scripts/lib/legacy-desktop-takeover.mjs'), JSON.stringify(prepared)], { timeout: 30_000, maxBuffer: 65536 }))
  assert.deepEqual(readVersionMaintenance(f.data), original)
  assert.equal(await fs.readFile(path.join(f.data, 'fixture/content'), 'utf8'), 'old project data')
  await assert.rejects(fs.lstat(path.join(f.data, '.upgrade-migrations')), { code: 'ENOENT' })
})

test('target takeover resumes an unstarted conversion after a lost pre-conversion result without replay', async t => {
  const f = await legacyProgramFixture(t, { functional: true }); await fs.unlink(path.join(f.data, 'mm.pid'))
  const { prepareLegacyDesktopPrograms } = await import('../legacy-desktop-programs.mjs')
  const { readVersionMaintenance } = await import('../version-maintenance.mjs')
  const prepared = await prepareLegacyDesktopPrograms({ payload: f.payload, installation: f.legacy })
  const node = path.join(prepared.coreRoot, windows ? '.product-runtime/node/node.exe' : '.product-runtime/node/bin/node')
  const script = `import{pathToFileURL}from'node:url';const [module,prepared,interrupt]=process.argv.slice(1);const {convertLegacyDesktopData}=await import(pathToFileURL(module).href);await convertLegacyDesktopData({prepared:JSON.parse(prepared),inspectEnvironment:async()=>({status:'absent'}),progress:phase=>{if(interrupt==='yes'&&phase==='converting')throw new Error('controlled before conversion')}})`
  const run = interrupt => promisify(execFile)(node, ['--input-type=module', '--eval', script, path.join(prepared.coreRoot, 'scripts/lib/legacy-desktop-takeover.mjs'), JSON.stringify(prepared), interrupt], { timeout: 30_000, maxBuffer: 65536 })
  await assert.rejects(run('yes'))
  assert.equal(readVersionMaintenance(f.data).phase, 'installing')
  assert.equal(await fs.readFile(path.join(f.data, 'fixture/content'), 'utf8'), 'old project data')
  await assert.rejects(fs.lstat(path.join(f.data, '.upgrade-migrations')), { code: 'ENOENT' })
  await run('no'); await run('no')
  assert.equal(readVersionMaintenance(f.data).phase, 'verifying')
  assert.equal(await fs.readFile(path.join(f.data, 'fixture/executions'), 'utf8'), 'once\n')
})


for (const interrupted of [false, true]) test('legacy target commits its original data binding and exact pair while retaining health protection; registration interruption=' + interrupted, async t => {
  const f = await legacyProgramFixture(t, { functional: true }); await fs.unlink(path.join(f.data, 'mm.pid'))
  const { prepareLegacyDesktopPrograms } = await import('../legacy-desktop-programs.mjs')
  const prepared = await prepareLegacyDesktopPrograms({ payload: f.payload, installation: f.legacy })
  const node = path.join(prepared.coreRoot, windows ? '.product-runtime/node/node.exe' : '.product-runtime/node/bin/node')
  const script = `import{pathToFileURL}from'node:url';const [module,prepared,interrupt]=process.argv.slice(1);const role=await import(pathToFileURL(module).href);const input=JSON.parse(prepared);const converted=await role.convertLegacyDesktopData({prepared:input,inspectEnvironment:async()=>({status:'absent'})});const result=await role.commitLegacyDesktopInstallation({prepared:input,maintenanceId:converted.maintenance_id,registerEntries:async value=>{if(value.coreRoot!==input.coreRoot)throw new Error('wrong registration');if(interrupt==='yes')throw new Error('controlled registration interruption')}});console.log(JSON.stringify(result))`
  const run = interrupt => promisify(execFile)(node, ['--input-type=module', '--eval', script, path.join(prepared.coreRoot, 'scripts/lib/legacy-desktop-takeover.mjs'), JSON.stringify(prepared), interrupt], { timeout: 30_000, maxBuffer: 65536 })
  if (interrupted) {
    await assert.rejects(run('yes'))
    await assert.rejects(fs.lstat(path.join(f.target, 'current-release.json')), { code: 'ENOENT' })
  }
  const result = JSON.parse((await run('no')).stdout.trim())
  const selected = installation.readDesktopSelection(f.target)
  assert.equal(result.dataDir, f.data); assert.equal(result.executable, selected.executable)
  assert.equal(result.verification_pending, true); assert.equal(result.health_verified, false)
  assert.deepEqual(selected.selection, f.selection)
  const { readVersionMaintenance, assertVersionMaintenanceAllowsStart } = await import('../version-maintenance.mjs')
  const maintenance = readVersionMaintenance(f.data)
  assert.equal(maintenance.schema_version, 4); assert.equal(maintenance.phase, 'verifying')
  assert.throws(() => assertVersionMaintenanceAllowsStart(f.data), { code: 'CRABOT_MAINTENANCE_PENDING' })
  assert.equal(await fs.readFile(path.join(f.data, 'fixture/content'), 'utf8'), 'converted by bundled Node')
  assert.equal(await fs.readFile(path.join(f.data, 'fixture/executions'), 'utf8'), 'once\n')
  assert.deepEqual(JSON.parse((await run('no')).stdout.trim()), result)
  assert.equal(installation.readDesktopInstallation(f.target).record.installation_id, selected.record.installation_id)
  const management = await import('../desktop-management.cjs')
  assert.deepEqual(management.default.readDesktopManagement(f.data), { schema_version: 1, install_kind: 'desktop', admin_listen_host: '127.0.0.1' })
  if (!interrupted) {
    const oldCommand = path.join(f.target, 'cli.mjs')
    await assert.rejects(promisify(execFile)(process.execPath, [oldCommand, '--version']), error => { assert.match(error.stderr, /CRABOT_LEGACY_ENTRY_FENCE/); return true })
    // Routing-only continuation: this disposable fixture simulates admitted
    // health by clearing its guard. No GUI or business MM health is claimed.
    await fs.unlink(path.join(f.data, 'desktop-maintenance.json'))
    const forwarded = await promisify(execFile)(process.execPath, [oldCommand, '--version'], { timeout: 15_000 })
    assert.equal(JSON.parse(forwarded.stdout.trim()).version, f.selection.version)
    await fs.unlink(path.join(f.target, 'bin', launcher))
    await assert.rejects(promisify(execFile)(process.execPath, [oldCommand, '--version']), error => { assert.match(error.stderr, /CRABOT_LEGACY_ENTRY_FENCE/); return true })
  }
})

for (const healthy of [false, true]) test('dedicated ordinary-GUI legacy recovery keeps protection until its health callback succeeds; health substitute=' + healthy, async t => {
  const f = await legacyProgramFixture(t, { functional: true }); await fs.unlink(path.join(f.data, 'mm.pid'))
  const { prepareLegacyDesktopPrograms } = await import('../legacy-desktop-programs.mjs')
  const prepared = await prepareLegacyDesktopPrograms({ payload: f.payload, installation: f.legacy })
  const node = path.join(prepared.coreRoot, windows ? '.product-runtime/node/node.exe' : '.product-runtime/node/bin/node')
  const script = `import{pathToFileURL}from'node:url';import path from'node:path';const [module,prepared,healthy]=process.argv.slice(1);const role=await import(pathToFileURL(module).href),input=JSON.parse(prepared);const converted=await role.convertLegacyDesktopData({prepared:input,inspectEnvironment:async()=>({status:'absent'})});await role.commitLegacyDesktopInstallation({prepared:input,maintenanceId:converted.maintenance_id,registerEntries:async()=>{}});const versions=await import(pathToFileURL(path.join(input.coreRoot,'scripts/lib/version-maintenance.mjs')).href);const result=await versions.recoverLegacyUserVersionMaintenance({dataDir:input.installation.dataRoot,root:input.coreRoot,appVersion:input.selection.version,verifyTakeover:async()=>{},verifyCompatible:async()=>{},run:async()=>healthy==='yes'});console.log(JSON.stringify({recovered:result}));`
  const run = () => promisify(execFile)(node, ['--input-type=module', '--eval', script, path.join(prepared.coreRoot, 'scripts/lib/legacy-desktop-takeover.mjs'), JSON.stringify(prepared), healthy ? 'yes' : 'no'], { timeout: 30_000, maxBuffer: 65536 })
  // The trusted health callback is substituted. This checks actual proof/data
  // admission and fence persistence, not ordinary GUI or live MM health.
  if (healthy) assert.equal(JSON.parse((await run()).stdout.trim()).recovered, true)
  else await assert.rejects(run())
  const { readVersionMaintenance } = await import('../version-maintenance.mjs')
  if (healthy) assert.equal(readVersionMaintenance(f.data), null)
  else assert.equal(readVersionMaintenance(f.data).phase, 'verifying')
  assert.equal(await fs.readFile(path.join(f.data, 'fixture/executions'), 'utf8'), 'once\n')
})

for (const changed of ['source', 'gui-before-health', 'gui-after-health', 'old-record', 'unknown-transaction']) test('dedicated legacy health cannot clear changed takeover evidence: ' + changed, async t => {
  const f = await legacyProgramFixture(t, { functional: true }); await fs.unlink(path.join(f.data, 'mm.pid'))
  const { prepareLegacyDesktopPrograms } = await import('../legacy-desktop-programs.mjs')
  const prepared = await prepareLegacyDesktopPrograms({ payload: f.payload, installation: f.legacy })
  const node = path.join(prepared.coreRoot, windows ? '.product-runtime/node/node.exe' : '.product-runtime/node/bin/node')
  const script = `import{pathToFileURL}from'node:url';import path from'node:path';import fs from'node:fs/promises';const [module,prepared,changed]=process.argv.slice(1),input=JSON.parse(prepared),role=await import(pathToFileURL(module).href);const converted=await role.convertLegacyDesktopData({prepared:input,inspectEnvironment:async()=>({status:'absent'})});const committed=await role.commitLegacyDesktopInstallation({prepared:input,maintenanceId:converted.maintenance_id,registerEntries:async()=>{}});const data=input.installation.dataRoot,journal=path.join(data,'desktop-maintenance.json');if(changed==='source')await fs.appendFile(path.join(input.installation.installRoot,'VERSION'),'changed');if(changed==='gui-before-health')await fs.appendFile(committed.executable,'changed');if(changed==='old-record'){const record=JSON.parse(await fs.readFile(journal,'utf8'));record.schema_version=2;delete record.data_protection;await fs.writeFile(journal,JSON.stringify(record));}if(changed==='unknown-transaction'){const directory=path.join(data,'.upgrade-migrations'),[id]=await fs.readdir(directory),state=path.join(directory,id,'state.json'),value=JSON.parse(await fs.readFile(state,'utf8'));value.phase='running';await fs.writeFile(state,JSON.stringify(value));}const versions=await import(pathToFileURL(path.join(input.coreRoot,'scripts/lib/version-maintenance.mjs')).href);let called=false;try{await versions.recoverLegacyUserVersionMaintenance({dataDir:data,root:input.coreRoot,appVersion:input.selection.version,verifyTakeover:async()=>{},verifyCompatible:async()=>{},run:async()=>{called=true;if(changed==='gui-after-health')await fs.appendFile(committed.executable,'changed');return true}});console.log(JSON.stringify({unexpected_success:true,called}));}catch(error){console.log(JSON.stringify({blocked:true,called}));}`
  const result = await promisify(execFile)(node, ['--input-type=module', '--eval', script, path.join(prepared.coreRoot, 'scripts/lib/legacy-desktop-takeover.mjs'), JSON.stringify(prepared), changed], { timeout: 30_000, maxBuffer: 65536 })
  assert.deepEqual(JSON.parse(result.stdout.trim()), { blocked: true, called: changed === 'gui-after-health' })
  const { readVersionMaintenance } = await import('../version-maintenance.mjs')
  assert.equal(readVersionMaintenance(f.data).phase, 'verifying')
  assert.equal(await fs.readFile(path.join(f.data, 'fixture/executions'), 'utf8'), 'once\n')
})


const cachedPythonAvailable = (() => { try { const value = JSON.parse(readFileSync(new URL('../../../product-runtime.json', import.meta.url), 'utf8')); return Boolean(value.executables?.python && value.python_home) } catch { return false } })()
for (const registrationFails of [false, true]) test('legacy installer Node handoff uses actual bundled Python and waits for registration/exit; registration failure=' + registrationFails, { skip: !cachedPythonAvailable }, async t => {
  const f = await legacyProgramFixture(t, { functional: true, realPython: true }); await fs.unlink(path.join(f.data, 'mm.pid'))
  const { prepareLegacyDesktopPrograms } = await import('../legacy-desktop-programs.mjs')
  const { runPreparedLegacyDesktopTakeover } = await import('../legacy-desktop-handoff.mjs')
  const prepared = await prepareLegacyDesktopPrograms({ payload: f.payload, installation: f.legacy })
  let registered = 0
  const run = () => runPreparedLegacyDesktopTakeover({ prepared, registerEntries: async value => {
    assert.equal(value.installRoot, f.target); assert.equal(value.coreRoot, prepared.coreRoot)
    registered++
    const pending = JSON.parse(await fs.readFile(path.join(f.target, '.desktop-installing.json'), 'utf8'))
    assert.equal(pending.phase, 'prepared'); assert.deepEqual(pending.selection, f.selection)
    assert.throws(() => installation.readDesktopSelection(f.target), { code: 'CRABOT_DESKTOP_INSTALLATION' })
    if (registrationFails && registered === 1) throw new Error('controlled registration failure')
  } })
  if (registrationFails) {
    await assert.rejects(run(), error => {
      assert.equal(error.cause?.message, 'controlled registration failure'); return true
    })
    await assert.rejects(fs.stat(path.join(f.target, 'current-release.json')), { code: 'ENOENT' })
    const { discoverLegacyDesktopTakeover } = await import('../legacy-desktop-discovery.mjs')
    const source = await discoverLegacyDesktopTakeover({ root: f.target })
    assert.deepEqual(source.installation, f.legacy); assert.equal(typeof source.entryFenceId, 'string')
    const again = await prepareLegacyDesktopPrograms({ payload: f.payload, ...source })
    assert.deepEqual(again.selection, prepared.selection); assert.deepEqual(again.proof, prepared.proof)
  }
  const result = await run()
  assert.equal(result.verification_pending, true); assert.equal(result.health_verified, false); assert.equal(result.dataDir, f.data)
  assert.equal(registered, registrationFails ? 2 : 1)
  await assert.rejects(fs.stat(path.join(f.target, '.desktop-installing.json')), { code: 'ENOENT' })
  assert.deepEqual(installation.readDesktopSelection(f.target).selection, f.selection)
  assert.equal(await fs.readFile(path.join(f.data, 'fixture/executions'), 'utf8'), 'once\n')
  const { readVersionMaintenance } = await import('../version-maintenance.mjs')
  assert.equal(readVersionMaintenance(f.data).phase, 'verifying')
})

test('actual installer takeover resumes a partial entry fence before stopping or converting data', { skip: !cachedPythonAvailable }, async t => {
  const f = await legacyProgramFixture(t, { functional: true, realPython: true }); await fs.unlink(path.join(f.data, 'mm.pid'))
  const { fenceLegacyEntries, inspectLegacyEntryFence } = await import('../legacy-entry-fence.mjs'), rename = fs.rename
  const fault = t.mock.method(fs, 'rename', async (from, to) => {
    if (to === path.join(f.target, 'scripts/start.mjs')) throw Object.assign(new Error('controlled partial entry fence'), { code: 'EIO' })
    return rename(from, to)
  })
  await assert.rejects(fenceLegacyEntries(f.legacy), { code: 'EIO' }); fault.mock.restore()
  const partial = await inspectLegacyEntryFence(f.target); assert.equal(partial.phase, 'fencing')
  const { discoverLegacyDesktopTakeover } = await import('../legacy-desktop-discovery.mjs')
  const source = await discoverLegacyDesktopTakeover({ root: f.target })
  assert.equal(source.entryFenceId, partial.id)
  const { prepareLegacyDesktopPrograms } = await import('../legacy-desktop-programs.mjs')
  const prepared = await prepareLegacyDesktopPrograms({ payload: f.payload, ...source })
  assert.equal((await inspectLegacyEntryFence(f.target)).phase, 'fencing', 'online program preparation cannot change old entry state')
  const { runPreparedLegacyDesktopTakeover } = await import('../legacy-desktop-handoff.mjs')
  const result = await runPreparedLegacyDesktopTakeover({ prepared, entryFenceId: partial.id, registerEntries: async () => {} })
  assert.equal(result.verification_pending, true)
  const record = (await import('../version-maintenance.mjs')).readVersionMaintenance(f.data)
  assert.equal(record.phase, 'verifying'); assert.equal(record.legacy_source.entry_fence_id, partial.id)
  assert.equal(await fs.readFile(path.join(f.data, 'fixture/executions'), 'utf8'), 'once\n')
})

for (const conversionFailure of [false, true, 'pre-conversion-stop', 'core-changed-during-conversion', 'stale-modules']) test('Mac App legacy admission uses external original data and retains health protection; failure=' + conversionFailure, { skip: process.platform !== 'darwin' }, async t => {
  const f = await legacyProgramFixture(t, { functional: true, conversionFailure: conversionFailure === true, coreTamper: conversionFailure === 'core-changed-during-conversion', legacyVersion: conversionFailure === 'stale-modules' ? 'v2026.10.14.1' : undefined })
  if (conversionFailure !== 'pre-conversion-stop') await fs.unlink(path.join(f.data, 'mm.pid'))
  if (!conversionFailure || conversionFailure === 'stale-modules') await fs.writeFile(path.join(f.target, '.env'), 'CRABOT_ADMIN_WEB_HOST=0.0.0.0\n')
  const stale = conversionFailure === 'stale-modules' ? await stoppedLegacyModules(f.data) : undefined
  if (stale) { const { fenceLegacyEntries } = await import('../legacy-entry-fence.mjs'); await fenceLegacyEntries(f.legacy) }
  const coreRoot = path.join(f.parent, '真正 Crabot.app/Contents/Resources/core'), home = path.join(f.parent, 'home')
  await fs.mkdir(path.dirname(coreRoot), { recursive: true }); await fs.rename(f.core, coreRoot)
  await fs.writeFile(path.join(coreRoot, 'desktop-host.json'), JSON.stringify({ schema_version: 1, platform: process.platform, arch: process.arch }))
  await fs.mkdir(home)
  const { default: binding } = await import('../mac-app-binding.cjs')
  binding.writeMacAppBinding({ home, appPath: path.resolve(coreRoot, '../../..'), dataDir: f.data })
  const node = path.join(coreRoot, '.product-runtime/node/bin/node'), role = path.join(coreRoot, 'scripts/lib/mac-legacy-admission.mjs')
  const script = `import{pathToFileURL}from'node:url';import{promises as fs}from'node:fs';import path from'node:path';const[module,sourceRoot,home]=process.argv.slice(1);const core=path.resolve(path.dirname(module),'../..'),read=fs.readdir;let scans=0;fs.readdir=(dir,...args)=>{if(path.resolve(dir)===core&&args[0]?.withFileTypes)scans++;return read(dir,...args)};const role=await import(pathToFileURL(module).href);const result=await role.admitLegacyMacData({sourceRoot,home,inspectEnvironment:async()=>({status:'absent'})});console.log(JSON.stringify({...result,core_scans:scans}))`
  const run = () => promisify(execFile)(node, ['--input-type=module', '--eval', script, role, f.target, home], { timeout: 30000, maxBuffer: 65536, env: { ...process.env, HOME: home } })
  if (conversionFailure === 'pre-conversion-stop') {
    const original = await fs.readFile(path.join(f.target, 'cli.mjs'))
    await assert.rejects(run())
    const { inspectLegacyEntryFence } = await import('../legacy-entry-fence.mjs')
    assert.equal((await inspectLegacyEntryFence(f.target)).phase, 'restored')
    await assert.rejects(fs.lstat(path.join(f.data, 'desktop-maintenance.json')), { code: 'ENOENT' })
    await assert.rejects(fs.lstat(path.join(f.data, 'fixture/executions')), { code: 'ENOENT' })
    assert.equal(await fs.readFile(path.join(f.data, 'fixture/content'), 'utf8'), 'old project data')
    assert.deepEqual(await fs.readFile(path.join(f.target, 'cli.mjs')), original)
    return
  }
  if (conversionFailure === 'core-changed-during-conversion') {
    await assert.rejects(run())
    assert.equal(await fs.readFile(path.join(f.data, 'fixture/executions'), 'utf8'), 'once\n')
    await assert.rejects(fs.lstat(path.join(f.data, 'desktop-managed.json')), { code: 'ENOENT' })
    await assert.rejects(run())
    assert.equal(await fs.readFile(path.join(f.data, 'fixture/executions'), 'utf8'), 'once\n')
    return
  }
  if (conversionFailure === true) {
    await assert.rejects(run())
    assert.equal(await fs.readFile(path.join(f.data, 'fixture/content'), 'utf8'), 'old project data')
    await assert.rejects(fs.lstat(path.join(f.data, 'desktop-managed.json')), { code: 'ENOENT' })
    await assert.rejects(run())
  } else {
    const result = JSON.parse((await run()).stdout.trim())
    if (stale) assert.deepEqual(await fs.readdir(stale.records), [])
    assert.ok(result.core_scans <= 9, 'Keep initial and final admission integrity checks without callback rescan: ' + result.core_scans)
    assert.equal(result.dataDir, f.data); assert.equal(result.verification_pending, true)
    assert.equal(await fs.readFile(path.join(f.data, 'fixture/executions'), 'utf8'), 'once\n')
    assert.equal(JSON.parse((await run()).stdout.trim()).maintenance_id, result.maintenance_id)
    assert.equal(await fs.readFile(path.join(f.data, 'fixture/executions'), 'utf8'), 'once\n')
    assert.equal(JSON.parse(await fs.readFile(path.join(f.data, 'desktop-managed.json'), 'utf8')).admin_listen_host, '0.0.0.0')
  }
  for (const name of ['app', 'releases', 'current-release.json', 'desktop-installation.json']) await assert.rejects(fs.lstat(path.join(f.target, name)), { code: 'ENOENT' })
  const { readVersionMaintenance, assertVersionMaintenanceAllowsStart } = await import('../version-maintenance.mjs')
  assert.equal(readVersionMaintenance(f.data).schema_version, 4)
  assert.throws(() => assertVersionMaintenanceAllowsStart(f.data), { code: 'CRABOT_MAINTENANCE_PENDING' })
  if (!conversionFailure || conversionFailure === 'stale-modules') {
    const recovery = `import{pathToFileURL}from'node:url';const[module,data,root,healthy]=process.argv.slice(1);const versions=await import(pathToFileURL(module).href);const done=await versions.recoverLegacyUserVersionMaintenance({dataDir:data,root,appVersion:'1.2.3',verifyTakeover:async()=>{},verifyCompatible:async()=>{},run:async()=>healthy==='yes'});console.log(JSON.stringify({done}))`
    const recover = healthy => promisify(execFile)(node, ['--input-type=module', '--eval', recovery, path.join(coreRoot, 'scripts/lib/version-maintenance.mjs'), f.data, coreRoot, healthy], { timeout: 30000, maxBuffer: 65536, env: { ...process.env, HOME: home } })
    await assert.rejects(recover('no'))
    assert.equal(readVersionMaintenance(f.data).phase, 'verifying')
    assert.deepEqual(JSON.parse((await recover('yes')).stdout.trim()), { done: true })
    assert.equal(readVersionMaintenance(f.data), null)
    assert.equal(await fs.readFile(path.join(f.data, 'fixture/executions'), 'utf8'), 'once\n')
  }
})

for (const previouslyFenced of [false, true]) test('pre-data preparation failure restores legacy entries and a retry converts exactly once; prior fence=' + previouslyFenced, async t => {
  const f = await legacyProgramFixture(t, { functional: true })
  await fs.unlink(path.join(f.data, 'mm.pid'))
  const original = await fs.readFile(path.join(f.target, 'cli.mjs'))
  const { prepareLegacyDesktopPrograms } = await import('../legacy-desktop-programs.mjs')
  const prepared = await prepareLegacyDesktopPrograms({ payload: f.payload, installation: f.legacy })
  if (previouslyFenced) { const { fenceLegacyEntries } = await import('../legacy-entry-fence.mjs'); await fenceLegacyEntries(f.legacy) }
  const node = path.join(prepared.coreRoot, windows ? '.product-runtime/node/node.exe' : '.product-runtime/node/bin/node')
  const module = path.join(prepared.coreRoot, 'scripts/lib/legacy-desktop-takeover.mjs')
  const code = `import{pathToFileURL}from'node:url';const[module,input,fail]=process.argv.slice(1);const role=await import(pathToFileURL(module).href);await role.convertLegacyDesktopData({prepared:JSON.parse(input),inspectEnvironment:async()=>{if(fail==='yes')throw new Error('controlled environment failure');return{status:'absent'}}})`
  const run = fail => promisify(execFile)(node, ['--input-type=module', '--eval', code, module, JSON.stringify(prepared), fail], { timeout: 30000, maxBuffer: 65536 })
  await assert.rejects(run('yes'))
  const { inspectLegacyEntryFence } = await import('../legacy-entry-fence.mjs')
  assert.equal((await inspectLegacyEntryFence(f.target)).phase, 'restored')
  assert.deepEqual(await fs.readFile(path.join(f.target, 'cli.mjs')), original)
  assert.equal(await fs.readFile(path.join(f.data, 'fixture/content'), 'utf8'), 'old project data')
  await assert.rejects(fs.lstat(path.join(f.data, 'desktop-maintenance.json')), { code: 'ENOENT' })
  await run('no'); await run('no')
  assert.equal(await fs.readFile(path.join(f.data, 'fixture/executions'), 'utf8'), 'once\n')
})

async function extractedFirstLaunch(f, selectedRoot) {
  const { default: management } = await import('../desktop-management.cjs')
  const root = selectedRoot ?? management.ensurePrivateDataRoot(path.join(f.parent, '选择的程序目录'))
  const coreRoot = path.join(root, 'releases', f.selection.core_id), guiRoot = path.join(root, 'app/releases', f.selection.gui_id)
  await fs.mkdir(path.dirname(coreRoot), { recursive: true }); await fs.mkdir(path.dirname(guiRoot), { recursive: true }); await fs.mkdir(path.join(root, 'bin'), { recursive: true })
  await fs.rename(f.core, coreRoot); await fs.rename(f.gui, guiRoot)
  if (!(await fs.lstat(path.join(root, 'bin', launcher)).catch(error => { if (error.code !== 'ENOENT') throw error; return null }))) await fs.copyFile(path.join(coreRoot, 'bin', launcher), path.join(root, 'bin', launcher))
  if (!windows) await fs.chmod(path.join(root, 'bin', launcher), 0o755)
  await fs.mkdir(path.join(root, 'app/installers'), { recursive: true })
  await fs.copyFile(path.join(f.payload, 'desktop-payload.json'), path.join(root, 'app/installers', f.selection.gui_id + '.json'))
  const resources = path.join(guiRoot, path.relative(f.gui, f.resources))
  return { root, coreRoot, guiRoot, resources, pinText: JSON.stringify(f.selection) + '\n' }
}

test('first GUI use initializes an already extracted pair without a second program copy or starting services', async t => {
  const f = await fixture(t, { functional: true, schema: 'v2' }), extracted = await extractedFirstLaunch(f)
  const first = await import('../../../crabot-desktop/dist/bootstrap/scripts/lib/desktop-first-launch.mjs'), { default: management } = await import('../desktop-management.cjs')
  const programs = await first.readFirstLaunchPrograms(extracted)
  const forbidden = t.mock.method(fs, 'cp', () => assert.fail('Programs have already been extracted'))
  const data = management.ensurePrivateDataRoot(path.join(extracted.root, 'data'))
  const bound = await first.bindFirstLaunchData(programs, data)
  let registered = 0
  const selected = await first.completeFreshFirstLaunch(bound, async value => { registered++; assert.equal(value.installRoot, extracted.root) })
  assert.equal(registered, 1); assert.equal(selected.dataDir, data)
  assert.equal((await first.readFirstLaunchPrograms(extracted)).initialized, true)
  assert.deepEqual((await fs.readdir(data)).filter(name => name !== 'cli.lock'), ['desktop-managed.json'])
  await assert.rejects(fs.lstat(path.join(data, 'mm.pid')), { code: 'ENOENT' })
  forbidden.mock.restore()
})

test('first GUI legacy admission uses already extracted programs and external original data, preserving retry and health gates', async t => {
  const f = await legacyProgramFixture(t, { functional: true }); await fs.unlink(path.join(f.data, 'mm.pid'))
  const extracted = await extractedFirstLaunch(f), first = await import('../../../crabot-desktop/dist/bootstrap/scripts/lib/desktop-first-launch.mjs')
  const programs = await first.readFirstLaunchPrograms(extracted), bound = await first.bindFirstLaunchData(programs, f.data)
  const prepared = { installRoot: extracted.root, installation: f.legacy, selection: f.selection,
    coreRoot: extracted.coreRoot, guiRoot: extracted.guiRoot, proof: bound.proof }
  const node = path.join(extracted.coreRoot, windows ? '.product-runtime/node/node.exe' : '.product-runtime/node/bin/node')
  const module = path.join(extracted.coreRoot, 'scripts/lib/legacy-desktop-takeover.mjs')
  const code = `import{pathToFileURL}from'node:url';const[module,input,fault]=process.argv.slice(1);const role=await import(pathToFileURL(module).href);const prepared=JSON.parse(input);const converted=await role.convertLegacyDesktopData({prepared,inspectEnvironment:async()=>({status:'absent'})});await role.commitLegacyDesktopInstallation({prepared,maintenanceId:converted.maintenance_id,registerEntries:async value=>{if(fault==='yes')throw new Error('controlled registration failure');if(value.installRoot!==prepared.installRoot)throw new Error('wrong program registration')}})`
  const run = (fault = 'no') => promisify(execFile)(node, ['--input-type=module', '--eval', code, module, JSON.stringify(prepared), fault], { timeout: 30000, maxBuffer: 65536 })
  await assert.rejects(run('yes'))
  await assert.rejects(fs.lstat(path.join(extracted.root, '.desktop-installing.json')), { code: 'ENOENT' })
  assert.equal((await first.readFirstLaunchPrograms(extracted)).initialized, false)
  await run(); await run()
  assert.equal(installation.readDesktopSelection(extracted.root).dataDir, f.data)
  assert.equal((await first.readFirstLaunchPrograms(extracted)).initialized, true)
  assert.equal(await fs.readFile(path.join(f.data, 'fixture/executions'), 'utf8'), 'once\n')
  await assert.rejects(fs.lstat(path.join(extracted.root, 'data')), { code: 'ENOENT' })
  await assert.rejects(fs.lstat(path.join(f.target, 'desktop-installation.json')), { code: 'ENOENT' })
  assert.equal(JSON.parse(await fs.readFile(path.join(f.data, 'desktop-maintenance.json'), 'utf8')).phase, 'verifying')
  const { inspectLegacyEntryFence } = await import('../legacy-entry-fence.mjs')
  assert.equal((await inspectLegacyEntryFence(f.target)).entries_fenced, true)
  await assert.rejects(fs.lstat(path.join(f.target, '.desktop-takeover/completed.json')), { code: 'ENOENT' })
  const health = `import{pathToFileURL}from'node:url';const[module,dataDir,root]=process.argv.slice(1);const versions=await import(pathToFileURL(module).href);await versions.recoverLegacyUserVersionMaintenance({dataDir,root,appVersion:'1.2.3',verifyTakeover:async()=>{},verifyCompatible:async()=>{},run:async()=>true})`
  // Only health is substituted; real maintenance admission/finalization and the
  // original command's target routing are exercised. No live MM is claimed.
  await promisify(execFile)(node, ['--input-type=module', '--eval', health, path.join(extracted.coreRoot, 'scripts/lib/version-maintenance.mjs'), f.data, extracted.coreRoot], { timeout: 30000 })
  const probe = path.join(f.parent, 'old-cli-probe.cmd')
  if (windows) await fs.writeFile(probe, '@echo off\r\ncall "%CRABOT_OLD_COMMAND%" --version\r\nexit /b %errorlevel%\r\n')
  const forwarded = windows
    ? await promisify(execFile)(path.join(process.env.SystemRoot, 'System32/cmd.exe'), ['/d', '/c', probe], { timeout: 15000, env: { ...process.env, CRABOT_OLD_COMMAND: path.join(f.target, 'crabot.cmd') } })
    : await promisify(execFile)(node, [path.join(f.target, 'cli.mjs'), '--version'], { timeout: 15000 })
  assert.equal(JSON.parse(forwarded.stdout.trim()).version, f.selection.version)
  const { discoverLegacyDesktopTakeover } = await import('../legacy-desktop-discovery.mjs')
  assert.equal(await discoverLegacyDesktopTakeover({ root: f.target, source: {} }), null, 'A completed data admission must not be offered again when old programs are retained')
  const receiptFile = path.join(f.target, '.desktop-takeover/completed.json'), receipt = await fs.readFile(receiptFile)
  for (const changed of ['fingerprint', 'data-identity', 'target', 'extra']) {
    const value = JSON.parse(receipt)
    if (changed === 'fingerprint') value.source_fingerprint = 'f'.repeat(64)
    if (changed === 'data-identity') value.data_identity.ino = '0'
    if (changed === 'target') value.target.installation_id = randomUUID()
    if (changed === 'extra') value.ignore = true
    await fs.writeFile(receiptFile, JSON.stringify(value) + '\n')
    await assert.rejects(discoverLegacyDesktopTakeover({ root: f.target, source: {} }))
    await fs.writeFile(receiptFile, receipt)
  }
  await fs.unlink(path.join(f.target, 'VERSION'))
  assert.equal(await discoverLegacyDesktopTakeover({ root: f.target, source: {} }), null, 'Completion does not depend on keeping old program files for discovery')
})

test('an extracted desktop update keeps its original location and scoped stopped-pair conversion instead of re-entering legacy admission', { timeout: 120000 }, async t => {
  const previous = await fixture(t, { functional: true, schema: 'v1' })
  const initial = await prepareDesktopInstallation({ payload: previous.payload, installRoot: previous.target })
  const source = await commitDesktopInstallation(initial)
  const { default: management } = await import('../desktop-management.cjs')
  management.initializeDesktopManagement(source.dataDir)
  await fs.mkdir(path.join(source.dataDir, 'fixture'))
  await fs.writeFile(path.join(source.dataDir, 'fixture/SCHEMA_VERSION'), 'v1')
  await fs.writeFile(path.join(source.dataDir, 'fixture/content'), 'existing desktop content')
  const incoming = await fixture(t, { version: '1.2.4', functional: true, schema: 'v2' })
  const extracted = await extractedFirstLaunch(incoming, source.root), first = await import('../../../crabot-desktop/dist/bootstrap/scripts/lib/desktop-first-launch.mjs')
  const programs = await first.readFirstLaunchPrograms(extracted)
  assert.equal(programs.initialized, false); assert.equal(programs.source.dataDir, source.dataDir)
  const bound = await first.bindFirstLaunchData(programs, source.dataDir)
  const { DesktopController } = await import('../../../crabot-desktop/dist/controller.js')
  const controller = new DesktopController({ coreRoot: source.coreRoot, dataRoot: source.dataDir, appVersion: source.selection.version,
    platform: process.platform, packaged: true, verifyBinding: () => assert.deepEqual(installation.readDesktopSelection(source.root).selection, source.selection) })
  if (windows) {
    const load = controller.load.bind(controller)
    t.mock.method(controller, 'load', async (file, root) => {
      console.log('CRABOT_PAIR_FIXTURE load ' + file)
      return load(file, root)
    })
    controller.host.subscribe(state => console.log('CRABOT_PAIR_FIXTURE phase ' + state.phase))
    const native = (await import(pathToFileURL(path.join(source.coreRoot, 'scripts/lib/process-identity.cjs')).href)).default
    for (const name of ['createPrivateDirectory', 'writePrivateFile', 'tryFileLock']) {
      const original = native[name]
      t.mock.method(native, name, (...args) => {
        console.log('CRABOT_PAIR_FIXTURE native-before ' + name)
        const value = original(...args)
        console.log('CRABOT_PAIR_FIXTURE native-after ' + name)
        return value
      })
    }
  }
  try {
    controller.host.status('stopped', 'fixture was already stopped')
    const prepared = { installRoot: source.root, installation_id: source.record.installation_id, source: source.selection,
      selection: incoming.selection, coreRoot: extracted.coreRoot, guiRoot: extracted.guiRoot, proof: bound.proof }
    await controller.applyPreparedPair(prepared, async () => {})
  } finally { controller.close() }
  const selected = installation.readDesktopSelection(source.root)
  assert.equal(selected.dataDir, source.dataDir); assert.deepEqual(selected.selection, incoming.selection)
  assert.equal(await fs.readFile(path.join(source.dataDir, 'fixture/executions'), 'utf8'), 'once\n')
  assert.equal(JSON.parse(await fs.readFile(path.join(source.dataDir, 'desktop-maintenance.json'), 'utf8')).schema_version, 3)
  await assert.rejects(fs.lstat(path.join(source.root, '.desktop-takeover')), { code: 'ENOENT' })
  assert.equal((await first.readFirstLaunchPrograms(extracted)).initialized, true)
})

test('a cancelled same-directory first use can rediscover its verified legacy data before any entry was fenced', async t => {
  const f = await legacyProgramFixture(t, { functional: true }); await fs.unlink(path.join(f.data, 'mm.pid'))
  const original = await fs.readFile(path.join(f.target, 'cli.mjs'))
  const extracted = await extractedFirstLaunch(f, f.target)
  const first = await import('../../../crabot-desktop/dist/bootstrap/scripts/lib/desktop-first-launch.mjs')
  const programs = await first.readFirstLaunchPrograms(extracted)
  await first.bindFirstLaunchData(programs, f.data)
  const { discoverLegacyDesktopTakeover } = await import('../legacy-desktop-discovery.mjs')
  assert.deepEqual((await discoverLegacyDesktopTakeover({ root: f.target, source: {} })).installation, f.legacy)
  assert.deepEqual(await fs.readFile(path.join(f.target, 'cli.mjs')), original)
  await assert.rejects(fs.lstat(path.join(f.target, '.desktop-takeover')), { code: 'ENOENT' })
  await assert.rejects(fs.lstat(path.join(f.target, 'current-release.json')), { code: 'ENOENT' })
})

for (const version of ['1.2.3', '1.2.4']) test('an extracted retained reinstall uses installed programs and the original data guard without a payload copy: ' + version, async t => {
  const f = await removalProofFixture(t, { schema: 'v1', functional: true })
  f.record.phase = 'completed'; await f.publish()
  const originalProof = await fs.readFile(f.file), data = path.join(f.target, 'data')
  await fs.rm(f.prepared.coreRoot, { recursive: true }); await fs.rm(f.prepared.guiRoot, { recursive: true })
  const incoming = await fixture(t, { version, schema: 'v2', functional: true })
  const extracted = await extractedFirstLaunch(incoming, f.target)
  const first = await import('../../../crabot-desktop/dist/bootstrap/scripts/lib/desktop-first-launch.mjs')
  const programs = await first.readFirstLaunchPrograms(extracted)
  assert.equal(programs.removal.operation_id, f.record.operation_id); assert.equal(programs.source, undefined)
  const bound = await first.bindFirstLaunchData(programs, data)
  const { runPreparedDesktopReinstallHandoff } = await import('../desktop-reinstall-data.mjs')
  let registered = 0
  const prepared = { installRoot: f.target, installation_id: bound.record.installation_id, selection: incoming.selection,
    coreRoot: extracted.coreRoot, guiRoot: extracted.guiRoot, proof: bound.proof }
  const result = await runPreparedDesktopReinstallHandoff({ installRoot: f.target, operationId: f.record.operation_id, prepared,
    registerEntries: async selected => { registered++; assert.deepEqual(selected.selection, incoming.selection) } })
  assert.equal(registered, 1); assert.equal(result.health_verified, false); assert.equal(result.verification_pending, true)
  assert.deepEqual(installation.readDesktopSelection(f.target).selection, incoming.selection)
  const { readVersionMaintenance } = await import('../version-maintenance.mjs')
  const record = readVersionMaintenance(data)
  assert.equal(record.phase, 'installing'); assert.equal(record.source_inventory_sha256, f.selection.core_id)
  assert.equal(record.target_core.inventory_sha256, incoming.selection.core_id)
  assert.deepEqual(await fs.readFile(f.file), originalProof)
  assert.equal(await fs.readFile(path.join(data, 'retained-user-file'), 'utf8'), 'user content')
  await assert.rejects(fs.lstat(path.join(data, 'mm.pid')), { code: 'ENOENT' })
  await assert.rejects(fs.lstat(path.join(f.target, '.desktop-removal.json')), { code: 'ENOENT' })
})
