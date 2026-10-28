import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import identity from '../../scripts/lib/process-identity.cjs'
import management from '../../scripts/lib/desktop-management.cjs'
import { LoginStartupUpdateStore } from '../dist/login-startup-update.js'

async function fixture(t) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'Crabot login update ')))
  t.after(() => fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const root = management.ensurePrivateDataRoot(path.join(parent, 'installation'))
  for (const name of ['app/releases', 'releases', 'bin']) await fs.mkdir(path.join(root, name), { recursive: true })
  management.ensurePrivateDataRoot(path.join(root, 'data'))
  const privateText = async (file, text) => process.platform === 'win32' ? identity.writePrivateFile(file, text) : fs.writeFile(file, text, { mode: 0o600 })
  const stat = await fs.lstat(root, { bigint: true }), installation_id = randomUUID(), maintenance_id = randomUUID()
  await privateText(path.join(root, 'desktop-installation.json'), JSON.stringify({ schema_version: 1, installation_id,
    owner: identity.inspectProcess(process.pid).owner, install_root: root, root_identity: { dev: String(stat.dev), ino: String(stat.ino) },
    paths: { app: 'app/releases', core: 'releases', data: 'data', bin: 'bin' } }) + '\n')
  const source = { schema_version: 1, version: '1.2.2', gui_id: randomUUID(), core_id: 'a'.repeat(64) }
  const target = { schema_version: 1, version: '1.2.3', gui_id: randomUUID(), core_id: 'b'.repeat(64) }
  for (const pair of [source, target]) {
    const gui = path.join(root, 'app/releases', pair.gui_id), core = path.join(root, 'releases', pair.core_id)
    const resources = path.join(gui, process.platform === 'darwin' ? 'Crabot.app/Contents/Resources' : 'resources')
    const executable = path.join(gui, process.platform === 'darwin' ? 'Crabot.app/Contents/MacOS/Crabot' : process.platform === 'win32' ? 'Crabot.exe' : 'crabot-desktop')
    await fs.mkdir(resources, { recursive: true }); await fs.mkdir(path.dirname(executable), { recursive: true }); await fs.mkdir(core)
    await fs.writeFile(executable, 'finite fixture, never executed')
    await fs.writeFile(path.join(resources, 'desktop-release.json'), JSON.stringify(pair))
    await fs.writeFile(path.join(core, 'core-release.json'), JSON.stringify({ schema_version: 1, version: pair.version,
      inventory_sha256: pair.core_id, platform: process.platform, arch: process.arch }))
  }
  const select = async pair => {
    const file = path.join(root, 'current-release.json'), temporary = file + '.tmp-' + randomUUID()
    await privateText(temporary, JSON.stringify(pair) + '\n')
    await fs.rename(temporary, file)
  }
  await select(source)
  let authorized = true
  const context = { installRoot: root, installation_id, maintenance_id, source, target }
  const store = new LoginStartupUpdateStore(context, () => { if (!authorized) throw new Error('Current maintenance changed') })
  const file = path.join(root, 'app/updates', maintenance_id, 'login-startup.json')
  return { root, context, store, file, select, target, revoke: () => { authorized = false } }
}

for (const intent of ['off', 'on', 'approval_required']) test('a private bound intent survives reopening and is consumed once: ' + intent, async t => {
  const f = await fixture(t)
  await f.store.capture(intent); await f.store.capture(intent)
  await assert.rejects(f.store.read()) // The source must not consume target intent.
  await f.select(f.target)
  const reopened = new LoginStartupUpdateStore(f.context, () => {})
  const record = await reopened.read()
  assert.equal(record.intent, intent); assert.equal(record.phase, 'pending')
  await assert.rejects(reopened.consume(JSON.parse(JSON.stringify(record))))
  await reopened.consume(record)
  assert.equal((await reopened.read()).phase, 'consumed')
  assert.equal((await fs.readdir(path.dirname(f.file))).length, 1)
})

test('an old operation without an intent stays absent and no other job is scanned', async t => {
  const f = await fixture(t); await f.store.capture('on'); await f.select(f.target)
  const other = new LoginStartupUpdateStore({ ...f.context, maintenance_id: randomUUID() }, () => {})
  assert.equal(await other.read(), null)
  assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).phase, 'pending')
})

for (const change of ['installation', 'source', 'target', 'unknown', 'duplicate', 'large', 'hardlink', 'permissions']) test('invalid intent bytes or identity remain untouched: ' + change, async t => {
  if (change === 'permissions' && process.platform === 'win32') { t.skip('POSIX mode case; Windows private ACL is enforced by Native'); return }
  const f = await fixture(t); await f.store.capture('on'); await f.select(f.target)
  const record = JSON.parse(await fs.readFile(f.file, 'utf8'))
  if (change === 'installation') record.installation_id = randomUUID()
  if (change === 'source') record.source.core_id = 'c'.repeat(64)
  if (change === 'target') record.target.gui_id = randomUUID()
  if (change === 'unknown') record.command = 'never execute'
  if (['installation', 'source', 'target', 'unknown'].includes(change)) await fs.writeFile(f.file, JSON.stringify(record) + '\n')
  if (change === 'duplicate') await fs.writeFile(f.file, (await fs.readFile(f.file, 'utf8')).replace('"intent":"on"', '"intent":"off","intent":"on"'))
  if (change === 'large') await fs.writeFile(f.file, ' '.repeat(5000))
  if (change === 'hardlink') await fs.link(f.file, f.file + '.alias')
  if (change === 'permissions') await fs.chmod(f.file, 0o644)
  const bytes = await fs.readFile(f.file)
  await assert.rejects(f.store.read())
  assert.deepEqual(await fs.readFile(f.file), bytes)
})

test('changed bytes and revoked current authority cannot be consumed', async t => {
  const f = await fixture(t); await f.store.capture('on'); await f.select(f.target)
  const record = await f.store.read()
  await fs.writeFile(f.file, (await fs.readFile(f.file, 'utf8')).replace('"intent":"on"', '"intent":"off"'))
  await assert.rejects(f.store.consume(record))
  assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).phase, 'pending')
  f.revoke(); await assert.rejects(f.store.read(), /Current maintenance changed/)
})
