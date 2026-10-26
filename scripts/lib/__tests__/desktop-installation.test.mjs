import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs, constants, default as fsSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import desktop from '../desktop-installation.cjs'
import management from '../desktop-management.cjs'
import identity from '../process-identity.cjs'
import location from '../cli-location.cjs'
import entry from '../desktop-entry.cjs'
import { writeCoreRelease, verifyCoreRelease } from '../core-release.mjs'
import { resolveCliDataDir, resolveOffset } from '../instance.mjs'
import { installDesktopCli } from '../desktop-cli-install.mjs'
const windows = process.platform === 'win32', nativeName = windows ? 'crabot.exe' : 'crabot'
const library = path.resolve(import.meta.dirname, '..'), binary = path.resolve(library, '../../crabot-native/build/Release')
async function privateJson(file, value) {
  const text = JSON.stringify(value) + '\n'
  if (windows) identity.writePrivateFile(file, text)
  else await fs.writeFile(file, text, { flag: 'wx', mode: 0o600 })
}
async function fixture(t) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'Crabot 桌面配对 ')))
  t.after(() => fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const root = management.ensurePrivateDataRoot(path.join(parent, '完整 安装'))
  for (const part of ['app/releases', 'releases', 'bin']) await fs.mkdir(path.join(root, part), { recursive: true })
  management.ensurePrivateDataRoot(path.join(root, 'data'))
  const stat = await fs.stat(root, { bigint: true })
  const record = { schema_version: 1, installation_id: randomUUID(), owner: identity.inspectProcess(process.pid).owner,
    install_root: root, root_identity: { dev: String(stat.dev), ino: String(stat.ino) }, paths: { app: 'app/releases', core: 'releases', data: 'data', bin: 'bin' } }
  await privateJson(path.join(root, 'desktop-installation.json'), record)
  const temporary = path.join(root, 'releases/preparing'); await fs.mkdir(temporary)
  const nodeRelative = windows ? '.product-runtime/node/node.exe' : '.product-runtime/node/bin/node'
  await fs.mkdir(path.dirname(path.join(temporary, nodeRelative)), { recursive: true })
  await fs.copyFile(process.execPath, path.join(temporary, nodeRelative), constants.COPYFILE_FICLONE)
  if (!windows) await fs.chmod(path.join(temporary, nodeRelative), 0o755)
  for (const [name, value] of Object.entries({ 'package.json': { version: '1.2.3' }, 'product-runtime.json': { version: '1.2.3' } })) await fs.writeFile(path.join(temporary, name), JSON.stringify(value))
  await fs.copyFile(path.resolve(library, '../../cli.mjs'), path.join(temporary, 'cli.mjs'))
  await fs.mkdir(path.join(temporary, 'scripts/lib'), { recursive: true }); await fs.mkdir(path.join(temporary, 'crabot-native/build/Release'), { recursive: true })
  for (const name of ['cli-location.cjs', 'desktop-installation.cjs', 'process-identity.cjs']) await fs.copyFile(path.join(library, name), path.join(temporary, 'scripts/lib', name))
  await fs.copyFile(path.join(binary, 'crabot-native.node'), path.join(temporary, 'crabot-native/build/Release/crabot-native.node'))
  await fs.mkdir(path.join(temporary, 'scripts'), { recursive: true })
  await fs.writeFile(path.join(temporary, 'scripts/help.mjs'), 'console.log(JSON.stringify({data:process.env.DATA_DIR,core:process.env.CRABOT_HOME}))')
  await writeCoreRelease(temporary, { schema_version: 1, version: '1.2.3', platform: process.platform, arch: process.arch, commit: '1'.repeat(40), source_dirty: false })
  const release = JSON.parse(await fs.readFile(path.join(temporary, 'core-release.json'), 'utf8'))
  const selection = { schema_version: 1, version: '1.2.3', gui_id: randomUUID(), core_id: release.inventory_sha256 }
  const coreRoot = path.join(root, 'releases', selection.core_id); await fs.rename(temporary, coreRoot)
  const guiRoot = path.join(root, 'app/releases', selection.gui_id)
  const resources = path.join(guiRoot, process.platform === 'darwin' ? 'Crabot.app/Contents/Resources' : 'resources')
  const executable = path.join(guiRoot, process.platform === 'darwin' ? 'Crabot.app/Contents/MacOS/Crabot' : windows ? 'Crabot.exe' : 'crabot-desktop')
  await fs.mkdir(resources, { recursive: true }); await fs.mkdir(path.dirname(executable), { recursive: true })
  await fs.writeFile(executable, 'fixture GUI executable; never launched')
  await fs.writeFile(path.join(resources, 'desktop-release.json'), JSON.stringify(selection))
  await privateJson(path.join(root, 'current-release.json'), selection)
  await fs.copyFile(path.join(binary, nativeName), path.join(root, 'bin', nativeName)); if (!windows) await fs.chmod(path.join(root, 'bin', nativeName), 0o755)
  return { parent, root, record, coreRoot, guiRoot, resources, executable, selection }
}
test('GUI, native CLI bootstrap and peer policy use the same selected pair and root-local data', async t => {
  const f = await fixture(t), selected = desktop.readDesktopSelection(f.root)
  assert.equal(selected.coreRoot, f.coreRoot); assert.equal(desktop.locateDesktopGui(f.resources).dataDir, path.join(f.root, 'data'))
  assert.equal(location.assertSelectedCli(f.coreRoot).scope, 'desktop')
  assert.equal(entry.loadDesktopEntry(f.coreRoot).executable, f.executable)
  const alias = path.join(f.parent, '应用入口 别名')
  await fs.symlink(f.guiRoot, alias, windows ? 'junction' : 'dir')
  const aliasResources = path.join(alias, path.relative(f.guiRoot, f.resources))
  assert.equal(desktop.locateDesktopGui(aliasResources).coreRoot, f.coreRoot)
  const env = { PATH: '' }; desktop.applyDesktopEnvironment(selected, env)
  const { stdout } = await promisify(execFile)(path.join(f.root, 'bin', nativeName), ['help'], { env })
  assert.deepEqual(JSON.parse(stdout), { data: selected.dataDir, core: f.coreRoot })
  assert.equal((await verifyCoreRelease(f.coreRoot)).inventory_sha256, f.selection.core_id)
  await assert.rejects(fs.lstat(path.join(f.root, 'current-core')), { code: 'ENOENT' })
  await assert.rejects(fs.lstat(path.join(selected.dataDir, 'mm.pid')), { code: 'ENOENT' })
})
test('wrong owner, replaced root identity, redirected layout and moved root fail without data creation', async t => {
  const f = await fixture(t), file = path.join(f.root, 'desktop-installation.json')
  for (const record of [{ ...f.record, owner: 'another-account' }, { ...f.record, root_identity: { ...f.record.root_identity, ino: '0' } }, { ...f.record, paths: { ...f.record.paths, data: '../elsewhere' } }]) {
    await fs.writeFile(file, JSON.stringify(record)); assert.throws(() => desktop.readDesktopSelection(f.root), { code: 'CRABOT_DESKTOP_INSTALLATION' })
  }
  await fs.writeFile(file, JSON.stringify(f.record))
  const moved = path.join(f.parent, '挪动 整体根'); await fs.rename(f.root, moved)
  assert.throws(() => desktop.readDesktopSelection(moved), { code: 'CRABOT_DESKTOP_INSTALLATION' })
  await fs.rename(moved, f.root)
  const bin = path.join(f.root, 'bin'), previous = path.join(f.root, 'old-bin'); await fs.rename(bin, previous); await fs.symlink(previous, bin, windows ? 'junction' : 'dir')
  assert.throws(() => desktop.readDesktopSelection(f.root), { code: 'CRABOT_DESKTOP_INSTALLATION' })
  assert.deepEqual(await fs.readdir(path.join(f.root, 'data')), [])
})
test('a mismatched pair, stale GUI/Core, duplicate authority and missing upgraded data never fall back', async t => {
  const f = await fixture(t), file = path.join(f.root, 'current-release.json'), good = JSON.stringify(f.selection) + '\n'
  for (const value of [{ ...f.selection, core_id: '../escape' }, { ...f.selection, version: '1.2.4' }, { ...f.selection, extra: true }]) {
    await fs.writeFile(file, JSON.stringify(value) + '\n'); assert.throws(() => desktop.locateDesktopCore(f.coreRoot), { code: 'CRABOT_DESKTOP_INSTALLATION' })
  }
  await fs.writeFile(file, good); await fs.writeFile(path.join(f.root, 'current-core'), f.selection.core_id + '\n')
  assert.throws(() => desktop.readDesktopSelection(f.root), { code: 'CRABOT_DESKTOP_INSTALLATION' }); await fs.rm(path.join(f.root, 'current-core'))
  const unselected = path.join(f.root, 'releases', 'a'.repeat(64)); await fs.mkdir(unselected)
  assert.throws(() => location.assertSelectedCli(unselected), { code: 'CRABOT_DESKTOP_INSTALLATION' })
  const staleResources = path.join(f.root, 'app/releases', randomUUID(), process.platform === 'darwin' ? 'Crabot.app/Contents/Resources' : 'resources')
  await fs.mkdir(staleResources, { recursive: true }); await fs.writeFile(path.join(staleResources, 'desktop-release.json'), JSON.stringify(f.selection))
  assert.throws(() => desktop.locateDesktopGui(staleResources), { code: 'CRABOT_DESKTOP_INSTALLATION' })
  await fs.rm(file); assert.throws(() => desktop.locateDesktopCore(f.coreRoot), { code: 'CRABOT_DESKTOP_INSTALLATION' })
  await privateJson(file, f.selection); await fs.rmdir(path.join(f.root, 'data'))
  assert.throws(() => desktop.readDesktopSelection(f.root), { code: 'CRABOT_DESKTOP_INSTALLATION' }); await assert.rejects(fs.lstat(path.join(f.root, 'data')), { code: 'ENOENT' })
})
test('explicit conflicting data, development mode and system offset cannot split a desktop installation', async t => {
  const f = await fixture(t), selected = desktop.readDesktopSelection(f.root)
  for (const env of [{ DATA_DIR: f.parent }, { CRABOT_DEV: 'true' }, { CRABOT_PORT_OFFSET: '100' }]) assert.throws(() => desktop.applyDesktopEnvironment(selected, env), { code: 'CRABOT_DESKTOP_INSTALLATION' })
  assert.deepEqual(await fs.readdir(selected.dataDir), [])
})

