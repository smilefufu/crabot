import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs, writeFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { desktopApplicationEntry, integrationRoot, readInstallationLocator, registerInstallationEntries } from '../dist/installation-entries.js'
import identity from '../../scripts/lib/process-identity.cjs'
import management from '../../scripts/lib/desktop-management.cjs'
const windows = process.platform === 'win32'
async function fixture(t) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'Crabot 系统入口 ')))
  t.after(() => fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const root = management.ensurePrivateDataRoot(path.join(parent, '安装')), home = management.ensurePrivateDataRoot(path.join(parent, '用户'))
  for (const name of ['app/releases', 'releases', 'bin']) await fs.mkdir(path.join(root, name), { recursive: true })
  management.ensurePrivateDataRoot(path.join(root, 'data'))
  const stat = await fs.lstat(root, { bigint: true }), id = randomUUID(), guiId = randomUUID(), coreId = 'a'.repeat(64)
  const record = { schema_version: 1, installation_id: id, owner: identity.inspectProcess(process.pid).owner,
    install_root: root, root_identity: { dev: String(stat.dev), ino: String(stat.ino) }, paths: { app: 'app/releases', core: 'releases', data: 'data', bin: 'bin' } }
  const text = JSON.stringify(record) + '\n', file = path.join(root, 'desktop-installation.json')
  if (windows) identity.writePrivateFile(file, text); else await fs.writeFile(file, text, { mode: 0o600 })
  const guiRoot = path.join(root, 'app/releases', guiId)
  await fs.mkdir(path.join(guiRoot, 'Crabot.app'), { recursive: true })
  const prepared = { installRoot: root, installation_id: id, guiRoot, coreRoot: path.join(root, 'releases', coreId),
    selection: { schema_version: 1, version: '1.2.3', gui_id: guiId, core_id: coreId } }
  const env = { LOCALAPPDATA: path.join(home, 'AppData/Local'), APPDATA: path.join(home, 'AppData/Roaming'), XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share') }
  const shell = { writeShortcutLink(file, operation, value) { assert.equal(operation, 'create'); writeFileSync(file, JSON.stringify(value)); return true }, readShortcutLink(file) { return JSON.parse(readFileSync(file, 'utf8')) } }
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
  const entry = path.join(f.env.APPDATA, 'Microsoft/Windows/Start Menu/Programs/Crabot.lnk')
  const shortcut = JSON.parse(await fs.readFile(entry, 'utf8'))
  assert.equal(shortcut.target, path.join(f.prepared.guiRoot, 'Crabot.exe')); assert.equal(shortcut.appUserModelId, 'com.crabot.desktop')
  await fs.writeFile(entry, JSON.stringify({ ...shortcut, target: 'unrelated executable' }))
  await assert.rejects(registerInstallationEntries(f.prepared, options), { code: 'CRABOT_INSTALL_REGISTRATION' })
  assert.equal(JSON.parse(await fs.readFile(entry, 'utf8')).target, 'unrelated executable')
})
