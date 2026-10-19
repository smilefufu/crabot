import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs, constants } from 'node:fs'
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
  const stat = await fs.stat(root)
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
