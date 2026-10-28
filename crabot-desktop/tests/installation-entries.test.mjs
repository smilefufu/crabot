import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs, writeFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { desktopApplicationEntry, integrationRoot, readInstallationLocator, registerInstallationEntries } from '../dist/installation-entries.js'
import identity from '../../scripts/lib/process-identity.cjs'
import management from '../../scripts/lib/desktop-management.cjs'
const windows = process.platform === 'win32'
const uninstallEntries = new Map()
if (windows) {
  const entryIdentity = createRequire(new URL('../dist/installation-entries.js', import.meta.url))('./bootstrap/scripts/lib/process-identity.cjs')
  const replace = entryIdentity.replaceDesktopUninstallEntry
  entryIdentity.replaceDesktopUninstallEntry = (id, source, target) => {
    const result = replace(id, source, target)
    if (result === true) uninstallEntries.set(id, target)
    return result
  }
}

async function fixture(t) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'Crabot 系统入口 ')))
  t.after(() => fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const root = management.ensurePrivateDataRoot(path.join(parent, '安装')), home = management.ensurePrivateDataRoot(path.join(parent, '用户'))
  for (const name of ['app/releases', 'releases', 'bin']) await fs.mkdir(path.join(root, name), { recursive: true })
  management.ensurePrivateDataRoot(path.join(root, 'data'))
  const stat = await fs.lstat(root, { bigint: true }), id = randomUUID(), guiId = randomUUID(), coreId = 'a'.repeat(64)
  if (windows) t.after(() => {
    const entry = uninstallEntries.get(id)
    if (entry) { assert.equal(identity.removeDesktopUninstallEntry(id, entry), true); uninstallEntries.delete(id) }
  })
  const record = { schema_version: 1, installation_id: id, owner: identity.inspectProcess(process.pid).owner,
    install_root: root, root_identity: { dev: String(stat.dev), ino: String(stat.ino) }, paths: { app: 'app/releases', core: 'releases', data: 'data', bin: 'bin' } }
  const text = JSON.stringify(record) + '\n', file = path.join(root, 'desktop-installation.json')
  if (windows) identity.writePrivateFile(file, text); else await fs.writeFile(file, text, { mode: 0o600 })
  const guiRoot = path.join(root, 'app/releases', guiId)
  await fs.mkdir(path.join(guiRoot, 'Crabot.app'), { recursive: true })
  const prepared = { installRoot: root, installation_id: id, guiRoot, coreRoot: path.join(root, 'releases', coreId),
    selection: { schema_version: 1, version: '1.2.3', gui_id: guiId, core_id: coreId } }
  const env = { LOCALAPPDATA: path.join(home, 'AppData/Local'), APPDATA: path.join(home, 'AppData/Roaming'), XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share') }
  const shell = { writeShortcutLink(file, operation, value) { assert.ok(['create', 'update'].includes(operation)); writeFileSync(file, JSON.stringify({ ...(operation === 'update' ? JSON.parse(readFileSync(file, 'utf8')) : {}), ...value })); return true }, readShortcutLink(file) { return JSON.parse(readFileSync(file, 'utf8')) } }
  return { root, home, prepared, env, shell }
}
test('user OS locator and macOS application alias are idempotent without changing business files', { skip: windows }, async t => {
  const f = await fixture(t), registered = []
  const options = { ...f, platform: 'darwin', registerMac: async target => { registered.push(target) } }
  await registerInstallationEntries(f.prepared, options); await registerInstallationEntries(f.prepared, options)
  assert.equal(await fs.realpath(path.join(f.home, 'Applications/Crabot.app')), path.join(f.prepared.guiRoot, 'Crabot.app'))
  const locator = await readInstallationLocator(f.home, 'darwin', f.env)
  assert.equal(locator.install_root, f.root); assert.equal(locator.installation_id, f.prepared.installation_id)
  assert.deepEqual(registered, [path.join(f.prepared.guiRoot, 'Crabot.app'), path.join(f.prepared.guiRoot, 'Crabot.app')])
  assert.deepEqual(await fs.readdir(path.join(f.root, 'data')), [])
})
test('Linux menu uses desktop-entry escaping, survives retry and preserves an unrelated entry', async t => {
  const f = await fixture(t), options = { ...f, platform: 'linux' }
  await registerInstallationEntries(f.prepared, options)
  const entry = path.join(f.env.XDG_DATA_HOME, 'applications/crabot.desktop'), original = await fs.readFile(entry, 'utf8')
  assert.ok(original.includes('X-Crabot-Installation=' + f.prepared.installation_id)); assert.ok(original.includes('Terminal=false'))
  await registerInstallationEntries(f.prepared, options); assert.equal(await fs.readFile(entry, 'utf8'), original)
  await fs.writeFile(entry, 'custom application entry')
  await assert.rejects(registerInstallationEntries(f.prepared, options), { code: 'CRABOT_INSTALL_REGISTRATION' })
  assert.equal(await fs.readFile(entry, 'utf8'), 'custom application entry')
  const value = desktopApplicationEntry('/tmp/Crabot "引号" $`%/gui', '/tmp/icon.png', f.prepared.installation_id)
  assert.ok(value.includes('%%')); assert.ok(value.includes('\\\\"')); assert.ok(value.includes('\\\\$')); assert.ok(value.includes('\\\\`'))
  for (const bad of ['newline\nentry', 'null\0entry']) assert.throws(() => desktopApplicationEntry(bad, '/tmp/icon', f.prepared.installation_id))
})
test('a locator for another installation or malformed locator cannot claim a new root', async t => {
  const f = await fixture(t), options = { ...f, platform: 'linux' }
  await registerInstallationEntries(f.prepared, options)
  const file = path.join(integrationRoot(f.home, 'linux', f.env), 'installation.json')
  const original = await fs.readFile(file, 'utf8'), record = JSON.parse(original)
  await fs.writeFile(file, JSON.stringify({ ...record, installation_id: randomUUID() }))
  await assert.rejects(registerInstallationEntries(f.prepared, options), { code: 'CRABOT_INSTALL_REGISTRATION' })
  await fs.writeFile(file, 'broken JSON')
  await assert.rejects(readInstallationLocator(f.home, 'linux', f.env), { code: 'CRABOT_INSTALL_REGISTRATION' })
  assert.deepEqual(await fs.readdir(path.join(f.root, 'data')), [])
})


test('Windows menu registration uses the actual selected executable and preserves a conflicting shortcut', { skip: !windows }, async t => {
  const f = await fixture(t), options = { ...f, platform: 'win32' }
  await registerInstallationEntries(f.prepared, options); await registerInstallationEntries(f.prepared, options)
  assert.deepEqual(uninstallEntries.get(f.prepared.installation_id), { installRoot: f.root,
    executable: path.join(f.prepared.guiRoot, 'Crabot.exe'), version: f.prepared.selection.version })
  const entry = path.join(f.env.APPDATA, 'Microsoft/Windows/Start Menu/Programs/Crabot.lnk')
  const shortcut = JSON.parse(await fs.readFile(entry, 'utf8'))
  assert.equal(shortcut.target, path.join(f.prepared.guiRoot, 'Crabot.exe')); assert.equal(shortcut.appUserModelId, 'com.crabot.desktop')
  await fs.writeFile(entry, JSON.stringify({ ...shortcut, target: 'unrelated executable' }))
  await assert.rejects(registerInstallationEntries(f.prepared, options), { code: 'CRABOT_INSTALL_REGISTRATION' })
  assert.equal(JSON.parse(await fs.readFile(entry, 'utf8')).target, 'unrelated executable')
})


async function pairedPrograms(f, prepared) {
  const resources = path.join(prepared.guiRoot, process.platform === 'darwin' ? 'Crabot.app/Contents/Resources' : 'resources')
  const executable = path.join(prepared.guiRoot, process.platform === 'darwin' ? 'Crabot.app/Contents/MacOS/Crabot' : windows ? 'Crabot.exe' : 'crabot-desktop')
  await fs.mkdir(path.dirname(executable), { recursive: true }); await fs.mkdir(resources, { recursive: true })
  await fs.mkdir(path.join(prepared.guiRoot, 'Crabot.app'), { recursive: true }); await fs.mkdir(prepared.coreRoot, { recursive: true })
  for (const file of new Set([executable, path.join(prepared.guiRoot, 'Crabot.exe'), path.join(prepared.guiRoot, 'crabot-desktop')])) await fs.writeFile(file, 'GUI file fixture, never launched')
  await fs.writeFile(path.join(resources, 'desktop-release.json'), JSON.stringify(prepared.selection))
  await fs.writeFile(path.join(prepared.coreRoot, 'core-release.json'), JSON.stringify({ schema_version: 1, version: prepared.selection.version,
    inventory_sha256: prepared.selection.core_id, platform: process.platform, arch: process.arch }))
}
async function updateFixture(t, platform) {
  const f = await fixture(t)
  await pairedPrograms(f, f.prepared)
  const selector = path.join(f.root, 'current-release.json'), text = JSON.stringify(f.prepared.selection) + '\n'
  if (windows) identity.writePrivateFile(selector, text); else await fs.writeFile(selector, text, { mode: 0o600 })
  const selection = { schema_version: 1, version: '1.2.4', gui_id: randomUUID(), core_id: 'b'.repeat(64) }
  const target = { installRoot: f.root, installation_id: f.prepared.installation_id, selection,
    guiRoot: path.join(f.root, 'app/releases', selection.gui_id), coreRoot: path.join(f.root, 'releases', selection.core_id) }
  await pairedPrograms(f, target)
  const options = { ...f, platform, registerMac: async () => {} }
  await registerInstallationEntries(f.prepared, options)
  return { ...f, target, selector, options }
}
for (const platform of ['darwin', 'win32', 'linux']) {
  test('owned OS entry can move from the recorded source to target and safely retry: ' + platform, { skip: platform === 'darwin' && windows || platform === 'win32' && !windows }, async t => {
    const f = await updateFixture(t, platform)
    const { replaceInstallationEntries } = await import('../dist/installation-entries.js')
    await replaceInstallationEntries(f.prepared, f.target, f.options)
    if (platform === 'win32') assert.deepEqual(uninstallEntries.get(f.prepared.installation_id), { installRoot: f.root, executable: path.join(f.target.guiRoot, 'Crabot.exe'), version: f.target.selection.version })
    await replaceInstallationEntries(f.prepared, f.target, f.options)
    assert.equal(JSON.parse(await fs.readFile(f.selector, 'utf8')).gui_id, f.prepared.selection.gui_id)
    if (platform === 'darwin') assert.equal(await fs.realpath(path.join(f.home, 'Applications/Crabot.app')), path.join(f.target.guiRoot, 'Crabot.app'))
    else if (platform === 'win32') {
      const shortcut = f.shell.readShortcutLink(path.join(f.env.APPDATA, 'Microsoft/Windows/Start Menu/Programs/Crabot.lnk'))
      assert.equal(shortcut.target, path.join(f.target.guiRoot, 'Crabot.exe')); assert.equal(shortcut.cwd, f.target.guiRoot)
    } else assert.equal(await fs.readFile(path.join(f.env.XDG_DATA_HOME, 'applications/crabot.desktop'), 'utf8'),
      desktopApplicationEntry(path.join(f.target.guiRoot, 'crabot-desktop'), path.join(f.target.guiRoot, 'resources/crabot.png'), f.target.installation_id))
    assert.deepEqual(await fs.readdir(path.join(f.root, 'data')), [])
  })
}


test('owned Linux replacement preserves unrelated entry text and a locator conflict', async t => {
  const f = await updateFixture(t, 'linux'), { replaceInstallationEntries } = await import('../dist/installation-entries.js')
  const file = path.join(f.env.XDG_DATA_HOME, 'applications/crabot.desktop'), original = await fs.readFile(file, 'utf8')
  await fs.writeFile(file, 'UNRELATED APPLICATION')
  await assert.rejects(replaceInstallationEntries(f.prepared, f.target, f.options), { code: 'CRABOT_INSTALL_REGISTRATION' })
  assert.equal(await fs.readFile(file, 'utf8'), 'UNRELATED APPLICATION')
  await fs.writeFile(file, original)
  const locator = path.join(integrationRoot(f.home, 'linux', f.env), 'installation.json')
  const value = JSON.parse(await fs.readFile(locator, 'utf8')); value.installation_id = randomUUID()
  await fs.writeFile(locator, JSON.stringify(value))
  await assert.rejects(replaceInstallationEntries(f.prepared, f.target, f.options), { code: 'CRABOT_INSTALL_REGISTRATION' })
  assert.equal(await fs.readFile(file, 'utf8'), original)
})
test('source/target namespaces and actual selected pair must match this installation before entry mutation', async t => {
  const f = await updateFixture(t, 'linux'), { replaceInstallationEntries } = await import('../dist/installation-entries.js')
  const file = path.join(f.env.XDG_DATA_HOME, 'applications/crabot.desktop'), original = await fs.readFile(file, 'utf8')
  for (const patch of [{ installation_id: randomUUID() }, { installRoot: f.home }, { guiRoot: f.home }, { coreRoot: f.home },
    { selection: { ...f.target.selection, gui_id: '../../outside' } }]) {
    await assert.rejects(replaceInstallationEntries(f.prepared, { ...f.target, ...patch }, f.options))
    assert.equal(await fs.readFile(file, 'utf8'), original)
  }
  const selection = { schema_version: 1, version: '1.2.5', gui_id: randomUUID(), core_id: 'c'.repeat(64) }
  const third = { ...f.target, selection, guiRoot: path.join(f.root, 'app/releases', selection.gui_id), coreRoot: path.join(f.root, 'releases', selection.core_id) }
  await pairedPrograms(f, third); writeFileSync(f.selector, JSON.stringify(selection) + '\n')
  await assert.rejects(replaceInstallationEntries(f.prepared, f.target, f.options), { code: 'CRABOT_INSTALL_REGISTRATION' })
  assert.equal(await fs.readFile(file, 'utf8'), original)
})
test('Linux entry replacement can confirm a completed rename after its reply was lost', async t => {
  const f = await updateFixture(t, 'linux'), { replaceInstallationEntries } = await import('../dist/installation-entries.js')
  const file = path.join(f.env.XDG_DATA_HOME, 'applications/crabot.desktop'), rename = fs.rename
  let renames = 0
  const fault = t.mock.method(fs, 'rename', async (from, to) => {
    await rename(from, to)
    if (to === file) { renames++; throw new Error('entry rename reply lost') }
  })
  try { await assert.rejects(replaceInstallationEntries(f.prepared, f.target, f.options), /entry rename reply lost/) }
  finally { fault.mock.restore() }
  await replaceInstallationEntries(f.prepared, f.target, f.options)
  assert.equal(renames, 1)
  assert.ok((await fs.readFile(file, 'utf8')).includes(f.target.selection.gui_id))
})
test('macOS registration failure leaves a recognizable target alias for retry and preserves foreign aliases', { skip: windows }, async t => {
  const f = await updateFixture(t, 'darwin'), { replaceInstallationEntries } = await import('../dist/installation-entries.js')
  const alias = path.join(f.home, 'Applications/Crabot.app')
  await assert.rejects(replaceInstallationEntries(f.prepared, f.target, { ...f.options, registerMac: async () => { throw new Error('registration reply lost') } }), /registration reply lost/)
  assert.equal(await fs.realpath(alias), path.join(f.target.guiRoot, 'Crabot.app'))
  await replaceInstallationEntries(f.prepared, f.target, f.options)
  const other = path.join(f.home, 'Other.app'); await fs.mkdir(other); await fs.unlink(alias); await fs.symlink(other, alias, 'dir')
  await assert.rejects(replaceInstallationEntries(f.prepared, f.target, f.options), { code: 'CRABOT_INSTALL_REGISTRATION' })
  assert.equal(await fs.realpath(alias), other)
})
test('Windows retry recognizes the target after a lost native update reply and rejects extra shortcut arguments', { skip: !windows }, async t => {
  const f = await updateFixture(t, 'win32'), { replaceInstallationEntries } = await import('../dist/installation-entries.js')
  const file = path.join(f.env.APPDATA, 'Microsoft/Windows/Start Menu/Programs/Crabot.lnk')
  const shell = { ...f.shell, writeShortcutLink(...args) { f.shell.writeShortcutLink(...args); return false } }
  await assert.rejects(replaceInstallationEntries(f.prepared, f.target, { ...f.options, shell }), { code: 'CRABOT_INSTALL_REGISTRATION' })
  assert.equal(f.shell.readShortcutLink(file).target, path.join(f.target.guiRoot, 'Crabot.exe'))
  await replaceInstallationEntries(f.prepared, f.target, f.options)
  const value = f.shell.readShortcutLink(file); await fs.writeFile(file, JSON.stringify({ ...value, args: '--unknown' }))
  await assert.rejects(replaceInstallationEntries(f.prepared, f.target, f.options), { code: 'CRABOT_INSTALL_REGISTRATION' })
  assert.equal(f.shell.readShortcutLink(file).args, '--unknown')
})


for (const platform of ['darwin', 'linux', 'win32']) {
  test('a missing owned entry can be rebuilt after the target pair was selected: ' + platform, { skip: platform === 'darwin' && windows || platform === 'win32' && !windows }, async t => {
    const f = await updateFixture(t, platform), { replaceInstallationEntries } = await import('../dist/installation-entries.js')
    const entry = platform === 'darwin' ? path.join(f.home, 'Applications/Crabot.app') : platform === 'linux'
      ? path.join(f.env.XDG_DATA_HOME, 'applications/crabot.desktop') : path.join(f.env.APPDATA, 'Microsoft/Windows/Start Menu/Programs/Crabot.lnk')
    await fs.unlink(entry); writeFileSync(f.selector, JSON.stringify(f.target.selection) + '\n')
    await replaceInstallationEntries(f.prepared, f.target, f.options)
    assert.equal(JSON.parse(await fs.readFile(f.selector, 'utf8')).gui_id, f.target.selection.gui_id)
    assert.equal((await fs.lstat(entry)).isSymbolicLink(), platform === 'darwin')
    assert.deepEqual(await fs.readdir(path.join(f.root, 'data')), [])
  })
}
for (const field of ['guiRoot', 'coreRoot']) {
  test('a redirected target program is refused before replacing the owned menu: ' + field, async t => {
    const f = await updateFixture(t, 'linux'), { replaceInstallationEntries } = await import('../dist/installation-entries.js')
    const file = path.join(f.env.XDG_DATA_HOME, 'applications/crabot.desktop'), original = await fs.readFile(file, 'utf8')
    const retained = path.join(f.home, 'retained-' + field)
    await fs.rename(f.target[field], retained); await fs.symlink(retained, f.target[field], windows ? 'junction' : 'dir')
    await assert.rejects(replaceInstallationEntries(f.prepared, f.target, f.options), { code: 'CRABOT_INSTALL_REGISTRATION' })
    assert.equal(await fs.readFile(file, 'utf8'), original)
    assert.equal((await fs.stat(retained)).isDirectory(), true)
  })
}

test('menu identity comparison distinguishes adjacent file IDs above the JS safe integer range', async t => {
  const f = await updateFixture(t, 'linux'), { replaceInstallationEntries } = await import('../dist/installation-entries.js')
  const file = path.join(f.env.XDG_DATA_HOME, 'applications/crabot.desktop'), original = await fs.readFile(file, 'utf8'), lstat = fs.lstat
  let reads = 0
  const changed = t.mock.method(fs, 'lstat', async (name, ...args) => {
    const stat = await lstat(name, ...args)
    if (name !== file) return stat
    const ino = 2n ** 54n + BigInt(reads++)
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: args[0]?.bigint ? ino : Number(ino) })
  })
  try { await assert.rejects(replaceInstallationEntries(f.prepared, f.target, f.options), { code: 'CRABOT_INSTALL_REGISTRATION' }) }
  finally { changed.mock.restore() }
  assert.equal(await fs.readFile(file, 'utf8'), original)
})

