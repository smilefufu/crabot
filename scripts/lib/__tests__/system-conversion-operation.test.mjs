import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { SystemRegistry } from '../system-registry.mjs'
import { SystemOperationStore } from '../system-operation.mjs'
import { planSystemConversion } from '../system-conversion.mjs'
import { systemMaintenanceAllowsServiceStart } from '../system-context.mjs'
import { systemRecoveryOptions, executeSystemRecovery } from '../system-recovery.mjs'

const options = { skip: process.platform === 'win32' }
async function fixture(t) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'crabot-conversion-job-')))
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  const account = { user: 'alice', uid: 1001, gid: 1002, home: '/home/alice' }
  const registry = new SystemRegistry({ directory: path.join(parent, 'system'), ownerUid: process.getuid(), accountLookup: () => account })
  await registry.update(() => [], { create: true })
  const entry = { ...account, data_dir: '/must-not-access/employee-data', port_offset: 100, enabled: true, autostart: false }
  const source = { version: 'v2026.10.15.1', installRoot: '/opt/crabot-old', code_fingerprint: 'a'.repeat(64) }
  const observation = { user: entry.user, uid: entry.uid, port_offset: entry.port_offset, data_dir: entry.data_dir, data_directory: { device: '1', inode: '2' },
    install_root: source.installRoot, code_fingerprint: source.code_fingerprint, manifest_fingerprint: 'c'.repeat(64),
    runtime_state: 'stopped', data_binding: 'verified_stopped' }
  const plan = planSystemConversion({ installRoot: '/opt/crabot-managed', source, target: { id: 'b'.repeat(64), version: '1.2.4' }, instances: [{ entry, observation }] })
  const store = new SystemOperationStore(registry), calls = []
  const conversion = {
    fence: async () => { calls.push('fence'); return { id: randomUUID(), operation_id: plan.id, phase: 'fenced', installation: source } },
    stop: () => assert.fail('originally stopped'), snapshot: async () => { calls.push('snapshot'); return { id: randomUUID(), system_operation_id: plan.id,
      target_id: plan.target.id, backup: { id: randomUUID(), sha256: 'd'.repeat(64) } } },
    selectTarget: async () => { calls.push('select') }, sealSource: async () => { calls.push('seal') },
    migrate: async () => { calls.push('migrate'); return { migrated: true, service_started: false } },
    register: async value => { calls.push('register'); return registry.registerConverted(value, { operationId: plan.id }) },
    configure: async () => { calls.push('configure') }, observeTarget: async () => ({ state: 'stopped' }), startTarget: () => assert.fail('stopped stays stopped'),
  }
  return { registry, store, entry, plan, conversion, calls }
}

test('conversion records its distinct fixed legacy plan without requiring pre-existing managed users', options, async t => {
  const { store, plan, entry } = await fixture(t)
  await store.prepare(plan)
  const privateRecord = store.read(store.file(plan.id), true)
  assert.equal(privateRecord.plan.source.id, undefined)
  assert.equal(privateRecord.plan.source.version, 'v2026.10.15.1')
  assert.equal(fs.statSync(store.file(plan.id)).mode & 0o777, 0o600)
  assert.deepEqual(store.maintenance().targets, [entry.uid]); assert.equal(store.maintenance().operation, 'conversion')
  await assert.rejects(store.prepare({ ...plan, id: randomUUID() }), { code: 'CRABOT_SYSTEM_BUSY' })
})

test('conversion stage receipts reach protected registration under the same coordinator lock', options, async t => {
  const { store, registry, plan, entry, conversion, calls } = await fixture(t)
  await store.prepare(plan)
  const result = await store.run(plan.id, { conversion, apply: () => assert.fail('conversion is never a batch') })
  assert.equal(result.exit_code, 0); assert.deepEqual(calls, ['fence', 'snapshot', 'select', 'seal', 'migrate', 'register', 'configure'])
  assert.deepEqual(registry.read(), [entry]); assert.equal(store.completion(plan.id).results[0].state, 'kept_stopped')
  assert.equal(store.maintenance().operation, 'conversion'); store.assertIdle()
  await assert.rejects(store.run(plan.id, { conversion }), { code: 'CRABOT_SYSTEM_OPERATION_INTERRUPTED' })
})

