import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import identity from '../process-identity.cjs'
import installation from '../desktop-installation.cjs'
import { writeCoreRelease, verifyCoreRelease } from '../core-release.mjs'
import { sealDesktopPayload, verifyDesktopPayload, prepareDesktopInstallation, commitDesktopInstallation } from '../desktop-payload.mjs'
const windows = process.platform === 'win32', launcher = windows ? 'crabot.exe' : 'crabot'
async function fixture(t) {
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
  for (const file of ['package.json', 'product-runtime.json']) await fs.writeFile(path.join(core, file), '{"version":"1.2.3"}')
  await fs.writeFile(path.join(core, 'cli.mjs'), 'console.log(JSON.stringify({version:"1.2.3",required:process.env.CRABOT_PRODUCT_REQUIRED}))')
  await writeCoreRelease(core, { schema_version: 1, version: '1.2.3', platform: process.platform, arch: process.arch, commit: '1'.repeat(40), source_dirty: false })
  const release = await verifyCoreRelease(core), selection = { schema_version: 1, version: '1.2.3', gui_id: randomUUID(), core_id: release.inventory_sha256 }
  await fs.writeFile(path.join(core, 'desktop-host.json'), JSON.stringify({ schema_version: 2, platform: process.platform, arch: process.arch }))
  await fs.mkdir(path.dirname(exe), { recursive: true }); await fs.mkdir(resources, { recursive: true })
  await fs.writeFile(exe, 'GUI fixture, never launched'); await fs.writeFile(path.join(resources, 'app.asar'), 'opaque GUI fixture bytes')
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
