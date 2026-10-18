import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs, constants, readFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import management from '../desktop-management.cjs'
import { acquireCliLock, releaseCliLock } from '../cli-lock.mjs'
import { materializeLegacyRelease } from './fixtures/legacy-release.mjs'
import { discoverLegacyUserInstall } from '../legacy-desktop.mjs'
import { fenceLegacyEntries, inspectLegacyEntryFence, restoreLegacyEntries } from '../legacy-entry-fence.mjs'
import { writeCoreRelease } from '../core-release.mjs'
import { createMaintenanceBackup, verifyMaintenanceBackup } from '../maintenance-backup.mjs'
import { prepareCoreEnvironment, applyStartupMigrations, verifyDataCompatibility } from '../core-preparation.mjs'
import { beginLegacyUserVersionMaintenance, cancelPreparedLegacyUserVersionMaintenance,
  assertVersionMaintenanceAllowsStart, readVersionMaintenance, recordVersionMaintenanceBackup,
  markVersionMaintenanceInstalling, recoverVersionMaintenance, completeStoppedVersionMaintenance } from '../version-maintenance.mjs'

async function fixture(t, { fence = true, fail = false } = {}) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'Crabot old data maintenance ')))
  const root = path.join(parent, 'old'), target = path.join(parent, 'new'), data = management.ensurePrivateDataRoot(path.join(parent, 'data'))
  t.after(async () => { releaseCliLock(path.join(data, 'cli.lock')); await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
  await fs.mkdir(root); await materializeLegacyRelease(root)
  await fs.mkdir(path.join(data, 'fixture')); await fs.writeFile(path.join(data, 'fixture/SCHEMA_VERSION'), 'v1'); await fs.writeFile(path.join(data, 'fixture/content'), 'before')
  await fs.mkdir(path.join(data, 'agent-venv')); await fs.writeFile(path.join(data, 'agent-venv/keep'), 'old Python unchanged')
  const installation = await discoverLegacyUserInstall({ root, dataDir: data })
  const entry = fence ? await fenceLegacyEntries(installation) : { id: randomUUID() }
  const node = path.join(target, 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
  await fs.mkdir(path.dirname(node), { recursive: true }); await fs.copyFile(process.execPath, node, constants.COPYFILE_FICLONE); await fs.chmod(node, 0o755)
  await fs.writeFile(path.join(target, 'package.json'), '{"version":"1.2.4"}')
  await fs.writeFile(path.join(target, 'product-runtime.json'), JSON.stringify({ schema_version: 1, version: '1.2.4', platform: process.platform, arch: process.arch,
    versions: { node: process.versions.node, python: '3.12.12' }, executables: Object.fromEntries(['node', 'python', 'uv', 'bash', 'git', 'rg'].map(name => [name, path.relative(target, node).split(path.sep).join('/')])),
    path_entries: ['bin'], python_home: 'bin', memory_packages: 'bin', seed_wheels: [],
    files: { [path.relative(target, node).split(path.sep).join('/')]: { size: (await fs.stat(node)).size, sha256: createHash('sha256').update(readFileSync(node)).digest('hex') } } }))
  await fs.mkdir(path.join(target, 'crabot-fixture/upgrade'), { recursive: true })
  await fs.writeFile(path.join(target, 'crabot-fixture/schema_version'), 'v2')
  await fs.writeFile(path.join(target, 'crabot-fixture/upgrade/from_v1_to_v2.mjs'),
    "import{appendFileSync}from'node:fs';const dir=process.argv.find(a=>a.startsWith('--data-dir=')).slice(11);appendFileSync(dir+'/content',' changed');process.exit(" + (fail ? '13' : '0') + ");")
  await writeCoreRelease(target, { schema_version: 1, version: '1.2.4', platform: process.platform, arch: process.arch, commit: '1'.repeat(40), source_dirty: false })
  const options = { dataDir: data, installation, entryFenceId: entry.id, targetRoot: target }
  const begin = () => beginLegacyUserVersionMaintenance(options)
  async function backedUp() {
    const record = await begin(), backup = await createMaintenanceBackup(data)
    await recordVersionMaintenanceBackup(data, record.id, backup)
    return { record, backup }
  }
  return { root, target, data, installation, options, begin, backedUp }
}

test('legacy source has a distinct record and blocks ordinary preparation before any schema write', async t => {
  const f = await fixture(t)
  await assert.rejects(f.begin(), { code: 'CRABOT_MAINTENANCE_PENDING' })
  await acquireCliLock(f.data, 'legacy-maintenance-test')
  const record = await f.begin()
  assert.equal(record.schema_version, 2); assert.equal(record.source_version, 'v2026.10.15.1')
  assert.equal(record.source_inventory_sha256, undefined)
  assert.deepEqual(record.legacy_source, { scope: 'user', entry_fence_id: f.options.entryFenceId, fingerprint: f.installation.fingerprint })
  assert.equal(record.target_core.root, f.target)
  assert.throws(() => prepareCoreEnvironment({ root: f.target, dataDir: f.data }), { code: 'CRABOT_MAINTENANCE_PENDING' })
  await assert.rejects(f.begin(), { code: 'CRABOT_MAINTENANCE_PENDING' })
  assert.equal(await fs.readFile(path.join(f.data, 'fixture/content'), 'utf8'), 'before')
})

for (const changed of ['unfenced', 'wrong-fence', 'wrong-source', 'damaged-target', 'new-instance', 'missing-data', 'source-checkout']) {
  test('legacy data protection refuses unverified preparation: ' + changed, async t => {
    const f = await fixture(t, { fence: changed !== 'unfenced' })
    await acquireCliLock(f.data, 'legacy-maintenance-test')
    if (changed === 'wrong-fence') f.options.entryFenceId = randomUUID()
    if (changed === 'wrong-source') f.options.installation = { ...f.installation, fingerprint: 'a'.repeat(64) }
    if (changed === 'damaged-target') await fs.appendFile(path.join(f.target, 'package.json'), 'changed')
    if (changed === 'new-instance') await fs.writeFile(path.join(f.data, 'mm.pid'), String(process.pid))
    if (changed === 'source-checkout') await fs.mkdir(path.join(f.root, '.git'))
    if (changed === 'missing-data') f.options.dataDir = f.data + '-missing'
    await assert.rejects(f.begin())
    assert.equal(readVersionMaintenance(f.data), null)
    await assert.rejects(fs.lstat(path.join(f.data + '-missing', 'desktop-maintenance.json')), { code: 'ENOENT' })
    assert.equal(await fs.readFile(path.join(f.data, 'fixture/content'), 'utf8'), 'before')
  })
}

test('legacy preparation cancellation verifies source and backup; it does not restore entries or start business', async t => {
  const f = await fixture(t); await acquireCliLock(f.data, 'legacy-maintenance-test')
  const { record, backup } = await f.backedUp()
  await assert.rejects(cancelPreparedLegacyUserVersionMaintenance({ dataDir: f.data, id: randomUUID() }))
  assert.deepEqual(await cancelPreparedLegacyUserVersionMaintenance({ dataDir: f.data, id: record.id }), { preparation_cancelled: true, service_started: false })
  assert.equal(readVersionMaintenance(f.data), null)
  assert.equal((await inspectLegacyEntryFence(f.root)).phase, 'fenced')
  await verifyMaintenanceBackup(backup.directory, backup.sha256)
  await restoreLegacyEntries(f.root)
  assert.equal(await fs.readFile(path.join(f.data, 'fixture/content'), 'utf8'), 'before')
})

for (const fail of [false, true]) test('legacy source migrates only once offline, retaining its old environment; failure=' + fail, async t => {
  const f = await fixture(t, { fail }); await acquireCliLock(f.data, 'legacy-maintenance-test')
  const { record, backup } = await f.backedUp()
  await markVersionMaintenanceInstalling(f.data, record.id)
  assert.equal((await inspectLegacyEntryFence(f.root)).phase, 'data_changing')
  await assert.rejects(restoreLegacyEntries(f.root))
  const complete = () => completeStoppedVersionMaintenance({ dataDir: f.data, root: f.target, id: record.id,
    migrate: () => applyStartupMigrations(f.target, f.data, { DATA_DIR: f.data }), verifyComplete: () => assert.equal(verifyDataCompatibility(f.target, f.data).length, 0) })
  if (fail) {
    await assert.rejects(complete(), { code: 'CRABOT_MIGRATION_FAILED' })
    assert.equal(readVersionMaintenance(f.data).phase, 'verifying')
    await assert.rejects(cancelPreparedLegacyUserVersionMaintenance({ dataDir: f.data, id: record.id }))
    assert.throws(() => assertVersionMaintenanceAllowsStart(f.data), { code: 'CRABOT_MAINTENANCE_PENDING' })
  } else { await complete(); assert.equal(readVersionMaintenance(f.data), null) }
  await assert.rejects(complete())
  assert.equal(await fs.readFile(path.join(f.data, 'fixture/content'), 'utf8'), 'before changed')
  assert.equal(await fs.readFile(path.join(backup.directory, 'data/fixture/content'), 'utf8'), 'before')
  assert.equal(await fs.readFile(path.join(f.data, 'agent-venv/keep'), 'utf8'), 'old Python unchanged')
  await assert.rejects(fs.lstat(path.join(f.data, 'instance-runtime.json')), { code: 'ENOENT' })
})

test('ordinary sealed-version recovery cannot turn a legacy takeover into an automatic start', async t => {
  const f = await fixture(t); const lock = await acquireCliLock(f.data, 'legacy-maintenance-test')
  const { record } = await f.backedUp(); await markVersionMaintenanceInstalling(f.data, record.id); releaseCliLock(lock)
  let called = false
  await assert.rejects(recoverVersionMaintenance({ dataDir: f.data, root: f.target, appVersion: '1.2.4', verifyCompatible: async () => {}, run: async () => { called = true; return true } }), { code: 'CRABOT_MAINTENANCE_PENDING' })
  assert.equal(called, false); assert.equal(readVersionMaintenance(f.data).phase, 'installing')
})


test('an interruption after entry sealing stays protected and can only finish that known phase', async t => {
  const f = await fixture(t); await acquireCliLock(f.data, 'legacy-maintenance-test')
  const { record } = await f.backedUp(), rename = fs.rename
  const journal = path.join(f.root, '.desktop-takeover/transaction.json')
  const patch = t.mock.method(fs, 'rename', async (from, to) => {
    await rename(from, to)
    if (to === journal && JSON.parse(await fs.readFile(to, 'utf8')).phase === 'data_changing') throw Object.assign(new Error('controlled post-seal I/O failure'), { code: 'EIO' })
  })
  await assert.rejects(markVersionMaintenanceInstalling(f.data, record.id), { code: 'EIO' }); patch.mock.restore()
  assert.equal(readVersionMaintenance(f.data).phase, 'backed_up')
  assert.equal((await inspectLegacyEntryFence(f.root)).phase, 'data_changing')
  await assert.rejects(cancelPreparedLegacyUserVersionMaintenance({ dataDir: f.data, id: record.id }))
  await assert.rejects(restoreLegacyEntries(f.root))
  await markVersionMaintenanceInstalling(f.data, record.id)
  assert.equal(readVersionMaintenance(f.data).phase, 'installing')
  assert.equal(await fs.readFile(path.join(f.data, 'fixture/content'), 'utf8'), 'before')
})

for (const changed of ['missing-target', 'mixed-source', 'unknown-source', 'system-scope']) {
  test('malformed legacy maintenance cannot weaken the common startup guard: ' + changed, async t => {
    const f = await fixture(t); await acquireCliLock(f.data, 'legacy-maintenance-test')
    const record = await f.begin()
    if (changed === 'missing-target') delete record.target_core
    if (changed === 'mixed-source') record.source_inventory_sha256 = 'a'.repeat(64)
    if (changed === 'unknown-source') record.source_version = 'v2025.01.01.1'
    if (changed === 'system-scope') record.legacy_source.scope = 'system'
    await fs.writeFile(path.join(f.data, 'desktop-maintenance.json'), JSON.stringify(record))
    assert.throws(() => readVersionMaintenance(f.data), { code: 'CRABOT_MAINTENANCE_PENDING' })
    assert.throws(() => assertVersionMaintenanceAllowsStart(f.data), { code: 'CRABOT_MAINTENANCE_PENDING' })
    assert.equal(await fs.readFile(path.join(f.data, 'fixture/content'), 'utf8'), 'before')
  })
}
