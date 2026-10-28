import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs, constants, readFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import management from '../desktop-management.cjs'
import identity from '../process-identity.cjs'
import pythonSelection from '../agent-python-selection.cjs'
import { acquireCliLock, releaseCliLock } from '../cli-lock.mjs'
import { materializeLegacyRelease } from './fixtures/legacy-release.mjs'
import { discoverLegacyUserInstall } from '../legacy-desktop.mjs'
import { fenceLegacyEntries, inspectLegacyEntryFence, restoreLegacyEntries } from '../legacy-entry-fence.mjs'
import { writeCoreRelease } from '../core-release.mjs'
import { createMaintenanceBackup, verifyMaintenanceBackup } from '../maintenance-backup.mjs'
import { prepareCoreEnvironment, applyStartupMigrations, verifyDataCompatibility } from '../core-preparation.mjs'
import { beginLegacyUserVersionMaintenance, cancelPreparedLegacyUserVersionMaintenance,
  assertVersionMaintenanceAllowsStart, readVersionMaintenance, recordVersionMaintenanceBackup,
  markVersionMaintenanceInstalling, recoverVersionMaintenance, completeStoppedVersionMaintenance,
  prepareScopedVersionMaintenance, migrateStoppedVersionMaintenance, bindLegacyPythonMaintenance, selectLegacyPythonMaintenance } from '../version-maintenance.mjs'

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
  await fs.writeFile(path.join(target, 'crabot-fixture/upgrade/scope.mjs'), `export const migrationScope = () => ({ reads: [], writes: ['fixture/content', 'fixture/SCHEMA_VERSION'] })`)
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

for (const fail of [false, true]) for (const dataMode of process.platform === 'win32' ? [null] : [0o700, 0o755]) test('legacy source migrates only once offline, retaining its old environment; failure=' + fail + '; dataMode=' + dataMode, async t => {
  const f = await fixture(t, { fail }); if (dataMode !== null) await fs.chmod(f.data, dataMode); await acquireCliLock(f.data, 'legacy-maintenance-test')
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
  if (dataMode !== null) assert.equal((await fs.stat(f.data)).mode & 0o777, dataMode)
  assert.equal(await fs.readFile(path.join(f.data, 'fixture/content'), 'utf8'), fail ? 'before' : 'before changed')
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


for (const fail of [false, true]) test('fresh scoped legacy takeover protects only actual writes and keeps health admission pending; failure=' + fail, async t => {
  const f = await fixture(t, { fail }); f.options.dataProtection = 'scoped'
  await fs.mkdir(path.join(f.data, 'agent/traces'), { recursive: true })
  await fs.writeFile(path.join(f.data, 'agent/traces/history'), 'unrelated history')
  await acquireCliLock(f.data, 'legacy-scoped-maintenance-test')
  const record = await f.begin()
  assert.equal(record.schema_version, 4); assert.equal(record.data_protection, 'scoped')
  assert.equal(record.source_inventory_sha256, undefined); assert.equal(record.backup, null)
  const readdir = fs.readdir.bind(fs), copyFile = fs.copyFile.bind(fs), copied = []
  t.mock.method(fs, 'readdir', async (directory, ...args) => {
    assert.notEqual(String(directory), path.join(f.data, 'agent/traces'))
    return readdir(directory, ...args)
  })
  t.mock.method(fs, 'copyFile', async (source, ...args) => { copied.push(String(source)); return copyFile(source, ...args) })
  await prepareScopedVersionMaintenance(f.data, record.id)
  assert.equal(readVersionMaintenance(f.data).phase, 'prepared')
  await assert.rejects(fs.lstat(f.data + '.desktop-backups'), { code: 'ENOENT' })
  await assert.rejects(fs.lstat(path.join(f.data, '.upgrade-migrations')), { code: 'ENOENT' })
  await bindLegacyPythonMaintenance({ dataDir: f.data, id: record.id, inspectEnvironment: async () => ({ status: 'absent' }) })
  await markVersionMaintenanceInstalling(f.data, record.id)
  assert.equal((await inspectLegacyEntryFence(f.root)).phase, 'data_changing')
  assert.deepEqual(await selectLegacyPythonMaintenance({ dataDir: f.data, id: record.id, inspectEnvironment: async () => ({ status: 'absent' }) }), { selected: false, environment_created: false })
  const options = { dataDir: f.data, root: f.target, id: record.id,
    migrate: () => applyStartupMigrations(f.target, f.data, { DATA_DIR: f.data }),
    verifyComplete: () => assert.equal(verifyDataCompatibility(f.target, f.data).length, 0) }
  await assert.rejects(completeStoppedVersionMaintenance(options), { code: 'CRABOT_MAINTENANCE_PENDING' })
  assert.equal(readVersionMaintenance(f.data).phase, 'installing')
  if (fail) await assert.rejects(migrateStoppedVersionMaintenance(options), { code: 'CRABOT_MIGRATION_FAILED' })
  else await migrateStoppedVersionMaintenance(options)
  assert.equal(readVersionMaintenance(f.data).phase, 'verifying')
  assert.throws(() => assertVersionMaintenanceAllowsStart(f.data), { code: 'CRABOT_MAINTENANCE_PENDING' })
  await assert.rejects(cancelPreparedLegacyUserVersionMaintenance({ dataDir: f.data, id: record.id }))
  const transactions = await fs.readdir(path.join(f.data, '.upgrade-migrations'))
  assert.equal(transactions.length, 1)
  const directory = path.join(f.data, '.upgrade-migrations', transactions[0])
  assert.deepEqual(await fs.readdir(path.join(directory, 'backup')), ['fixture'])
  assert.equal(await fs.readFile(path.join(directory, 'backup/fixture/content'), 'utf8'), 'before')
  for (const file of ['content', 'SCHEMA_VERSION']) assert.equal(copied.filter(source => source === path.join(f.data, 'fixture', file)).length, 1)
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'state.json'), 'utf8')).phase, fail ? 'rolled_back' : 'completed')
  assert.equal(await fs.readFile(path.join(f.data, 'fixture/content'), 'utf8'), fail ? 'before' : 'before changed')
  assert.equal(await fs.readFile(path.join(f.data, 'agent/traces/history'), 'utf8'), 'unrelated history')
  assert.equal(await fs.readFile(path.join(f.data, 'agent-venv/keep'), 'utf8'), 'old Python unchanged')
  releaseCliLock(path.join(f.data, 'cli.lock'))
  let started = false
  await assert.rejects(recoverVersionMaintenance({ dataDir: f.data, root: f.target, appVersion: '1.2.4', verifyCompatible: async () => {}, run: async () => { started = true; return true } }), { code: 'CRABOT_MAINTENANCE_PENDING' })
  assert.equal(started, false); assert.equal(readVersionMaintenance(f.data).phase, 'verifying')
})

