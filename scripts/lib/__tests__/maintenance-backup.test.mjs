import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import management from '../desktop-management.cjs'
import { acquireCliLock, releaseCliLock } from '../cli-lock.mjs'
import { createMaintenanceBackup, verifyMaintenanceBackup } from '../maintenance-backup.mjs'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'Crabot 维护 '))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const data = management.ensurePrivateDataRoot(path.join(root, '数据'))
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
  for (const name of ['workspaces', 'agent-venv', 'runtime-bases', 'mcp-envs', 'runtime-cache', 'logs', 'desktop-profile']) {
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
  for (const name of ['workspaces', 'agent-venv', 'runtime-bases', 'mcp-envs', 'runtime-cache', 'logs', 'desktop-profile']) {
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