async function removableFixture(t, platform = 'linux') {
  const f = await updateFixture(t, platform)
  await fs.writeFile(path.join(f.root, 'data', 'retained-business'), 'data and dependencies stay')
  const entry = platform === 'darwin' ? path.join(f.home, 'Applications/Crabot.app') : platform === 'linux'
    ? path.join(f.env.XDG_DATA_HOME, 'applications/crabot.desktop') : path.join(f.env.APPDATA, 'Microsoft/Windows/Start Menu/Programs/Crabot.lnk')
  const locator = path.join(integrationRoot(f.home, platform, f.env), 'installation.json')
  let stops = 0
  const options = { ...f.options, verifyStopped: async () => { stops++ }, unregisterMac: async app => {
    assert.equal(app, path.join(f.prepared.guiRoot, 'Crabot.app'))
  } }
  return { ...f, entry, locator, options, stops: () => stops }
}
const removal = async () => (await import('../dist/installation-removal.js')).removeInstallationEntries
for (const platform of ['linux', 'darwin', 'win32']) {
  test('retained-data removal only unlinks owned user entries and can safely repeat: ' + platform,
    { skip: platform === 'darwin' && windows || platform === 'win32' && !windows }, async t => {
      const f = await removableFixture(t, platform), remove = await removal()
      await remove(f.prepared, f.options); await remove(f.prepared, f.options)
      await assert.rejects(fs.lstat(f.entry), { code: 'ENOENT' }); await assert.rejects(fs.lstat(f.locator), { code: 'ENOENT' })
      assert.ok(f.stops() >= 4)
      assert.equal(await fs.readFile(path.join(f.root, 'data', 'retained-business'), 'utf8'), 'data and dependencies stay')
      assert.equal((await fs.stat(f.prepared.coreRoot)).isDirectory(), true)
      assert.equal(JSON.parse(await fs.readFile(f.selector, 'utf8')).gui_id, f.prepared.selection.gui_id)
    })
}
for (const changed of ['menu', 'locator', 'shortcut']) {
  test('uninstall preflight preserves every entry when one has an unknown owner or custom content: ' + changed,
    { skip: changed === 'shortcut' && !windows }, async t => {
      const f = await removableFixture(t, changed === 'shortcut' ? 'win32' : 'linux'), remove = await removal()
      if (changed === 'menu') await fs.writeFile(f.entry, 'user customized desktop entry')
      else if (changed === 'shortcut') {
        const value = f.shell.readShortcutLink(f.entry); await fs.writeFile(f.entry, JSON.stringify({ ...value, args: '--custom' }))
      } else {
        const value = JSON.parse(await fs.readFile(f.locator, 'utf8')); await fs.writeFile(f.locator, JSON.stringify({ ...value, installation_id: randomUUID() }))
      }
      const before = await Promise.all([fs.readFile(f.entry), fs.readFile(f.locator)])
      await assert.rejects(remove(f.prepared, f.options), { code: 'CRABOT_INSTALL_REGISTRATION' })
      assert.deepEqual(await Promise.all([fs.readFile(f.entry), fs.readFile(f.locator)]), before)
    })
}
test('uninstall cannot proceed without the caller proving stopped state or the currently selected pair', async t => {
  const f = await removableFixture(t), remove = await removal(), before = await fs.readFile(f.entry)
  await assert.rejects(remove(f.prepared, { ...f.options, verifyStopped: async () => { throw new Error('still running') } }), /still running/)
  await assert.rejects(remove(f.target, f.options), { code: 'CRABOT_INSTALL_REGISTRATION' })
  assert.deepEqual(await fs.readFile(f.entry), before); assert.ok(await fs.stat(f.locator))
})
test('an entry replaced after preflight is retained and its locator is not removed', async t => {
  const f = await removableFixture(t), remove = await removal()
  let checks = 0
  await assert.rejects(remove(f.prepared, { ...f.options, verifyStopped: async () => {
    if (++checks === 2) { await fs.unlink(f.entry); await fs.writeFile(f.entry, 'replacement must stay') }
  } }), { code: 'CRABOT_INSTALL_REGISTRATION' })
  assert.equal(await fs.readFile(f.entry, 'utf8'), 'replacement must stay'); assert.ok(await fs.stat(f.locator))
})
test('an entry parent redirected outside the user root is refused without deleting its target', async t => {
  const f = await removableFixture(t), remove = await removal(), parent = path.dirname(f.entry), retained = parent + '-retained'
  await fs.rename(parent, retained); await fs.symlink(retained, parent, windows ? 'junction' : 'dir')
  await assert.rejects(remove(f.prepared, f.options), { code: 'CRABOT_INSTALL_REGISTRATION' })
  assert.ok(await fs.stat(path.join(retained, 'crabot.desktop'))); assert.ok(await fs.stat(f.locator))
})
test('a completed unlink whose response was lost leaves the locator and retries only the remaining entries', async t => {
  const f = await removableFixture(t), remove = await removal(), unlink = fs.unlink
  let deletes = 0
  const fault = t.mock.method(fs, 'unlink', async file => {
    await unlink(file)
    if (file === f.entry) { deletes++; throw new Error('unlink reply lost') }
  })
  try { await assert.rejects(remove(f.prepared, f.options), /unlink reply lost/) }
  finally { fault.mock.restore() }
  assert.ok(await fs.stat(f.locator)); await remove(f.prepared, f.options)
  assert.equal(deletes, 1); await assert.rejects(fs.stat(f.locator), { code: 'ENOENT' })
})
test('a failed macOS unregister preserves the menu alias, locator and data for retry', { skip: windows }, async t => {
  const f = await removableFixture(t, 'darwin'), remove = await removal()
  await assert.rejects(remove(f.prepared, { ...f.options, unregisterMac: async () => { throw new Error('unregister reply lost') } }), /unregister reply lost/)
  assert.ok((await fs.lstat(f.entry)).isSymbolicLink()); assert.ok(await fs.stat(f.locator))
  await remove(f.prepared, f.options)
  assert.equal(await fs.readFile(path.join(f.root, 'data', 'retained-business'), 'utf8'), 'data and dependencies stay')
})