for (const prepared of [false, true]) test('scoped legacy cancellation only removes its own pre-data preparation; prepared=' + prepared, async t => {
  const f = await fixture(t); f.options.dataProtection = 'scoped'
  await acquireCliLock(f.data, 'legacy-scoped-maintenance-test')
  const record = await f.begin()
  if (prepared) await prepareScopedVersionMaintenance(f.data, record.id)
  assert.deepEqual(await cancelPreparedLegacyUserVersionMaintenance({ dataDir: f.data, id: record.id }), { preparation_cancelled: true, service_started: false })
  assert.equal(readVersionMaintenance(f.data), null)
  assert.equal((await inspectLegacyEntryFence(f.root)).phase, 'fenced')
  assert.equal(await fs.readFile(path.join(f.data, 'fixture/content'), 'utf8'), 'before')
})

for (const changed of ['wrong-fence', 'damaged-target', 'running', 'no-lock', 'system-scope', 'wide-backup', 'unknown-transaction']) test('scoped legacy admission preserves source and scope boundaries: ' + changed, async t => {
  const f = await fixture(t); f.options.dataProtection = 'scoped'
  const lock = await acquireCliLock(f.data, 'legacy-scoped-maintenance-test'), record = await f.begin()
  assert.equal(record.schema_version, 4)
  if (changed === 'wrong-fence') record.legacy_source.entry_fence_id = randomUUID()
  if (changed === 'damaged-target') await fs.appendFile(path.join(f.target, 'package.json'), 'changed')
  if (changed === 'running') await fs.writeFile(path.join(f.data, 'mm.pid'), String(process.pid))
  if (changed === 'no-lock') releaseCliLock(lock)
  if (changed === 'system-scope') { record.legacy_source.scope = 'system'; record.legacy_source.manifest_fingerprint = 'a'.repeat(64); record.system_operation_id = randomUUID() }
  if (changed === 'wide-backup') record.backup = { id: randomUUID(), sha256: 'a'.repeat(64) }
  if (changed === 'unknown-transaction') {
    await fs.mkdir(path.join(f.data, '.upgrade-migrations/interrupted'), { recursive: true })
    await fs.writeFile(path.join(f.data, '.upgrade-migrations/interrupted/state.json'), '{}')
  }
  await fs.writeFile(path.join(f.data, 'desktop-maintenance.json'), JSON.stringify(record))
  await assert.rejects(prepareScopedVersionMaintenance(f.data, record.id))
  assert.equal(await fs.readFile(path.join(f.data, 'fixture/content'), 'utf8'), 'before')
  await assert.rejects(fs.lstat(f.data + '.desktop-backups'), { code: 'ENOENT' })
})