test('missing installation records on a paired Core fail before CLI dependency bootstrap', async t => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.coreRoot, 'desktop-host.json'), JSON.stringify({ schema_version: 2, platform: process.platform, arch: process.arch }))
  await fs.rm(path.join(f.root, 'desktop-installation.json')); await fs.rm(path.join(f.root, 'current-release.json'))
  assert.throws(() => location.assertSelectedCli(f.coreRoot), { code: 'CRABOT_DESKTOP_INSTALLATION' })
  await assert.rejects(promisify(execFile)(path.join(f.root, 'bin', nativeName), ['help']), { code: 127 })
  assert.deepEqual(await fs.readdir(path.join(f.root, 'data')), [])
})


test('desktop command registration targets the stable root command, not a retained Core', { skip: windows && process.env.GITHUB_ACTIONS !== 'true' }, async t => {
  const f = await fixture(t), home = management.ensurePrivateDataRoot(path.join(f.parent, '用户'))
  await fs.writeFile(path.join(f.coreRoot, 'desktop-host.json'), JSON.stringify({ schema_version: 2, platform: process.platform, arch: process.arch }))
  const env = { ...process.env, HOME: home, SHELL: '/bin/zsh', PATH: windows ? process.env.SystemRoot + '\\System32' : '/usr/bin:/bin',
    LOCALAPPDATA: path.join(home, 'AppData/Local'), CRABOT_DEV: 'false', CRABOT_PORT_OFFSET: '0' }
  delete env.ZDOTDIR; delete env.DATA_DIR
  const installed = await installDesktopCli({ coreRoot: f.coreRoot, dataDir: path.join(f.root, 'data'), home, env })
  const prefix = path.dirname(installed.command), metadata = JSON.parse(await fs.readFile(path.join(prefix, '.crabot-desktop-cli.json'), 'utf8'))
  assert.deepEqual(metadata, { schema_version: 2, install_root: f.root })
  if (windows) {
    assert.equal(await fs.realpath(path.join(prefix, '.crabot-desktop-core')), f.root)
    assert.match(await fs.readFile(installed.command, 'utf8'), /bin\\crabot\.exe/)
    const probe = path.join(f.parent, 'probe.cmd')
    await fs.writeFile(probe, '@echo off\r\ncall "%CRABOT_TEST_CLI%" help\r\nexit /b %errorlevel%\r\n')
    const result = await promisify(execFile)(path.join(process.env.SystemRoot, 'System32/cmd.exe'), ['/d', '/c', probe], { env: { ...env, CRABOT_TEST_CLI: installed.command } })
    assert.deepEqual(JSON.parse(result.stdout), { data: path.join(f.root, 'data'), core: f.coreRoot })
  } else {
    assert.equal(await fs.readlink(installed.command), path.join(f.root, 'bin/crabot'))
    const result = await promisify(execFile)(installed.command, ['help'], { env })
    assert.deepEqual(JSON.parse(result.stdout), { data: path.join(f.root, 'data'), core: f.coreRoot })
  }
  assert.equal((await installDesktopCli({ coreRoot: f.coreRoot, dataDir: path.join(f.root, 'data'), home, env })).command, installed.command)
  await assert.rejects(fs.lstat(path.join(f.root, 'current-core')), { code: 'ENOENT' })
})


