import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import management from '../desktop-management.cjs'
import identity from '../process-identity.cjs'
import selection from '../agent-python-selection.cjs'
import { acquireCliLock, releaseCliLock } from '../cli-lock.mjs'
import { writeCoreRelease, verifyCoreRelease } from '../core-release.mjs'
import { createMaintenanceBackup } from '../maintenance-backup.mjs'
import { readVersionMaintenance, recordVersionMaintenanceBackup, assertVersionMaintenanceAllowsStart,
  bindLegacyPythonMaintenance, selectLegacyPythonMaintenance } from '../version-maintenance.mjs'

async function fixture(t) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'crabot-python-maintenance-')))
  const dataDir = management.ensurePrivateDataRoot(path.join(parent, 'data')), target = path.join(parent, 'target')
  t.after(() => { releaseCliLock(path.join(dataDir, 'cli.lock')); fs.rmSync(parent, { recursive: true, force: true }) })
  fs.mkdirSync(target)
  for (const file of ['product-runtime.json', 'package.json']) fs.writeFileSync(path.join(target, file), '{"version":"1.2.4"}')
  await writeCoreRelease(target, { schema_version: 1, version: '1.2.4', platform: process.platform, arch: process.arch, commit: '1'.repeat(40), source_dirty: false })
  const core = await verifyCoreRelease(target)
  const id = randomUUID(), environmentId = randomUUID(), sourceFingerprint = 'a'.repeat(64)
  const reference = { schema_version: 1, id: environmentId, directory: 'agent-environments/' + environmentId,
    receipt_sha256: '', source_fingerprint: sourceFingerprint }
  const environment = management.ensurePrivateDataRoot(path.join(management.ensurePrivateDataRoot(path.join(dataDir, 'agent-environments')), environmentId))
  const writePrivate = (file, value) => {
    const bytes = JSON.stringify(value) + '\n'
    if (process.platform === 'win32' && !fs.existsSync(file)) identity.writePrivateFile(file, bytes)
    else fs.writeFileSync(file, bytes, { mode: 0o600 })
    return createHash('sha256').update(bytes).digest('hex')
  }
  reference.receipt_sha256 = writePrivate(path.join(environment, 'legacy-rebuild.json'), { schema_version: 1, kind: 'legacy-python-rebuild', id: environmentId,
    source_fingerprint: sourceFingerprint, pins: [], python_version: '3.12.12' })
  writePrivate(path.join(environment, '.crabot-runtime.json'), { schema_version: 1, python_version: '3.12.12', base_id: 'b'.repeat(24) })
  const record = { schema_version: 2, id, data_dir: dataDir, install_root: path.join(parent, 'retained-old-source'), source_version: 'v2026.10.15.1',
    target_version: '1.2.4', target_core: { root: target, inventory_sha256: core.inventory_sha256 },
    legacy_source: { scope: 'user', entry_fence_id: randomUUID(), fingerprint: 'c'.repeat(64) }, phase: 'preparing', backup: null }
  const journal = path.join(dataDir, 'desktop-maintenance.json'), write = () => writePrivate(journal, record)
  write(); const lock = await acquireCliLock(dataDir, 'python-maintenance-test')
  const backup = await createMaintenanceBackup(dataDir); await recordVersionMaintenanceBackup(dataDir, id, backup)
  Object.assign(record, readVersionMaintenance(dataDir))
  // Source inspection and interpreter execution are separate, previously native-
  // tested components. This fixture tests the actual private reference/guard I/O.
  let observed = { status: 'observed', fingerprint: sourceFingerprint, packages: [], unrecorded_files: [], unrecorded_site_files: 0, site_references: 0, special_site_files: 0 }
  const inspectEnvironment = async () => observed
  const input = { dataDir, id, prepared: { ...reference, binary: '/must-not-persist/secret', selected: false }, inspectEnvironment }
  const publish = async () => { writePrivate(path.join(dataDir, selection.selectionName), reference); return { ...reference, selected: true } }
  return { dataDir, target, reference, record, lock, write, input, environment, publish, setObserved: value => { observed = value },
    bind: extra => bindLegacyPythonMaintenance({ ...input, ...extra }), select: extra => selectLegacyPythonMaintenance({ dataDir, id, inspectEnvironment, selectPrepared: publish, ...extra }) }
}

test('backup-stage binding persists only a completed relative reference and never selects it early', async t => {
  const f = await fixture(t), bound = await f.bind()
  assert.deepEqual(bound.legacy_python, { status: 'prepared', reference: f.reference })
  assert.equal(JSON.stringify(readVersionMaintenance(f.dataDir)).includes('must-not-persist'), false)
  assert.equal(selection.readAgentEnvironmentReference(f.dataDir), null)
  await assert.rejects(f.select(), { code: 'CRABOT_MAINTENANCE_PENDING' })
  assert.deepEqual((await f.bind()).legacy_python, bound.legacy_python)
  Object.assign(f.record, bound, { phase: 'installing' }); f.write()
  const result = await f.select()
  assert.equal(result.selected, true); assert.deepEqual(selection.readAgentEnvironmentReference(f.dataDir), f.reference)
  assert.throws(() => assertVersionMaintenanceAllowsStart(f.dataDir), { code: 'CRABOT_MAINTENANCE_PENDING' })
})

