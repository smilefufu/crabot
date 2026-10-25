import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { planSystemConversion } from '../system-conversion.mjs'
import { createLegacySystemConversionPermit, validateLegacySystemConversionPermit, conversionStopMaintenanceMatches, conversionMaintenanceMatches } from '../system-conversion-permit.mjs'
import { readLegacySystemConversionPermit, readLegacySystemAccountPermit, readSystemUserPermit, runLegacySystemConversionStop, runLegacySystemConversion } from '../system-user.mjs'

function fixture() {
  const entry = { user: 'alice', uid: 1001, gid: 1002, home: '/home/alice', data_dir: '/srv/alice', port_offset: 100, enabled: true, autostart: false }
  const source = { version: 'v2026.10.15.1', installRoot: '/opt/crabot-old', code_fingerprint: 'a'.repeat(64) }
  const observation = { user: entry.user, uid: entry.uid, port_offset: entry.port_offset, data_dir: entry.data_dir, data_directory: { device: '1', inode: '2' },
    install_root: source.installRoot, code_fingerprint: source.code_fingerprint, manifest_fingerprint: 'c'.repeat(64), runtime_state: 'running', data_binding: 'observed_running',
    controller: { pid: 10000, parent: 1, owner: '1001', started: 'controller', executable: '/usr/bin/node' },
    mm: { pid: 10001, parent: 10000, owner: '1001', started: 'mm', executable: '/usr/bin/node' }, mm_port: 19100, launch_kind: 'daemon' }
  const plan = planSystemConversion({ installRoot: '/opt/crabot-managed', source, target: { version: '1.2.4', id: 'b'.repeat(64) }, instances: [{ entry, observation }] })
  const bootId = randomUUID(), fenceId = randomUUID()
  const record = { schema_version: 1, plan, phase: 'running', boot_id: bootId,
    progress: { schema_version: 1, kind: 'conversion', id: plan.id, phase: 'running', stage: 'stop_dispatched', current_uid: entry.uid,
      source_fence_id: fenceId, results: [{ uid: entry.uid, user: entry.user, state: 'pending', originally_running: true, stop_dispatched: true, stopped: false }] } }
  const maintenance = { schema_version: 1, id: plan.id, operation: 'conversion', phase: 'running', boot_id: bootId,
    current_uid: entry.uid, stage: 'stop_dispatched', targets: [entry.uid], unsettled: [] }
  const sourceFence = { id: fenceId, operation_id: plan.id, phase: 'fenced', entries_fenced: true, installation: source }
  return { entry, record, maintenance, sourceFence, bootId }
}

test('only matching two-sided root stop intent and the same fully fenced source produce a compact role permit', () => {
  const f = fixture(), permit = createLegacySystemConversionPermit(f)
  assert.equal(permit.kind, 'legacy-system-conversion'); assert.equal(permit.action, 'stop-legacy')
  assert.equal(permit.operation_id, f.record.plan.id); assert.deepEqual(permit.observation, f.record.plan.instances[0].observation)
  assert.equal(permit.target, undefined); assert.equal(permit.input, undefined)
  assert.equal(conversionStopMaintenanceMatches(permit, f.maintenance, f.bootId), true)
})

for (const changed of ['private-phase', 'private-kind', 'public-phase', 'public-boot', 'boot', 'private-stage', 'public-stage', 'private-uid', 'public-uid',
  'missing-fence', 'other-fence', 'partial-fence', 'sealed-fence', 'other-source', 'already-stopped', 'not-dispatched', 'string-flag', 'stopped-preview',
  'different-entry', 'extra-target', 'early-start', 'public-start', 'recovery', 'public-recovery', 'business-field']) {
  test('incomplete or stale conversion authority cannot issue a stop permit: ' + changed, () => {
    const f = fixture(), progress = f.record.progress, row = progress.results[0]
    if (changed === 'private-phase') f.record.phase = 'prepared'
    if (changed === 'private-kind') progress.kind = 'upgrade'
    if (changed === 'public-phase') f.maintenance.phase = 'completed'
    if (changed === 'public-boot') f.maintenance.boot_id = randomUUID()
    if (changed === 'boot') f.bootId = randomUUID()
    if (changed === 'private-stage') progress.stage = 'migration_dispatched'
    if (changed === 'public-stage') f.maintenance.stage = 'snapshot_dispatched'
    if (changed === 'private-uid') progress.current_uid = 1002
    if (changed === 'public-uid') f.maintenance.current_uid = 1002
    if (changed === 'missing-fence') delete progress.source_fence_id
    if (changed === 'other-fence') f.sourceFence.operation_id = randomUUID()
    if (changed === 'partial-fence') f.sourceFence.entries_fenced = false
    if (changed === 'sealed-fence') f.sourceFence.phase = 'data_changing'
    if (changed === 'other-source') f.sourceFence.installation = { ...f.sourceFence.installation, code_fingerprint: 'f'.repeat(64) }
    if (changed === 'already-stopped') row.stopped = true
    if (changed === 'not-dispatched') row.stop_dispatched = false
    if (changed === 'string-flag') row.stop_dispatched = 'true'
    if (changed === 'stopped-preview') f.record.plan.instances[0].observation.runtime_state = 'stopped'
    if (changed === 'different-entry') f.entry = { ...f.entry, data_dir: '/srv/other' }
    if (changed === 'extra-target') f.maintenance.targets.push(1002)
    if (changed === 'early-start') progress.allow_start = { uid: 1001, core_id: 'b'.repeat(64) }
    if (changed === 'public-start') f.maintenance.allow_start = { uid: 1001, core_id: 'b'.repeat(64) }
    if (changed === 'recovery') f.record.recovery = { id: randomUUID() }
    if (changed === 'public-recovery') f.maintenance.recovery_id = randomUUID()
    if (changed === 'business-field') f.record.plan.instances[0].observation.api_key = 'must-not-read'
    assert.throws(() => createLegacySystemConversionPermit(f))
  })
}