test('a foreign locator swapped during its initial read is retained with the menu', async t => {
  const f = await removableFixture(t), remove = await removal(), readFile = fs.readFile
  let swapped = false
  const fault = t.mock.method(fs, 'readFile', async (file, ...args) => {
    const value = await readFile(file, ...args)
    if (file === f.locator && !swapped) {
      swapped = true; const record = JSON.parse(value.toString())
      await fs.writeFile(file, JSON.stringify({ ...record, installation_id: randomUUID() }) + '\n')
    }
    return value
  })
  try { await assert.rejects(remove(f.prepared, f.options), { code: 'CRABOT_INSTALL_REGISTRATION' }) }
  finally { fault.mock.restore() }
  assert.ok(swapped); assert.ok(await fs.stat(f.entry))
  assert.notEqual(JSON.parse(await fs.readFile(f.locator, 'utf8')).installation_id, f.prepared.installation_id)
})
test('a different selection or lost stopped proof after preflight cannot remove an entry', async t => {
  const f = await removableFixture(t), remove = await removal(), original = await fs.readFile(f.entry)
  let checks = 0
  await assert.rejects(remove(f.prepared, { ...f.options, verifyStopped: async () => {
    if (++checks === 2) throw new Error('stop proof changed')
  } }), /stop proof changed/)
  assert.deepEqual(await fs.readFile(f.entry), original); checks = 0
  await assert.rejects(remove(f.prepared, { ...f.options, verifyStopped: async () => {
    if (++checks === 2) writeFileSync(f.selector, JSON.stringify(f.target.selection) + '\n')
  } }), { code: 'CRABOT_INSTALL_REGISTRATION' })
  assert.deepEqual(await fs.readFile(f.entry), original); assert.ok(await fs.stat(f.locator))
})
test('hard-linked menu content is preserved and removal never creates missing directories', async t => {
  const f = await removableFixture(t), remove = await removal(), link = path.join(f.home, 'retained-link')
  await fs.link(f.entry, link)
  await assert.rejects(remove(f.prepared, f.options), { code: 'CRABOT_INSTALL_REGISTRATION' })
  assert.equal((await fs.stat(f.entry)).nlink, 2); assert.ok(await fs.stat(f.locator))
  await fs.unlink(link); await fs.unlink(f.entry); await fs.rmdir(path.dirname(f.entry))
  await remove(f.prepared, f.options)
  await assert.rejects(fs.stat(path.dirname(f.entry)), { code: 'ENOENT' })
})