test('installation root identity retains exact 64-bit file IDs rather than rounded Number values', async t => {
  const f = await fixture(t), file = path.join(f.root, 'desktop-installation.json'), exact = 9007199254740993n
  await fs.writeFile(file, JSON.stringify({ ...f.record, root_identity: { ...f.record.root_identity, ino: String(exact) } }))
  const lstat = fsSync.lstatSync
  let inode = exact
  t.mock.method(fsSync, 'lstatSync', (name, options) => {
    const stat = lstat(name, options)
    if (name !== f.root) return stat
    const value = Object.create(stat); value.ino = options?.bigint ? inode : Number(inode); return value
  })
  assert.equal(desktop.readDesktopSelection(f.root).record.root_identity.ino, String(exact))
  inode = exact - 1n
  assert.throws(() => desktop.readDesktopSelection(f.root), { code: 'CRABOT_DESKTOP_INSTALLATION' })
})


test('desktop binding pins its Core and zero offset before stale CLI instance hints are read', async t => {
  const f = await fixture(t), selected = desktop.readDesktopSelection(f.root), home = path.join(f.parent, 'old-cli-home')
  await fs.mkdir(home); await fs.writeFile(path.join(home, 'instance.json'), JSON.stringify({ port_offset: 100 }))
  const env = { CRABOT_HOME: 'stale-installation' }
  desktop.applyDesktopEnvironment(selected, env)
  assert.equal(resolveCliDataDir({ homeDir: home, env }), selected.dataDir)
  assert.equal(resolveOffset(home, env), 0); assert.equal(env.CRABOT_PORT_OFFSET, '0')
  assert.equal(env.CRABOT_HOME, selected.coreRoot); assert.equal(env.CRABOT_DEV, 'false')
})

