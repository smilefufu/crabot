import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { SystemRegistry } from '../system-registry.mjs'
import { acquireCliLock, releaseCliLock } from '../cli-lock.mjs'
import { readSystemBootId } from '../system-context.mjs'
const options = { skip: process.platform === 'win32' }
async function fixture(t, { lock = true } = {}) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'crabot-converted-registration-')))
  let held
  t.after(() => { releaseCliLock(held); fs.rmSync(parent, { recursive: true, force: true }) })
  const account = { user: 'alice', uid: 1001, gid: 1001, home: '/home/alice' }
  const registry = new SystemRegistry({ directory: path.join(parent, 'system'), ownerUid: process.getuid(), accountLookup: () => account })
  await registry.update(() => [], { create: true })
  fs.mkdirSync(path.join(registry.directory, 'jobs'), { mode: 0o700 })
  const entry = { ...account, data_dir: path.join(parent, 'employee-data-never-read'), port_offset: 700, enabled: true, autostart: false }
  const id = randomUUID(), boot = readSystemBootId(), fence = randomUUID()
  const row = { uid: entry.uid, stopped: true, migration_dispatched: true, migrated: true, registration_dispatched: true,
    snapshot: { id: randomUUID(), system_operation_id: id, backup: { id: randomUUID(), sha256: 'a'.repeat(64) }, target_id: 'b'.repeat(64) } }
  const job = { schema_version: 1, phase: 'running', boot_id: boot,
    plan: { schema_version: 1, kind: 'conversion', id, instances: [{ entry }], target: { id: 'b'.repeat(64) } },
    progress: { schema_version: 1, id, phase: 'running', stage: 'registration_dispatched', current_uid: entry.uid, source_fence_id: fence, results: [row] } }
  const maintenance = { schema_version: 1, id, operation: 'conversion', phase: 'running', boot_id: boot, stage: 'registration_dispatched', current_uid: entry.uid, targets: [entry.uid], unsettled: [] }
  const privateFile = path.join(registry.directory, 'jobs', id + '.json'), publicFile = path.join(registry.directory, 'maintenance.json')
  const write = () => {
    fs.writeFileSync(privateFile, JSON.stringify(job), { mode: 0o600 }); fs.chmodSync(privateFile, 0o600)
    fs.writeFileSync(publicFile, JSON.stringify(maintenance), { mode: 0o644 }); fs.chmodSync(publicFile, 0o644)
  }
  write()
  if (lock) held = await acquireCliLock(registry.directory, 'system-conversion-job')
  return { registry, account, entry, id, job, maintenance, write, held, register: () => registry.registerConverted(entry, { operationId: id }) }
}

test('converted registration preserves the exact old binding without opening employee data or reinitializing credentials', options, async t => {
  const f = await fixture(t), read = fs.readFileSync, stat = fs.lstatSync
  const guard = file => { if (typeof file === 'string' && file.startsWith(f.entry.data_dir)) assert.fail('administrator metadata registration cannot read employee state') }
  t.mock.method(fs, 'readFileSync', (file, ...args) => { guard(file); return read(file, ...args) })
  t.mock.method(fs, 'lstatSync', (file, ...args) => { guard(file); return stat(file, ...args) })
  assert.deepEqual(await f.register(), f.entry)
  assert.deepEqual(f.registry.read(), [f.entry]); assert.equal(fs.existsSync(f.entry.data_dir), false)
  assert.deepEqual(await f.register(), f.entry, 'exact known metadata publication is idempotent')
})

for (const changed of ['no-lock', 'wrong-operation', 'old-boot', 'public-stage', 'private-stage', 'missing-migration', 'unknown-snapshot', 'changed-account', 'string-flag', 'invalid-backup', 'public-boot', 'private-id', 'missing-fence', 'early-start-permit']) {
  test('converted registration rejects incomplete root authority before writing a binding: ' + changed, options, async t => {
    const f = await fixture(t, { lock: changed !== 'no-lock' })
    if (changed === 'wrong-operation') f.maintenance.id = randomUUID()
    if (changed === 'old-boot') f.job.boot_id = 'different-boot'
    if (changed === 'public-stage') f.maintenance.stage = 'migration_dispatched'
    if (changed === 'private-stage') f.job.progress.stage = 'migration_completed'
    if (changed === 'missing-migration') f.job.progress.results[0].migrated = false
    if (changed === 'unknown-snapshot') f.job.progress.results[0].snapshot.system_operation_id = randomUUID()
    if (changed === 'string-flag') f.job.progress.results[0].migrated = 'true'
    if (changed === 'invalid-backup') f.job.progress.results[0].snapshot.backup.sha256 = 'invalid'
    if (changed === 'public-boot') f.maintenance.boot_id = 'different-boot'
    if (changed === 'private-id') f.job.progress.id = randomUUID()
    if (changed === 'missing-fence') delete f.job.progress.source_fence_id
    if (changed === 'early-start-permit') f.job.progress.allow_start = { uid: f.entry.uid, core_id: 'b'.repeat(64) }
    if (changed === 'changed-account') f.account.uid++
    f.write()
    await assert.rejects(f.register())
    assert.deepEqual(f.registry.read(), [])
  })
}

test('a previously published different binding is never overwritten by conversion recovery', options, async t => {
  const f = await fixture(t)
  fs.writeFileSync(path.join(f.registry.directory, 'instances.json'), JSON.stringify({ schema_version: 1, instances: [{ ...f.entry, port_offset: 800 }] }))
  await assert.rejects(f.register())
  assert.equal(f.registry.read()[0].port_offset, 800)
})