for (const platform of ['darwin', 'linux', 'win32']) {
  test('retained repair updates a deleted source menu without changing selection or business data: ' + platform,
    { skip: platform === 'darwin' && windows || platform === 'win32' && !windows }, async t => {
      const f = await updateFixture(t, platform), { registerRetainedInstallationEntries } = await import('../dist/installation-entries.js')
      const operationId = randomUUID(), file = path.join(f.root, '.desktop-removal.json')
      const record = { schema_version: 1, installation_id: f.prepared.installation_id, operation_id: operationId,
        source_selection: f.prepared.selection, phase: 'completed', proof_sha256: 'd'.repeat(64) }
      const text = JSON.stringify(record) + '\n'
      if (windows) identity.writePrivateFile(file, text); else await fs.writeFile(file, text, { mode: 0o600 })
      await fs.rm(f.prepared.guiRoot, { recursive: true }); await fs.rm(f.prepared.coreRoot, { recursive: true })
      await fs.unlink(path.join(integrationRoot(f.home, platform, f.env), 'installation.json'))
      await registerRetainedInstallationEntries(f.target, { ...f.options, operationId })
      await registerRetainedInstallationEntries(f.target, { ...f.options, operationId })
      assert.equal(JSON.parse(await fs.readFile(f.selector, 'utf8')).gui_id, f.prepared.selection.gui_id)
      assert.equal(await fs.readFile(file, 'utf8'), text)
      assert.equal((await readInstallationLocator(f.home, platform, f.env)).install_root, f.root)
      if (platform === 'darwin') assert.equal(await fs.realpath(path.join(f.home, 'Applications/Crabot.app')), path.join(f.target.guiRoot, 'Crabot.app'))
      else if (platform === 'win32') assert.equal(f.shell.readShortcutLink(path.join(f.env.APPDATA, 'Microsoft/Windows/Start Menu/Programs/Crabot.lnk')).target, path.join(f.target.guiRoot, 'Crabot.exe'))
      else assert.ok((await fs.readFile(path.join(f.env.XDG_DATA_HOME, 'applications/crabot.desktop'), 'utf8')).includes(f.target.selection.gui_id))
      assert.deepEqual(await fs.readdir(path.join(f.root, 'data')), [])
      await assert.rejects(registerRetainedInstallationEntries(f.target, { ...f.options, operationId: randomUUID() }), { code: 'CRABOT_INSTALL_REGISTRATION' })
    })
}