test('a paired GUI must match its own protected ASAR declaration before any external Core can be used', async t => {
  const f = await fixture(t), pin = JSON.stringify(f.selection) + '\n'
  assert.equal(desktop.locatePinnedDesktopGui(f.resources, pin).coreRoot, f.coreRoot)
  for (const text of [undefined, '', JSON.stringify(f.selection), JSON.stringify({ ...f.selection, gui_id: randomUUID() }) + '\n',
    JSON.stringify({ ...f.selection, core_id: 'f'.repeat(64) }) + '\n', JSON.stringify({ ...f.selection, extra: true }) + '\n']) {
    assert.throws(() => desktop.locatePinnedDesktopGui(f.resources, text), { code: 'CRABOT_DESKTOP_INSTALLATION' })
  }
  assert.deepEqual(await fs.readdir(path.join(f.root, 'data')), [])
})
test('changing outer pair declarations and selector together cannot change a protected GUI identity', async t => {
  const f = await fixture(t), pin = JSON.stringify(f.selection) + '\n'
  const changed = { ...f.selection, gui_id: randomUUID() }, moved = path.join(f.root, 'app/releases', changed.gui_id)
  await fs.rename(f.guiRoot, moved)
  const resources = path.join(moved, path.relative(f.guiRoot, f.resources))
  await fs.writeFile(path.join(resources, 'desktop-release.json'), JSON.stringify(changed))
  await fs.writeFile(path.join(f.root, 'current-release.json'), JSON.stringify(changed) + '\n')
  assert.deepEqual(desktop.locateDesktopGui(resources).selection, changed)
  assert.throws(() => desktop.locatePinnedDesktopGui(resources, pin), { code: 'CRABOT_DESKTOP_INSTALLATION' })
  assert.deepEqual(await fs.readdir(path.join(f.root, 'data')), [])
})