test('conversion permits, discovery-only permits and ordinary control permits cannot substitute for each other', { skip: process.platform === 'win32' }, t => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'crabot-conversion-permit-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'permit.json'), f = fixture(), permit = createLegacySystemConversionPermit(f)
  const parse = (value, reader, owner = process.getuid()) => {
    fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); const fd = fs.openSync(file, 'r')
    try { return reader(fd, owner) } finally { fs.closeSync(fd) }
  }
  assert.equal(parse(permit, readLegacySystemConversionPermit).entry.uid, 1001)
  assert.throws(() => parse(permit, readSystemUserPermit)); assert.throws(() => parse(permit, readLegacySystemAccountPermit))
  assert.throws(() => parse({ schema_version: 1, id: randomUUID(), action: 'stop', entry: f.entry }, readLegacySystemConversionPermit))
  for (const patch of [{ kind: 'legacy-account-discovery' }, { action: 'discover-legacy' }, { action: 'migrate' }, { input: 'arbitrary' }, { id: '../outside' }]) {
    assert.throws(() => validateLegacySystemConversionPermit({ ...permit, ...patch }))
  }
  assert.throws(() => parse(permit, readLegacySystemConversionPermit, process.getuid() + 1))
  fs.chmodSync(file, 0o644); assert.throws(() => parse(permit, readLegacySystemConversionPermit))
})

test('ordinary users cannot enter the root conversion dispatcher or spawn a helper', { skip: process.platform === 'linux' && process.getuid() === 0 }, async () => {
  await assert.rejects(runLegacySystemConversionStop({}, { root: '/must-not-read', operationId: randomUUID(), spawnProcess: () => assert.fail() }),
    { code: 'CRABOT_SYSTEM_ADMIN_REQUIRED' })
})

test('a tagged conversion data descriptor cannot be consumed by the ordinary snapshot role', { skip: process.platform === 'win32' }, t => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'crabot-conversion-data-role-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const f = fixture(), permit = { ...createLegacySystemConversionPermit(f), action: 'snapshot', install_root: f.record.plan.install_root,
    target: f.record.plan.target, snapshot: null }
  const file = path.join(directory, 'permit.json'); fs.writeFileSync(file, JSON.stringify(permit), { mode: 0o600 })
  const fd = fs.openSync(file, 'r')
  try { assert.throws(() => readSystemUserPermit(fd, process.getuid())) } finally { fs.closeSync(fd) }
})