for (const changed of [null, 'receipt', 'source']) test('scoped takeover binds and selects the exact prepared Python reference; changed=' + changed, async t => {
  const f = await fixture(t); f.options.dataProtection = 'scoped'
  await acquireCliLock(f.data, 'legacy-scoped-python-test')
  const record = await f.begin(); await prepareScopedVersionMaintenance(f.data, record.id)
  const id = randomUUID(), sourceFingerprint = 'a'.repeat(64), relative = 'agent-environments/' + id
  const directory = management.ensurePrivateDataRoot(path.join(management.ensurePrivateDataRoot(path.join(f.data, 'agent-environments')), id))
  const writePrivate = (file, value) => {
    const bytes = JSON.stringify(value) + '\n'
    if (process.platform === 'win32') identity.writePrivateFile(file, bytes)
    else return fs.writeFile(file, bytes, { mode: 0o600 }).then(() => bytes)
    return bytes
  }
  const receipt = path.join(directory, 'legacy-rebuild.json')
  const bytes = await writePrivate(receipt, { schema_version: 1, kind: 'legacy-python-rebuild', id, source_fingerprint: sourceFingerprint, pins: [], python_version: '3.12.12' })
  await writePrivate(path.join(directory, '.crabot-runtime.json'), { schema_version: 1, python_version: '3.12.12', base_id: 'b'.repeat(24) })
  const reference = { schema_version: 1, id, directory: relative, source_fingerprint: sourceFingerprint, receipt_sha256: createHash('sha256').update(bytes).digest('hex') }
  const inspectEnvironment = async () => ({ status: 'observed', fingerprint: sourceFingerprint, packages: [], unrecorded_files: [], unrecorded_site_files: 0, site_references: 0, special_site_files: 0 })
  await bindLegacyPythonMaintenance({ dataDir: f.data, id: record.id, prepared: reference, inspectEnvironment })
  assert.equal(pythonSelection.readAgentEnvironmentReference(f.data), null)
  await markVersionMaintenanceInstalling(f.data, record.id)
  if (changed === 'receipt') await fs.appendFile(receipt, 'changed')
  if (changed === 'source') await fs.appendFile(path.join(f.root, 'VERSION'), 'changed')
  let called = false
  const select = () => selectLegacyPythonMaintenance({ dataDir: f.data, id: record.id, inspectEnvironment, selectPrepared: async ({ prepared }) => {
    called = true; await writePrivate(path.join(f.data, pythonSelection.selectionName), prepared)
  } })
  if (changed) { await assert.rejects(select()); assert.equal(called, false); assert.equal(pythonSelection.readAgentEnvironmentReference(f.data), null) }
  else { assert.equal((await select()).selected, true); assert.deepEqual(pythonSelection.readAgentEnvironmentReference(f.data), reference) }
  assert.equal(readVersionMaintenance(f.data).phase, 'installing')
})

test('scoped takeover with no data changes creates no backup but still awaits real target health', async t => {
  const f = await fixture(t); f.options.dataProtection = 'scoped'
  await fs.writeFile(path.join(f.data, 'fixture/SCHEMA_VERSION'), 'v2')
  await acquireCliLock(f.data, 'legacy-scoped-noop-test')
  const record = await f.begin(); await prepareScopedVersionMaintenance(f.data, record.id); await markVersionMaintenanceInstalling(f.data, record.id)
  await migrateStoppedVersionMaintenance({ dataDir: f.data, root: f.target, id: record.id,
    migrate: () => applyStartupMigrations(f.target, f.data, { DATA_DIR: f.data }), verifyComplete: () => assert.equal(verifyDataCompatibility(f.target, f.data).length, 0) })
  assert.equal(readVersionMaintenance(f.data).phase, 'verifying')
  await assert.rejects(fs.lstat(f.data + '.desktop-backups'), { code: 'ENOENT' })
  await assert.rejects(fs.lstat(path.join(f.data, '.upgrade-migrations')), { code: 'ENOENT' })
  assert.equal(await fs.readFile(path.join(f.data, 'fixture/content'), 'utf8'), 'before')
})

test('scoped takeover retries only a lost entry seal result and cannot cancel after sealing', async t => {
  const f = await fixture(t); f.options.dataProtection = 'scoped'
  await acquireCliLock(f.data, 'legacy-scoped-seal-test')
  const record = await f.begin(); await prepareScopedVersionMaintenance(f.data, record.id)
  const journal = path.join(f.root, '.desktop-takeover/transaction.json'), rename = fs.rename
  const patch = t.mock.method(fs, 'rename', async (from, to) => {
    await rename(from, to)
    if (to === journal && JSON.parse(await fs.readFile(to, 'utf8')).phase === 'data_changing') throw Object.assign(new Error('controlled post-seal I/O failure'), { code: 'EIO' })
  })
  await assert.rejects(markVersionMaintenanceInstalling(f.data, record.id), { code: 'EIO' }); patch.mock.restore()
  assert.equal(readVersionMaintenance(f.data).phase, 'prepared')
  await assert.rejects(cancelPreparedLegacyUserVersionMaintenance({ dataDir: f.data, id: record.id }))
  await markVersionMaintenanceInstalling(f.data, record.id)
  assert.equal(readVersionMaintenance(f.data).phase, 'installing')
  assert.equal(await fs.readFile(path.join(f.data, 'fixture/content'), 'utf8'), 'before')
})