for (const damage of ['missing GUI', 'missing Core', 'missing pin', 'changed pin']) test('repair can read the original installation reference without treating damaged programs as executable authority: ' + damage, async t => {
  const f = await fixture(t), data = path.join(f.root, 'data'), sentinel = path.join(data, 'user-state.json')
  await fs.writeFile(sentinel, '{"keep":"original user state"}')
  const selected = await fs.readFile(path.join(f.root, 'current-release.json')), rootRecord = await fs.readFile(path.join(f.root, 'desktop-installation.json'))
  if (damage === 'missing GUI') await fs.rm(f.guiRoot, { recursive: true })
  if (damage === 'missing Core') await fs.rm(f.coreRoot, { recursive: true })
  if (damage === 'missing pin') await fs.rm(path.join(f.resources, 'desktop-release.json'))
  if (damage === 'changed pin') await fs.writeFile(path.join(f.resources, 'desktop-release.json'), JSON.stringify({ ...f.selection, core_id: 'a'.repeat(64) }))
  assert.deepEqual(desktop.readDesktopPairReference(f.root), { installation_id: f.record.installation_id, install_root: f.root, data_dir: data, selection: f.selection })
  assert.throws(() => desktop.readDesktopSelection(f.root), { code: 'CRABOT_DESKTOP_INSTALLATION' })
  assert.equal(await fs.readFile(sentinel, 'utf8'), '{"keep":"original user state"}')
  assert.deepEqual(await fs.readFile(path.join(f.root, 'current-release.json')), selected)
  assert.deepEqual(await fs.readFile(path.join(f.root, 'desktop-installation.json')), rootRecord)
  assert.deepEqual(await fs.readdir(data), ['user-state.json'])
})
test('repair references can inspect a pending install but cannot authorize ordinary startup or clear protection', async t => {
  const f = await fixture(t), pending = path.join(f.root, '.desktop-installing.json')
  await fs.writeFile(pending, 'pending evidence')
  const reference = desktop.readDesktopPairReference(f.root)
  assert.equal(reference.install_root, f.root); assert.deepEqual(reference.selection, f.selection)
  for (const key of ['executable', 'resources', 'coreRoot', 'guiRoot', 'dataDir']) assert.equal(Object.hasOwn(reference, key), false)
  assert.throws(() => desktop.readDesktopSelection(f.root), { code: 'CRABOT_DESKTOP_INSTALLATION' })
  assert.equal(await fs.readFile(pending, 'utf8'), 'pending evidence')
})
test('repair references retain strict owner, selector and data-directory checks without replacing anything', async t => {
  const f = await fixture(t), selector = path.join(f.root, 'current-release.json'), installation = path.join(f.root, 'desktop-installation.json')
  for (const selection of [{ ...f.selection, gui_id: '../elsewhere' }, { ...f.selection, extra: true }, { ...f.selection, schema_version: 2 }]) {
    await fs.writeFile(selector, JSON.stringify(selection) + '\n')
    assert.throws(() => desktop.readDesktopPairReference(f.root), { code: 'CRABOT_DESKTOP_INSTALLATION' })
  }
  await fs.writeFile(selector, JSON.stringify(f.selection))
  assert.throws(() => desktop.readDesktopPairReference(f.root), { code: 'CRABOT_DESKTOP_INSTALLATION' })
  await fs.writeFile(selector, JSON.stringify(f.selection) + '\n')
  await fs.writeFile(installation, JSON.stringify({ ...f.record, owner: 'different-account' }) + '\n')
  assert.throws(() => desktop.readDesktopPairReference(f.root), { code: 'CRABOT_DESKTOP_INSTALLATION' })
  await fs.writeFile(installation, JSON.stringify(f.record) + '\n')
  await fs.rmdir(path.join(f.root, 'data'))
  assert.throws(() => desktop.readDesktopPairReference(f.root), { code: 'CRABOT_DESKTOP_INSTALLATION' })
  await assert.rejects(fs.stat(path.join(f.root, 'data')), { code: 'ENOENT' })
})

test('a repair reference cannot accidentally become startup environment or select a default empty instance', async t => {
  const f = await fixture(t), reference = desktop.readDesktopPairReference(f.root), env = { PATH: 'unchanged' }
  assert.throws(() => desktop.applyDesktopEnvironment(reference, env), { code: 'CRABOT_DESKTOP_INSTALLATION' })
  assert.deepEqual(env, { PATH: 'unchanged' })
  assert.deepEqual(await fs.readdir(path.join(f.root, 'data')), [])
})