for (const changed of ['menu', 'locator', 'operation', 'phase', 'selection', 'target']) {
  test('retained entry registration preserves existing entries when admission changes: ' + changed, async t => {
    const f = await updateFixture(t, 'linux'), { registerRetainedInstallationEntries } = await import('../dist/installation-entries.js')
    const operationId = randomUUID(), record = { schema_version: 1, installation_id: f.prepared.installation_id, operation_id: operationId,
      source_selection: f.prepared.selection, phase: changed === 'phase' ? 'stopping' : 'completed', proof_sha256: 'd'.repeat(64) }
    const file = path.join(f.root, '.desktop-removal.json'), text = JSON.stringify(record) + '\n'
    if (windows) identity.writePrivateFile(file, text); else await fs.writeFile(file, text, { mode: 0o600 })
    const entry = path.join(f.env.XDG_DATA_HOME, 'applications/crabot.desktop')
    const locator = path.join(integrationRoot(f.home, 'linux', f.env), 'installation.json')
    if (changed === 'menu') await fs.writeFile(entry, 'custom entry')
    if (changed === 'locator') { const value = JSON.parse(await fs.readFile(locator, 'utf8')); value.installation_id = randomUUID(); await fs.writeFile(locator, JSON.stringify(value)) }
    if (changed === 'selection') { const value = { ...f.target.selection, gui_id: randomUUID() }; await fs.writeFile(f.selector, JSON.stringify(value) + '\n') }
    if (changed === 'target') { await fs.rename(f.target.guiRoot, f.target.guiRoot + '-retained'); await fs.symlink(f.target.guiRoot + '-retained', f.target.guiRoot, windows ? 'junction' : 'dir') }
    const before = await Promise.all([fs.readFile(entry), fs.readFile(locator)])
    await assert.rejects(registerRetainedInstallationEntries(f.target, { ...f.options,
      operationId: changed === 'operation' ? randomUUID() : operationId }), { code: 'CRABOT_INSTALL_REGISTRATION' })
    assert.deepEqual(await Promise.all([fs.readFile(entry), fs.readFile(locator)]), before)
    assert.equal(await fs.readFile(file, 'utf8'), text)
  })
}
