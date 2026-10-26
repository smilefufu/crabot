import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import management from '../desktop-management.cjs'
import { acquireCliLock, releaseCliLock } from '../cli-lock.mjs'
import { createMaintenanceBackup, verifyMaintenanceBackup, assertLocalMigrationData } from '../maintenance-backup.mjs'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'Crabot 维护 '))
  const data = management.ensurePrivateDataRoot(path.join(root, '数据'))
  t.after(async () => {
    // Windows cannot remove the lock file until its OS handle is released.
    releaseCliLock(path.join(data, 'cli.lock'))
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  await fs.mkdir(path.join(data, 'admin')); await fs.mkdir(path.join(data, 'memory'))
  await fs.writeFile(path.join(data, 'admin/provider.json'), '{"provider_id":"preserved"}')
  await fs.writeFile(path.join(data, 'memory/db.sqlite'), Buffer.from([0, 71, 255, 0, 13, 10]))
  return { root, data }
}

test('backup requires the held lifecycle lock, verified stopped state and settled module records', async t => {
  const f = await fixture(t)
  await assert.rejects(createMaintenanceBackup(f.data), { code: 'CRABOT_BACKUP_REQUIRES_STOP' })
  const lock = await acquireCliLock(f.data, 'backup-test'); t.after(() => releaseCliLock(lock))
  await fs.writeFile(path.join(f.data, 'mm.pid'), String(process.pid))
  await assert.rejects(createMaintenanceBackup(f.data), { code: 'CRABOT_BACKUP_REQUIRES_STOP' })
  await fs.rm(path.join(f.data, 'mm.pid'))
  await fs.mkdir(path.join(f.data, 'module-runtime-registry/records'), { recursive: true })
  await fs.writeFile(path.join(f.data, 'module-runtime-registry/records/unsettled.json'), '{}')
  await assert.rejects(createMaintenanceBackup(f.data), { code: 'CRABOT_STOP_UNKNOWN' })
  await assert.rejects(fs.lstat(f.data + '.desktop-backups'), { code: 'ENOENT' })
  assert.equal(await fs.readFile(path.join(f.data, 'admin/provider.json'), 'utf8'), '{"provider_id":"preserved"}')
})

test('a verified snapshot preserves binary data and references without copying workspaces or working environments', async t => {
  const f = await fixture(t)
  for (const name of ['workspaces', 'agent-venv', 'agent-environments', 'agent-tools', 'runtime-bases', 'mcp-envs', 'runtime-cache', 'logs', 'desktop-profile', 'system-control']) {
    await fs.mkdir(path.join(f.data, name)); await fs.writeFile(path.join(f.data, name, 'keep'), 'preserve-in-place')
  }
  if (process.platform !== 'win32') {
    await fs.writeFile(path.join(f.root, 'external'), 'not part of data rollback')
    await fs.symlink('../../external', path.join(f.data, 'admin/external-reference'))
  }
  const lock = await acquireCliLock(f.data, 'backup-test'); t.after(() => releaseCliLock(lock))
  const result = await createMaintenanceBackup(f.data)
  const manifest = await verifyMaintenanceBackup(result.directory, result.sha256)
  assert.equal(manifest.source, f.data)
  assert.deepEqual(await fs.readFile(path.join(result.directory, 'data/memory/db.sqlite')), Buffer.from([0, 71, 255, 0, 13, 10]))
  assert.equal(await fs.readFile(path.join(result.directory, 'data/admin/provider.json'), 'utf8'), '{"provider_id":"preserved"}')
  for (const name of ['workspaces', 'agent-venv', 'agent-environments', 'agent-tools', 'runtime-bases', 'mcp-envs', 'runtime-cache', 'logs', 'desktop-profile', 'system-control']) {
    assert.ok(result.excluded.includes(name))
    await assert.rejects(fs.lstat(path.join(result.directory, 'data', name)), { code: 'ENOENT' })
    assert.equal(await fs.readFile(path.join(f.data, name, 'keep'), 'utf8'), 'preserve-in-place')
  }
  if (process.platform !== 'win32') {
    assert.deepEqual(result.references, ['admin/external-reference'])
    await assert.rejects(fs.lstat(path.join(result.directory, 'data/admin/external-reference')), { code: 'ENOENT' })
    assert.equal(await fs.readFile(path.join(f.root, 'external'), 'utf8'), 'not part of data rollback')
  }
  await fs.writeFile(path.join(result.directory, 'data/admin/provider.json'), 'corrupted')
  await assert.rejects(verifyMaintenanceBackup(result.directory, result.sha256), { code: 'CRABOT_BACKUP_INVALID' })
  assert.equal(await fs.readFile(path.join(f.data, 'admin/provider.json'), 'utf8'), '{"provider_id":"preserved"}')
})

test('cancelled maintenance creates no snapshot and changes no source files', async t => {
  const f = await fixture(t), abort = new AbortController(); abort.abort()
  await assert.rejects(createMaintenanceBackup(f.data, { signal: abort.signal }), { code: 'CRABOT_MAINTENANCE_CANCELLED' })
  await assert.rejects(fs.lstat(f.data + '.desktop-backups'), { code: 'ENOENT' })
  assert.equal(await fs.readFile(path.join(f.data, 'admin/provider.json'), 'utf8'), '{"provider_id":"preserved"}')
})

for (const interruption of ['concurrent write', 'cancel']) test('an interrupted backup is never published: ' + interruption, async t => {
  const f = await fixture(t), abort = new AbortController()
  const lock = await acquireCliLock(f.data, 'backup-test'); t.after(() => releaseCliLock(lock))
  const open = fs.open
  let changed = false
  t.mock.method(fs, 'open', async (...args) => {
    if (!changed && String(args[0]).includes('.preparing-') && String(args[0]).endsWith('provider.json')) {
      changed = true
      if (interruption === 'cancel') abort.abort()
      else await fs.writeFile(path.join(f.data, 'admin/provider.json'), 'external edit must survive')
    }
    return open(...args)
  })
  await assert.rejects(createMaintenanceBackup(f.data, { signal: abort.signal }), {
    code: interruption === 'cancel' ? 'CRABOT_MAINTENANCE_CANCELLED' : 'CRABOT_BACKUP_CHANGED',
  })
  assert.equal(changed, true)
  assert.deepEqual(await fs.readdir(f.data + '.desktop-backups'), [])
  assert.equal(await fs.readFile(path.join(f.data, 'admin/provider.json'), 'utf8'),
    interruption === 'cancel' ? '{"provider_id":"preserved"}' : 'external edit must survive')
})


test('migration coverage requires the lifecycle lock only when data needs migration', async t => {
  const f = await fixture(t), pending = [await declaredMigration(f, 'admin', ['admin/provider.json'])]
  await assertLocalMigrationData(f.data, [])
  await assert.rejects(assertLocalMigrationData(f.data, pending, f.root), { code: 'CRABOT_BACKUP_REQUIRES_STOP' })
  const lock = await acquireCliLock(f.data, 'coverage-test'); t.after(() => releaseCliLock(lock))
  await assertLocalMigrationData(f.data, pending, f.root)
  await fs.writeFile(path.join(f.data, 'mm.pid'), String(process.pid))
  await assert.rejects(assertLocalMigrationData(f.data, pending, f.root), { code: 'CRABOT_BACKUP_REQUIRES_STOP' })
})

for (const kind of ['directory reference', 'hard-linked file']) test('migration never writes unbacked data through ' + kind, async t => {
  const f = await fixture(t), external = path.join(f.root, 'external')
  await fs.mkdir(external); await fs.writeFile(path.join(external, 'keep'), 'original')
  if (kind === 'directory reference') await fs.symlink(external, path.join(f.data, 'admin/reference'), process.platform === 'win32' ? 'junction' : 'dir')
  else await fs.link(path.join(external, 'keep'), path.join(f.data, 'admin/reference'))
  const lock = await acquireCliLock(f.data, 'coverage-test'); t.after(() => releaseCliLock(lock))
  await assert.rejects(assertLocalMigrationData(f.data, [await declaredMigration(f, 'admin', ['admin/reference'])], f.root), { code: 'CRABOT_BACKUP_SCOPE_UNVERIFIED' })
  await assertLocalMigrationData(f.data, [await declaredMigration(f, 'memory', ['memory/db.sqlite'])], f.root)
  assert.equal(await fs.readFile(path.join(external, 'keep'), 'utf8'), 'original')
})

async function declaredMigration(fixture, module, writes) {
  const upgrade = path.join(fixture.root, 'crabot-' + module, 'upgrade')
  await fs.mkdir(upgrade, { recursive: true })
  await fs.writeFile(path.join(upgrade, 'scope.mjs'), 'export const migrationScope = () => (' + JSON.stringify({ reads: [], writes }) + ')\n')
  await fs.writeFile(path.join(upgrade, 'from_v0_to_v1.mjs'), '')
  return { moduleId: 'crabot-' + module, dataDir: path.join(fixture.data, module), dataVersion: null, codeVersion: 'v1' }
}

test('migration coverage ignores unrelated historical references and inspects only the declared write scope', async t => {
  const f = await fixture(t), external = path.join(f.root, 'external')
  await fs.mkdir(external); await fs.writeFile(path.join(external, 'keep'), 'must stay outside migration')
  await fs.symlink(external, path.join(f.data, 'admin/old-history-reference'), process.platform === 'win32' ? 'junction' : 'dir')
  const migration = await declaredMigration(f, 'admin', ['admin/provider.json'])
  const lock = await acquireCliLock(f.data, 'scoped-coverage'); t.after(() => releaseCliLock(lock))
  await assertLocalMigrationData(f.data, [migration], f.root)
  assert.equal(await fs.readFile(path.join(external, 'keep'), 'utf8'), 'must stay outside migration')
})

test('an exact conversion manifest scope never enters unrelated modules or copies their data', async t => {
  const f = await fixture(t), relative = 'system-conversion/known-operation/legacy-instance.json'
  await fs.mkdir(path.dirname(path.join(f.data, relative)), { recursive: true })
  await fs.writeFile(path.join(f.data, relative), '{"mode":"system"}')
  const lock = await acquireCliLock(f.data, 'conversion-scope-test'); t.after(() => releaseCliLock(lock))
  const readdir = fs.readdir.bind(fs)
  t.mock.method(fs, 'readdir', async (directory, ...args) => {
    assert.equal(['admin', 'memory'].some(name => String(directory) === path.join(f.data, name)), false, 'Unrelated modules are outside this backup')
    return readdir(directory, ...args)
  })
  const result = await createMaintenanceBackup(f.data, { scope: [relative] })
  const manifest = await verifyMaintenanceBackup(result.directory, result.sha256)
  assert.equal(result.bytes, Buffer.byteLength('{"mode":"system"}'))
  assert.deepEqual(manifest.scope, [relative])
  assert.equal(await fs.readFile(path.join(result.directory, 'data', relative), 'utf8'), '{"mode":"system"}')
  await assert.rejects(fs.lstat(path.join(result.directory, 'data/admin')), { code: 'ENOENT' })
})

for (const scope of [[], ['../outside'], ['admin'], ['agent-venv/keep']]) test('exact conversion backup rejects an unsafe or whole-module scope: ' + JSON.stringify(scope), async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.data, 'conversion-scope-test'); t.after(() => releaseCliLock(lock))
  await assert.rejects(createMaintenanceBackup(f.data, { scope }))
  await assert.rejects(fs.lstat(f.data + '.desktop-backups'), { code: 'ENOENT' })
})