test('production peer policy requires the selected executable and rejects fixture or debugger arguments', async t => {
  const f = await fixture(t), peer = identity.inspectProcess(process.pid), policy = { executable: peer.executable, development: false }
  let arguments_ = [peer.executable]
  t.mock.method(identity, 'inspectProcessArguments', () => arguments_)
  assert.equal(entry.verifyDesktopEntry(peer, policy), true)
  arguments_ = [peer.executable, '--background']; assert.equal(entry.verifyDesktopEntry(peer, policy), true)
  for (const extra of ['--remote-debugging-port=23456', '--fixture-config=example', 'paired-update-source.cjs']) {
    arguments_ = [peer.executable, extra]; assert.equal(entry.verifyDesktopEntry(peer, policy), false)
  }
  arguments_ = [peer.executable]
  assert.equal(entry.verifyDesktopEntry(peer, { ...policy, executable: f.executable }), false)
})


const removalRecord = f => ({ schema_version: 1, installation_id: f.record.installation_id, operation_id: randomUUID(), source_selection: f.selection, phase: 'preparing', proof_sha256: 'a'.repeat(64) })
for (const phase of ['preparing', 'stopping', 'removing', 'completed']) test('desktop removal protection blocks GUI/CLI selection and native launch without changing data: ' + phase, async t => {
  const f = await fixture(t), record = { ...removalRecord(f), phase }
  await privateJson(path.join(f.root, '.desktop-removal.json'), record)
  const before = await fs.readFile(path.join(f.root, 'current-release.json'))
  assert.throws(() => desktop.readDesktopSelection(f.root), { code: 'CRABOT_DESKTOP_REMOVAL_PENDING' })
  assert.throws(() => desktop.locateDesktopCore(f.coreRoot), { code: 'CRABOT_DESKTOP_REMOVAL_PENDING' })
  assert.throws(() => desktop.locateDesktopGui(f.resources), { code: 'CRABOT_DESKTOP_REMOVAL_PENDING' })
  assert.deepEqual(desktop.readDesktopPairReference(f.root).selection, f.selection, 'diagnosis does not authorize startup')
  await assert.rejects(promisify(execFile)(path.join(f.root, 'bin', nativeName), ['help'], { env: { ...process.env, PATH: '' } }), error => error.code === 127 && /remov|uninstall/i.test(error.stderr))
  assert.deepEqual(await fs.readFile(path.join(f.root, 'current-release.json')), before)
  assert.deepEqual(await fs.readdir(path.join(f.root, 'data')), [])
})
for (const changed of ['malformed', 'directory', 'link']) test('unreadable removal protection never permits ordinary native startup: ' + changed, async t => {
  const f = await fixture(t), file = path.join(f.root, '.desktop-removal.json')
  if (changed === 'malformed') await fs.writeFile(file, 'invalid interrupted removal')
  else if (changed === 'directory') await fs.mkdir(file)
  else await fs.symlink(path.join(f.parent, 'missing-removal-state'), file, 'file')
  await assert.rejects(promisify(execFile)(path.join(f.root, 'bin', nativeName), ['help'], { env: { ...process.env, PATH: '' } }), error => error.code === 127 && /remov|uninstall/i.test(error.stderr))
  assert.throws(() => desktop.readDesktopSelection(f.root), { code: 'CRABOT_DESKTOP_REMOVAL_PENDING' })
  assert.deepEqual(await fs.readdir(path.join(f.root, 'data')), [])
})
test('strict private removal reader returns facts only and preserves historical source selection', async t => {
  const f = await fixture(t), removal = await import('../desktop-removal-record.cjs')
  assert.equal(removal.default.readDesktopRemoval(f.root), null)
  const record = removalRecord(f), file = path.join(f.root, '.desktop-removal.json')
  await privateJson(file, record)
  assert.deepEqual(removal.default.readDesktopRemoval(f.root), record)
  // Reinstall may have selected a verified new target while the original
  // removal fence still blocks business. Parsing never authorizes that target.
  await fs.writeFile(path.join(f.root, 'current-release.json'), JSON.stringify({ ...f.selection, gui_id: randomUUID() }) + '\n')
  assert.deepEqual(removal.default.readDesktopRemoval(f.root), record)
  assert.equal(await fs.readFile(file, 'utf8'), JSON.stringify(record) + '\n')
  assert.deepEqual(await fs.readdir(path.join(f.root, 'data')), [])
})
for (const changed of ['wrong-installation', 'bad-phase', 'bad-uuid', 'bad-hash', 'extra', 'unknown-selection', 'noncanonical', 'duplicate', 'hardlink', ...(windows ? [] : ['wide-permissions'])]) test('strict removal reader rejects changed or ambiguous state: ' + changed, async t => {
  const f = await fixture(t), removal = (await import('../desktop-removal-record.cjs')).default, record = removalRecord(f), file = path.join(f.root, '.desktop-removal.json')
  if (changed === 'wrong-installation') record.installation_id = randomUUID()
  else if (changed === 'bad-phase') record.phase = 'cancelled'
  else if (changed === 'bad-uuid') record.operation_id = '../another-installation'
  else if (changed === 'bad-hash') record.proof_sha256 = 'a'.repeat(63)
  else if (changed === 'extra') record.executable = '/untrusted/temporary-program'
  else if (changed === 'unknown-selection') record.source_selection.extra = true
  await privateJson(file, record)
  if (changed === 'noncanonical') await fs.appendFile(file, ' ')
  else if (changed === 'duplicate') await fs.writeFile(file, '{"schema_version":0,' + JSON.stringify(record).slice(1) + '\n')
  else if (changed === 'hardlink') await fs.link(file, file + '.other')
  else if (changed === 'wide-permissions') await fs.chmod(file, 0o644)
  assert.throws(() => removal.readDesktopRemoval(f.root), { code: 'CRABOT_DESKTOP_REMOVAL' })
  assert.deepEqual(await fs.readdir(path.join(f.root, 'data')), [])
})

