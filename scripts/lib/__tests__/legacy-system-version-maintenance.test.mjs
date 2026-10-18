import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir, userInfo } from 'node:os'
import { randomUUID } from 'node:crypto'
import management from '../desktop-management.cjs'
import { acquireCliLock, releaseCliLock } from '../cli-lock.mjs'
import { writeCoreRelease } from '../core-release.mjs'
import { createMaintenanceBackup, verifyMaintenanceBackup } from '../maintenance-backup.mjs'
import { runBounded } from '../run-bounded.mjs'
import { beginLegacySystemVersionMaintenance, markLegacySystemVersionMaintenanceInstalling, cancelPreparedLegacySystemVersionMaintenance,
  readVersionMaintenance, assertVersionMaintenanceAllowsStart, recordVersionMaintenanceBackup, completeStoppedVersionMaintenance,
  markVersionMaintenanceInstalling, recoverVersionMaintenance } from '../version-maintenance.mjs'

const options = { skip: process.platform === 'win32' }
async function fixture(t, { fails = false } = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-legacy-system-data-')))
  const root = path.join(directory, 'old'), target = path.join(directory, 'new'), dataDir = management.ensurePrivateDataRoot(path.join(directory, 'data'))
  t.after(async () => { releaseCliLock(path.join(dataDir, 'cli.lock')); await fs.rm(directory, { recursive: true, force: true }) })
  await fs.mkdir(root); await fs.mkdir(target)
  await fs.mkdir(path.join(dataDir, 'agent-venv')); await fs.writeFile(path.join(dataDir, 'agent-venv/retained'), 'original base stays in place')
  await fs.mkdir(path.join(dataDir, 'fixture')); await fs.writeFile(path.join(dataDir, 'fixture/content'), 'before'); await fs.writeFile(path.join(dataDir, 'fixture/SCHEMA_VERSION'), 'v1')
  await fs.writeFile(path.join(root, 'retained'), 'old shared source is never moved')
  for (const file of ['package.json', 'product-runtime.json']) await fs.writeFile(path.join(target, file), '{"version":"1.2.4"}')
  const script = path.join(target, 'migration.mjs')
  await fs.writeFile(script, "import fs from 'node:fs';const dir=process.argv[2];fs.appendFileSync(dir+'/fixture/content',' changed');" + (fails ? "process.exit(13)" : "fs.writeFileSync(dir+'/fixture/SCHEMA_VERSION','v2')"))
  await writeCoreRelease(target, { schema_version: 1, version: '1.2.4', platform: process.platform, arch: process.arch, commit: '1'.repeat(40), source_dirty: false })
  const actual = userInfo(), account = { user: actual.username, uid: actual.uid, gid: actual.gid, home: actual.homedir }
  const release = { version: 'v2026.10.15.1', installRoot: root, code_fingerprint: 'a'.repeat(64) }
  const context = { account, release, port_offset_hint: 100 }
  const observed = { user: account.user, uid: account.uid, port_offset: 100, install_root: root,
    code_fingerprint: release.code_fingerprint, manifest_fingerprint: 'b'.repeat(64), data_binding: 'unverified' }
  // Current-UID data protection fixture only. Shared root-code observation and
  // stopped process discovery are explicit observers, never root impersonation.
  const runtimeOptions = { observeAccount: async () => observed, observeProcesses: async (_, use) => use({ state: 'stopped' }, null) }
  const expected = { ...observed, runtime_state: 'running', data_binding: 'observed_running', data_dir: dataDir }
  const params = { dataDir, context, expected, entryFenceId: randomUUID(), operationId: randomUUID(), targetRoot: target, runtimeOptions }
  const begin = () => beginLegacySystemVersionMaintenance(params)
  const backedUp = async () => { const record = await begin(), backup = await createMaintenanceBackup(dataDir); await recordVersionMaintenanceBackup(dataDir, record.id, backup); return { record, backup } }
  const mark = id => markLegacySystemVersionMaintenanceInstalling({ ...params, id })
  const cancel = id => cancelPreparedLegacySystemVersionMaintenance({ ...params, id })
  return { root, target, dataDir, script, observed, expected, params, begin, backedUp, mark, cancel }
}

test('system legacy data has its actual source, root operation and manifest binding; ordinary start and user entry adapters cannot bypass it', options, async t => {
  const f = await fixture(t)
  await assert.rejects(f.begin(), { code: 'CRABOT_MAINTENANCE_PENDING' })
  await acquireCliLock(f.dataDir, 'system-source-fixture')
  const record = await f.begin()
  assert.equal(record.schema_version, 2); assert.equal(record.system_operation_id, f.params.operationId)
  assert.equal(record.source_inventory_sha256, undefined); assert.equal(record.source_version, 'v2026.10.15.1')
  assert.deepEqual(record.legacy_source, { scope: 'system', entry_fence_id: f.params.entryFenceId,
    fingerprint: f.params.context.release.code_fingerprint, manifest_fingerprint: f.expected.manifest_fingerprint })
  assert.throws(() => assertVersionMaintenanceAllowsStart(f.dataDir), error => error.code === 'CRABOT_MAINTENANCE_PENDING' && error.message.includes('system status'))
  await assert.rejects(markVersionMaintenanceInstalling(f.dataDir, record.id))
  await assert.rejects(f.begin())
})