function dataFixture(action) {
  const f = fixture(), row = f.record.progress.results[0]
  f.action = action; row.stopped = true; row.snapshot_dispatched = true
  const stage = { snapshot: 'snapshot_dispatched', migrate: 'migration_dispatched', 'cancel-preparation': 'source_preparation_cancel_dispatched' }[action]
  f.record.progress.stage = stage; f.maintenance.stage = stage
  if (action === 'migrate') {
    f.sourceFence.phase = 'data_changing'; row.migration_dispatched = true
    row.snapshot = { id: randomUUID(), system_operation_id: f.record.plan.id, target_id: f.record.plan.target.id,
      backup: { id: randomUUID(), sha256: 'd'.repeat(64) } }
  }
  return f
}
for (const action of ['snapshot', 'migrate', 'cancel-preparation']) test('dedicated data permit pins the root phase/source/target and carries no arbitrary command: ' + action, () => {
  const f = dataFixture(action), permit = createLegacySystemConversionPermit(f)
  assert.equal(permit.action, action); assert.equal(permit.install_root, f.record.plan.install_root)
  assert.deepEqual(permit.target, f.record.plan.target); assert.equal(permit.input, undefined); assert.equal(permit.deployment, undefined)
  assert.equal(conversionStopMaintenanceMatches(permit, f.maintenance, f.bootId), false)
  assert.equal(conversionMaintenanceMatches(permit, f.maintenance, f.bootId), true)
  assert.equal(conversionMaintenanceMatches(permit, { ...f.maintenance, stage: 'stop_dispatched' }, f.bootId), false)
  assert.equal(conversionMaintenanceMatches(permit, f.maintenance, randomUUID()), false)
  assert.deepEqual(validateLegacySystemConversionPermit(permit), permit)
  if (action === 'migrate') assert.deepEqual(permit.snapshot, f.record.progress.results[0].snapshot)
  else assert.equal(permit.snapshot, null)
})
for (const changed of ['unsealed-migration', 'sealed-snapshot', 'wrong-public-stage', 'unknown-result', 'wrong-user', 'not-all-stopped', 'bad-backup',
  'wrong-target', 'already-migrated', 'not-dispatched', 'bad-result-set', 'snapshot-replay', 'cancel-after-migration']) test('unsettled conversion data stages cannot issue a descriptor: ' + changed, () => {
  const action = changed === 'sealed-snapshot' || changed === 'snapshot-replay' ? 'snapshot' : changed === 'cancel-after-migration' ? 'cancel-preparation' : 'migrate'
  const f = dataFixture(action), row = f.record.progress.results[0]
  if (changed === 'unsealed-migration') f.sourceFence.phase = 'fenced'
  if (changed === 'sealed-snapshot') f.sourceFence.phase = 'data_changing'
  if (changed === 'wrong-public-stage') f.maintenance.stage = 'snapshot_ready'
  if (changed === 'unknown-result') row.state = 'unknown'
  if (changed === 'wrong-user') row.user = 'bob'
  if (changed === 'not-all-stopped') row.stopped = false
  if (changed === 'bad-backup') row.snapshot.backup.sha256 = 'invalid'
  if (changed === 'wrong-target') row.snapshot.target_id = 'f'.repeat(64)
  if (changed === 'already-migrated') row.migrated = true
  if (changed === 'not-dispatched') row.migration_dispatched = false
  if (changed === 'bad-result-set') f.record.progress.results.push({ ...row })
  if (changed === 'snapshot-replay') row.snapshot = {}
  if (changed === 'cancel-after-migration') row.migration_dispatched = true
  assert.throws(() => createLegacySystemConversionPermit(f))
})

test('data descriptor cannot add business contents, redirect targets or cross ordinary/discovery role readers', { skip: process.platform === 'win32' }, t => {
  const f = dataFixture('migrate'), permit = createLegacySystemConversionPermit(f)
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'crabot-data-role-reader-')), file = path.join(directory, 'permit.json')
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(file, JSON.stringify(permit), { mode: 0o600 })
  for (const reader of [readSystemUserPermit, readLegacySystemAccountPermit]) {
    const fd = fs.openSync(file, 'r'); try { assert.throws(() => reader(fd, process.getuid())) } finally { fs.closeSync(fd) }
  }
  for (const patch of [{ input: 'arbitrary-command' }, { install_root: '../elsewhere' }, { target: { ...permit.target, api_key: 'must-not-read' } },
    { snapshot: { ...permit.snapshot, content: 'must-not-transfer' } }, { action: 'check-migration' }]) {
    assert.throws(() => validateLegacySystemConversionPermit({ ...permit, ...patch }))
  }
})

for (const action of ['snapshot', 'migrate', 'cancel-preparation']) test('nonadministrator cannot dispatch conversion data helpers: ' + action,
  { skip: process.platform === 'linux' && process.getuid() === 0 }, async () => {
    await assert.rejects(runLegacySystemConversion({}, { root: '/must-not-read', operationId: randomUUID(), action,
      spawnProcess: () => assert.fail('must not spawn') }), { code: 'CRABOT_SYSTEM_ADMIN_REQUIRED' })
  })

for (const action of ['snapshot', 'migrate', 'cancel-preparation']) test('existing verified-stopped data binding can receive only its exact conversion data role: ' + action, () => {
  const f = dataFixture(action), observation = f.record.plan.instances[0].observation, row = f.record.progress.results[0]
  observation.runtime_state = 'stopped'; observation.data_binding = 'verified_stopped'; row.originally_running = false
  for (const name of ['controller', 'mm', 'mm_port', 'launch_kind']) delete observation[name]
  const permit = createLegacySystemConversionPermit(f)
  assert.equal(permit.action, action); assert.equal(permit.observation.runtime_state, 'stopped')
  assert.equal(permit.entry.data_dir, f.entry.data_dir)
  assert.equal(permit.source_fence_id, f.sourceFence.id)
  assert.equal(conversionMaintenanceMatches(permit, f.maintenance, f.bootId), true)
  assert.throws(() => validateLegacySystemConversionPermit({ ...permit, observation: { ...observation, data_binding: 'unverified' } }))
})

test('an entirely valid originally-stopped observation still cannot receive a legacy stop action', () => {
  const f = fixture(), observation = f.record.plan.instances[0].observation
  observation.runtime_state = 'stopped'; observation.data_binding = 'verified_stopped'
  f.record.progress.results[0].originally_running = false
  for (const name of ['controller', 'mm', 'mm_port', 'launch_kind']) delete observation[name]
  assert.throws(() => createLegacySystemConversionPermit(f), { code: 'CRABOT_SYSTEM_CONVERSION_PERMIT' })
})