for (const changed of ['no-lock', 'wrong-id', 'preparing', 'damaged-target', 'wrong-source', 'damaged-receipt', 'existing-selection']) test('unverified environment preparation cannot become a new default: ' + changed, async t => {
  const f = await fixture(t)
  if (changed === 'no-lock') releaseCliLock(f.lock)
  if (changed === 'wrong-id') f.input.id = randomUUID()
  if (changed === 'preparing') { f.record.phase = 'preparing'; f.write() }
  if (changed === 'damaged-target') fs.appendFileSync(path.join(f.target, 'package.json'), 'broken')
  if (changed === 'wrong-source') f.setObserved({ status: 'observed', fingerprint: 'f'.repeat(64), packages: [], unrecorded_files: [], unrecorded_site_files: 0, site_references: 0, special_site_files: 0 })
  if (changed === 'damaged-receipt') fs.appendFileSync(path.join(f.environment, 'legacy-rebuild.json'), 'broken')
  if (changed === 'existing-selection') await f.publish()
  await assert.rejects(f.bind())
  assert.equal(readVersionMaintenance(f.dataDir).legacy_python, undefined)
  assert.equal(Boolean(selection.readAgentEnvironmentReference(f.dataDir)), changed === 'existing-selection')
})

test('an absent old environment is rechecked before selection without creating any interpreter or fallback', async t => {
  const f = await fixture(t); f.setObserved({ status: 'absent' })
  const bound = await f.bind({ prepared: undefined }); assert.deepEqual(bound.legacy_python, { status: 'absent' })
  Object.assign(f.record, bound, { phase: 'installing' }); f.write()
  assert.deepEqual(await f.select({ selectPrepared: () => assert.fail() }), { selected: false, environment_created: false })
  f.setObserved({ status: 'observed' }); await assert.rejects(f.select())
  assert.equal(selection.readAgentEnvironmentReference(f.dataDir), null)
  assert.equal(fs.existsSync(path.join(f.dataDir, 'agent-venv')), false)
})

test('publication without the exact durable reference is not reported as a successful selection', async t => {
  const f = await fixture(t), bound = await f.bind(); Object.assign(f.record, bound, { phase: 'installing' }); f.write()
  await assert.rejects(f.select({ selectPrepared: async () => ({ selected: true }) }), { code: 'CRABOT_MAINTENANCE_PENDING' })
  assert.equal(selection.readAgentEnvironmentReference(f.dataDir), null)
})

test('a lost selection result retains both the published reference and the installing fence without replaying or clearing it', async t => {
  const f = await fixture(t), bound = await f.bind(); Object.assign(f.record, bound, { phase: 'installing' }); f.write()
  await assert.rejects(f.select({ selectPrepared: async () => { await f.publish(); throw Object.assign(new Error('controlled publication unknown'), { code: 'CRABOT_PYTHON_SELECTION_UNKNOWN' }) } }), { code: 'CRABOT_PYTHON_SELECTION_UNKNOWN' })
  assert.deepEqual(selection.readAgentEnvironmentReference(f.dataDir), f.reference)
  assert.equal(readVersionMaintenance(f.dataDir).phase, 'installing'); await assert.rejects(f.bind())
  assert.throws(() => assertVersionMaintenanceAllowsStart(f.dataDir))
})

for (const changed of ['unexpected-absence-field', 'escaping-reference', 'unexpected-prepared-field']) test('malformed Python transaction metadata cannot weaken the common startup fence: ' + changed, async t => {
  const f = await fixture(t), bound = await f.bind(); Object.assign(f.record, bound)
  if (changed === 'unexpected-absence-field') f.record.legacy_python = { status: 'absent', ignored: true }
  if (changed === 'escaping-reference') f.record.legacy_python.reference.directory = '../outside'
  if (changed === 'unexpected-prepared-field') f.record.legacy_python.ignored = true
  f.write()
  assert.throws(() => readVersionMaintenance(f.dataDir), { code: 'CRABOT_MAINTENANCE_PENDING' })
  assert.throws(() => assertVersionMaintenanceAllowsStart(f.dataDir), { code: 'CRABOT_MAINTENANCE_PENDING' })
  assert.equal(selection.readAgentEnvironmentReference(f.dataDir), null)
})

test('system source binding retains its original root operation and never invokes user-source takeover policy', async t => {
  const f = await fixture(t), operation = randomUUID()
  f.record.system_operation_id = operation
  f.record.legacy_source = { ...f.record.legacy_source, scope: 'system', manifest_fingerprint: 'd'.repeat(64) }; f.write()
  const bound = await f.bind()
  assert.equal(bound.system_operation_id, operation); assert.equal(bound.legacy_source.scope, 'system')
  Object.assign(f.record, bound, { phase: 'installing' }); f.write()
  assert.equal((await f.select()).selected, true)
  assert.throws(() => assertVersionMaintenanceAllowsStart(f.dataDir), error => error.message.includes('system status'))
})