for (const managed of [false, true]) test('normal MM entry refuses removal before data, PID, venv or business initialization: ' + managed, async t => {
  const f = await fixture(t), cwd = path.join(f.coreRoot, 'crabot-core'), forbidden = path.join(f.parent, 'never-create-data')
  const entryFile = path.resolve(library, '../../crabot-core/dist/main.js'), preload = path.join(f.parent, 'finite-mm-preload.cjs'), marker = path.join(f.parent, 'business-started')
  await fs.mkdir(cwd)
  await privateJson(path.join(f.root, '.desktop-removal.json'), removalRecord(f))
  await fs.writeFile(preload, `const Module=require('node:module'),fs=require('node:fs');const load=Module._load;Module._load=function(request,parent,...rest){if(parent?.filename===${JSON.stringify(entryFile)}){if(request==='./index.js')return class{constructor(){fs.writeFileSync(${JSON.stringify(marker)},'must never construct business MM');throw new Error('business forbidden')}};if(request==='./agent-venv.js')return{ensureAgentVenv(){fs.writeFileSync(${JSON.stringify(marker)},'must never create venv');throw new Error('venv forbidden')}}}return load.call(this,request,parent,...rest)}`)
  const env = { ...process.env, DATA_DIR: forbidden, CRABOT_PRODUCT_REQUIRED: '0', CRABOT_DEV: 'false', CRABOT_PORT_OFFSET: '0' }
  if (managed) env.CRABOT_INSTANCE_GENERATION = randomUUID()
  else delete env.CRABOT_INSTANCE_GENERATION
  await assert.rejects(promisify(execFile)(process.execPath, ['--require', preload, entryFile], { cwd, env, timeout: 12000, maxBuffer: 65536 }), error => error.code === 1 && /卸载|CRABOT_DESKTOP_REMOVAL_PENDING/.test(error.stderr))
  await assert.rejects(fs.lstat(forbidden), { code: 'ENOENT' })
  await assert.rejects(fs.lstat(marker), { code: 'ENOENT' })
  assert.deepEqual(await fs.readdir(path.join(f.root, 'data')), [])
})