for (const changed of ['missing-data', 'wrong-source', 'wrong-manifest', 'wrong-data', 'no-running-binding', 'live-pid', 'module-pending', 'damaged-target']) {
  test('system source preflight refuses without writing a replacement: ' + changed, options, async t => {
    const f = await fixture(t); await acquireCliLock(f.dataDir, 'system-source-fixture')
    if (changed === 'missing-data') f.params.dataDir = f.dataDir + '-missing'
    if (changed === 'wrong-source') f.observed.code_fingerprint = 'f'.repeat(64)
    if (changed === 'wrong-manifest') f.observed.manifest_fingerprint = 'f'.repeat(64)
    if (changed === 'wrong-data') f.expected.data_dir = f.dataDir + '-other'
    if (changed === 'no-running-binding') f.expected.data_binding = 'unverified'
    if (changed === 'live-pid') await fs.writeFile(path.join(f.dataDir, 'mm.pid'), String(process.pid))
    if (changed === 'module-pending') { await fs.mkdir(path.join(f.dataDir, 'module-runtime-registry/records'), { recursive: true }); await fs.writeFile(path.join(f.dataDir, 'module-runtime-registry/records/pending.json'), '{}') }
    if (changed === 'damaged-target') await fs.appendFile(path.join(f.target, 'package.json'), 'changed')
    await assert.rejects(f.begin())
    assert.equal(readVersionMaintenance(f.dataDir), null)
    await assert.rejects(fs.lstat(f.dataDir + '-missing'), { code: 'ENOENT' })
    assert.equal(await fs.readFile(path.join(f.dataDir, 'fixture/content'), 'utf8'), 'before')
  })
}

test('pre-data cancellation requires the same root operation, entry isolation and source; it neither restores code nor starts a service', options, async t => {
  const f = await fixture(t); await acquireCliLock(f.dataDir, 'system-source-fixture')
  const { record, backup } = await f.backedUp()
  const operation = f.params.operationId; f.params.operationId = randomUUID(); await assert.rejects(f.cancel(record.id)); f.params.operationId = operation
  const fence = f.params.entryFenceId; f.params.entryFenceId = randomUUID(); await assert.rejects(f.cancel(record.id)); f.params.entryFenceId = fence
  assert.deepEqual(await f.cancel(record.id), { preparation_cancelled: true, service_started: false })
  assert.equal(readVersionMaintenance(f.dataDir), null)
  await verifyMaintenanceBackup(backup.directory, backup.sha256)
  assert.equal(await fs.readFile(path.join(f.root, 'retained'), 'utf8'), 'old shared source is never moved')
})

for (const fails of [false, true]) test('system legacy source runs an offline target migration once and retains old dependencies; fails=' + fails, options, async t => {
  const f = await fixture(t, { fails }); await acquireCliLock(f.dataDir, 'system-source-fixture')
  const { record, backup } = await f.backedUp(); await f.mark(record.id)
  const complete = () => completeStoppedVersionMaintenance({ dataDir: f.dataDir, root: f.target, id: record.id,
    migrate: () => runBounded(process.execPath, [f.script, f.dataDir], { timeout: 15000 }),
    verifyComplete: () => assert.equal(readFileSync(path.join(f.dataDir, 'fixture/SCHEMA_VERSION'), 'utf8'), 'v2') })
  if (fails) {
    await assert.rejects(complete()); assert.equal(readVersionMaintenance(f.dataDir).phase, 'verifying')
    await assert.rejects(f.cancel(record.id)); await assert.rejects(f.mark(record.id))
    assert.throws(() => assertVersionMaintenanceAllowsStart(f.dataDir))
  } else { await complete(); assert.equal(readVersionMaintenance(f.dataDir), null) }
  await assert.rejects(complete())
  assert.equal(await fs.readFile(path.join(f.dataDir, 'fixture/content'), 'utf8'), 'before changed')
  assert.equal(await fs.readFile(path.join(backup.directory, 'data/fixture/content'), 'utf8'), 'before')
  assert.equal(await fs.readFile(path.join(f.dataDir, 'agent-venv/retained'), 'utf8'), 'original base stays in place')
  await assert.rejects(fs.lstat(path.join(f.dataDir, 'instance-runtime.json')), { code: 'ENOENT' })
})

test('ordinary desktop recovery never auto-starts a system conversion record', options, async t => {
  const f = await fixture(t), lock = await acquireCliLock(f.dataDir, 'system-source-fixture')
  const { record } = await f.backedUp(); await f.mark(record.id); releaseCliLock(lock)
  await assert.rejects(recoverVersionMaintenance({ dataDir: f.dataDir, root: f.target, appVersion: '1.2.4',
    verifyCompatible: () => assert.fail(), run: () => assert.fail() }))
  assert.equal(readVersionMaintenance(f.dataDir).phase, 'installing')
})

test('system data adapters verify the actual UID before even checking the supplied data path', options, async t => {
  const f = await fixture(t); f.params.context.account.uid++
  const guarded = t.mock.method(management, 'requirePrivateDataRoot', () => assert.fail('no employee path before actual UID match'))
  await assert.rejects(f.begin(), { code: 'CRABOT_MAINTENANCE_PENDING' })
  await assert.rejects(f.mark(randomUUID()), { code: 'CRABOT_MAINTENANCE_PENDING' })
  await assert.rejects(f.cancel(randomUUID()), { code: 'CRABOT_MAINTENANCE_PENDING' })
  guarded.mock.restore(); assert.equal(readVersionMaintenance(f.dataDir), null)
})