for (const scenario of ['existing-managed', 'changed-account', 'extra-business-field', 'bad-schema', 'bad-id', 'unknown-kind']) {
  test('conversion rejects an incompatible preflight before persisting maintenance: ' + scenario, options, async t => {
    const { store, registry, plan, entry } = await fixture(t)
    if (scenario === 'existing-managed') await registry.update(() => [entry])
    if (scenario === 'changed-account') registry.accountLookup = () => ({ user: 'alice', uid: 2000, gid: 2000, home: '/home/other' })
    if (scenario === 'extra-business-field') plan.api_key = 'must-not-persist'
    if (scenario === 'bad-schema') plan.schema_version = 9
    if (scenario === 'bad-id') plan.id = '../outside'
    if (scenario === 'unknown-kind') { plan.kind = 'unknown'; plan.action = 'start'; plan.items = [] }
    await assert.rejects(store.prepare(plan))
    assert.equal(store.maintenance(), null)
  })
}

test('missing conversion adapter and changed real account cannot dispatch or fall through to batch', options, async t => {
  const { store, registry, plan, conversion, calls } = await fixture(t); await store.prepare(plan)
  await assert.rejects(store.run(plan.id, { apply: () => assert.fail() }))
  assert.equal(store.read(store.file(plan.id), true).phase, 'prepared')
  registry.accountLookup = () => ({ user: 'alice', uid: 2000, gid: 2000, home: '/home/other' })
  await assert.rejects(store.run(plan.id, { conversion }))
  assert.deepEqual(calls, []); assert.equal(store.read(store.file(plan.id), true).phase, 'prepared')
})

test('one-sided registration intent never publishes a migrated user', options, async t => {
  const { store, registry, plan, conversion, calls } = await fixture(t); await store.prepare(plan)
  const write = store.write.bind(store)
  store.write = (file, record, mode) => {
    if (file.endsWith('/maintenance.json') && record.stage === 'registration_dispatched') throw new Error('controlled public journal failure')
    return write(file, record, mode)
  }
  await assert.rejects(store.run(plan.id, { conversion }), { code: 'CRABOT_SYSTEM_JOURNAL_FAILED' })
  store.write = write
  assert.equal(calls.includes('register'), false); assert.deepEqual(registry.read(), [])
  assert.throws(() => store.assertIdle(), { code: 'CRABOT_SYSTEM_BUSY' })
})

test('ordinary recovery never treats a legacy conversion as a batch or sealed-source upgrade', options, async t => {
  const { store, plan } = await fixture(t); await store.prepare(plan)
  assert.throws(() => systemRecoveryOptions(plan, null, 'legacy'), { code: 'CRABOT_SYSTEM_CONVERSION_RECOVERY_REQUIRED' })
  await assert.rejects(executeSystemRecovery(plan, null, { mode: 'continue', operations: { apply: () => assert.fail(), observe: () => assert.fail() } }),
    { code: 'CRABOT_SYSTEM_CONVERSION_RECOVERY_REQUIRED' })
  await assert.rejects(store.prepareRecovery(plan.id, 'continue', { checkCoordinator: async () => {} }), { code: 'CRABOT_SYSTEM_CONVERSION_RECOVERY_REQUIRED' })
  assert.equal(store.read(store.file(plan.id), true).phase, 'prepared')
})

test('a converted target service requires exact boot, UID, target hash and current systemd service', () => {
  const entry = { uid: 1001 }, context = { entry, coreId: 'b'.repeat(64), bootId: 'boot-now', cgroup: '0::/user.slice/crabot.service\n' }
  const record = { schema_version: 1, operation: 'conversion', phase: 'running', boot_id: 'boot-now', current_uid: entry.uid,
    allow_start: { uid: entry.uid, core_id: context.coreId } }
  assert.equal(systemMaintenanceAllowsServiceStart(record, context), true)
  for (const change of [{ coreId: 'a'.repeat(64) }, { entry: { uid: 1002 } }, { bootId: 'old' }, { cgroup: '0::/other.service' }]) {
    assert.equal(systemMaintenanceAllowsServiceStart(record, { ...context, ...change }), false)
  }
  assert.equal(systemMaintenanceAllowsServiceStart({ ...record, allow_start: undefined }, context), false)
})