for (const changed of ['oversized', 'replaced-during-read']) test('strict removal reader bounds bytes and rejects a changed open record: ' + changed, async t => {
  const f = await fixture(t), removal = (await import('../desktop-removal-record.cjs')).default, file = path.join(f.root, '.desktop-removal.json')
  await privateJson(file, removalRecord(f))
  if (changed === 'oversized') await fs.writeFile(file, 'x'.repeat(4097))
  const read = fsSync.readFileSync
  let descriptorReads = 0
  const injected = t.mock.method(fsSync, 'readFileSync', function(source, ...args) {
    const result = read.call(this, source, ...args)
    if (typeof source === 'number') { descriptorReads++; if (changed === 'replaced-during-read') fsSync.appendFileSync(file, ' ') }
    return result
  })
  try { assert.throws(() => removal.readDesktopRemoval(f.root), { code: 'CRABOT_DESKTOP_REMOVAL' }) }
  finally { injected.mock.restore() }
  assert.equal(descriptorReads, changed === 'oversized' ? 0 : 1)
  assert.throws(() => desktop.readDesktopSelection(f.root), { code: 'CRABOT_DESKTOP_REMOVAL_PENDING' })
  await fs.rename(file, file + '.retained')
  assert.deepEqual(await fs.readdir(path.join(f.root, 'data')), [])
})

for (const modes of [[0o755, 0o755], [0o755, 0o700], [0o700, 0o755]]) {
  test('existing desktop locator preserves usable legacy directory modes: ' + modes.join('/'), { skip: windows }, async t => {
    const f = await fixture(t), data = path.join(f.root, 'data')
    await fs.chmod(f.root, modes[0]); await fs.chmod(data, modes[1])
    const selected = desktop.readDesktopSelection(f.root)
    assert.equal(selected.dataDir, data); assert.equal(desktop.locateDesktopGui(f.resources).coreRoot, f.coreRoot)
    const result = await promisify(execFile)(path.join(f.root, 'bin', nativeName), ['help'], { env: { PATH: '' } })
    assert.deepEqual(JSON.parse(result.stdout), { data, core: f.coreRoot })
    assert.deepEqual(await Promise.all([f.root, data].map(async directory => (await fs.stat(directory)).mode & 0o777)), modes)
    assert.deepEqual(await fs.readdir(data), [])
  })
}
for (const name of ['root', 'data']) test('existing desktop locator still rejects other-user writable directories: ' + name, { skip: windows }, async t => {
  const f = await fixture(t), directory = name === 'root' ? f.root : path.join(f.root, 'data')
  await fs.chmod(directory, 0o775)
  assert.throws(() => desktop.readDesktopSelection(f.root), { code: 'CRABOT_DESKTOP_INSTALLATION' })
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o775)
  assert.deepEqual(await fs.readdir(path.join(f.root, 'data')), [])
})

for (const name of ['desktop-installation.json', 'current-release.json']) test('legacy readable roots do not relax private desktop control files: ' + name, { skip: windows }, async t => {
  const f = await fixture(t), file = path.join(f.root, name)
  await fs.chmod(f.root, 0o755); await fs.chmod(path.join(f.root, 'data'), 0o755); await fs.chmod(file, 0o644)
  assert.throws(() => desktop.readDesktopSelection(f.root), { code: 'CRABOT_DESKTOP_INSTALLATION' })
  assert.equal((await fs.stat(file)).mode & 0o777, 0o644)
  assert.equal((await fs.stat(f.root)).mode & 0o777, 0o755)
})


test('Windows uninstall source is maintenance-only and never a desktop business peer', t => {
  const peer = identity.inspectProcess(process.pid), policy = { executable: peer.executable, development: false }
  let args = [peer.executable, '--uninstall']
  t.mock.method(identity, 'inspectProcessArguments', () => args)
  assert.equal(typeof entry.verifyDesktopRemovalSourceEntry, 'function')
  assert.equal(entry.verifyDesktopEntry(peer, policy), false)
  assert.equal(entry.verifyDesktopRemovalSourceEntry(peer, policy), process.platform === 'win32')
  for (const tail of [['--uninstall', '--background'], ['--uninstall', '--uninstall'], ['--uninstall=other'], ['--uninstall', '--remote-debugging-port=23456']]) {
    args = [peer.executable, ...tail]
    assert.equal(entry.verifyDesktopRemovalSourceEntry(peer, policy), false)
    assert.equal(entry.verifyDesktopEntry(peer, policy), false)
  }
  args = [peer.executable, '--uninstall']
  assert.equal(entry.verifyDesktopRemovalSourceEntry(peer, { ...policy, development: true, entry: peer.executable }), false)
  assert.equal(entry.verifyDesktopRemovalSourceEntry({ ...peer, started: 'other-generation' }, policy), false)
  args = [peer.executable, '--background']
  assert.equal(entry.verifyDesktopRemovalSourceEntry(peer, policy), true)
})
