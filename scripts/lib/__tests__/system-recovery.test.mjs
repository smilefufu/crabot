import test from 'node:test'
import assert from 'node:assert/strict'
import { planSystemBatch } from '../system-batch.mjs'
import { planSystemUpgrade } from '../system-upgrade.mjs'
import { executeSystemRecovery, systemRecoveryOptions } from '../system-recovery.mjs'
const entries = [1, 2].map(n => ({ uid: 1000 + n, gid: 1000 + n, user: 'user' + n, home: '/home/user' + n,
  data_dir: '/home/user' + n + '/data', port_offset: n * 100, enabled: true, autostart: false }))
const source = { id: 'a'.repeat(64), version: '1.2.3' }, target = { id: 'b'.repeat(64), version: '1.2.4' }
const stopped = { state: 'stopped', generation: null }
function fixture() {
  const plan = planSystemUpgrade({ installRoot: '/opt/crabot', source, target,
    instances: entries.map(entry => ({ entry, observation: { state: 'running', generation: 'original-' + entry.uid } })) })
  const rows = entries.map(entry => ({ uid: entry.uid, user: entry.user, originally_running: true, stopped: true,
    stop_dispatched: true, snapshot_dispatched: true, migration_dispatched: false, start_dispatched: false,
    migrated: false, started: false, state: 'pending', snapshot: { id: 'snapshot-' + entry.uid, system_operation_id: plan.id } }))
  const calls = [], saves = [], states = new Map(entries.map(entry => [entry.uid, stopped]))
  const operations = {
    selected: async () => target.id, save: async record => saves.push(record), observe: async entry => states.get(entry.uid),
    migrate: async entry => calls.push('migrate-' + entry.uid), checkMigration: async entry => calls.push('check-' + entry.uid),
    startTarget: async entry => { calls.push('start-' + entry.uid); return { state: 'started', generation: 'target-' + entry.uid } },
    startSource: async entry => { calls.push('source-' + entry.uid); return { state: 'started', generation: 'source-' + entry.uid } },
    cancelSnapshot: async entry => calls.push('cancel-' + entry.uid),
  }
  return { plan, prior: { results: rows }, calls, saves, states, operations }
}
test('target recovery migrates and starts only proven undispatched work', async () => {
  const f = fixture(), result = await executeSystemRecovery(f.plan, f.prior, { mode: 'continue', operations: f.operations })
  assert.deepEqual(f.calls, ['migrate-1001', 'check-1001', 'start-1001', 'migrate-1002', 'check-1002', 'start-1002'])
  assert.equal(result.exit_code, 0)
  assert.ok(f.saves.some(record => record.stage === 'migration_dispatched' && record.results[0].migration_dispatched))
})
test('migration with no root completion receipt is never replayed even when the employee fence vanished', async () => {
  const f = fixture(); f.prior.results[0].migration_dispatched = true
  const result = await executeSystemRecovery(f.plan, f.prior, { mode: 'continue', operations: f.operations })
  assert.equal(result.results[0].state, 'unknown'); assert.equal(result.exit_code, 1)
  assert.equal(f.calls.includes('migrate-1001'), false); assert.equal(f.calls.includes('start-1001'), false)
  assert.ok(f.calls.includes('start-1002'))
})
test('previously started healthy users are observed and never resurrected after an independent stop', async () => {
  const f = fixture(); Object.assign(f.prior.results[0], { migration_dispatched: true, migrated: true, start_dispatched: true, started: true })
  const result = await executeSystemRecovery(f.plan, f.prior, { mode: 'continue', operations: f.operations })
  assert.equal(result.results[0].state, 'kept_stopped'); assert.equal(f.calls.includes('start-1001'), false)
})
test('issued start without a reply is observed, never repeated; a verified stop can be released with a warning', async () => {
  const f = fixture(); Object.assign(f.prior.results[0], { migration_dispatched: true, migrated: true, start_dispatched: true })
  const result = await executeSystemRecovery(f.plan, f.prior, { mode: 'continue', operations: f.operations })
  assert.equal(result.results[0].state, 'kept_stopped'); assert.equal(result.results[0].original_action_unknown, true)
  assert.equal(f.calls.includes('start-1001'), false); assert.equal(result.exit_code, 1)
})
test('running target needs the root migration receipt and actual target identity and health', async () => {
  const f = fixture(); Object.assign(f.prior.results[0], { migration_dispatched: true, migrated: true, start_dispatched: true })
  f.states.set(1001, { state: 'running', ready: true, core_id: target.id, generation: 'target-running' })
  const result = await executeSystemRecovery(f.plan, f.prior, { mode: 'continue', operations: f.operations })
  assert.equal(result.results[0].state, 'healthy'); assert.equal(f.calls.some(call => call.endsWith('1001')), false)
})
test('source cancellation verifies only its own preparation and restores stopped original running users', async () => {
  const f = fixture(); f.operations.selected = async () => source.id
  const result = await executeSystemRecovery(f.plan, f.prior, { mode: 'cancel', operations: f.operations })
  assert.deepEqual(f.calls, ['cancel-1001', 'source-1001', 'cancel-1002', 'source-1002'])
  assert.equal(result.exit_code, 1); assert.ok(result.results.every(row => row.state === 'healthy'))
})
test('source cancellation does not repeat an uncertain prior source start', async () => {
  const f = fixture(); f.operations.selected = async () => source.id; f.prior.results[0].start_dispatched = true
  const result = await executeSystemRecovery(f.plan, f.prior, { mode: 'cancel', operations: f.operations })
  assert.equal(f.calls.includes('source-1001'), false); assert.equal(result.results[0].state, 'kept_stopped')
})
test('cancelling an undispatched prepared job performs no startup or restoration', async () => {
  const f = fixture(); f.operations.selected = async () => source.id
  const result = await executeSystemRecovery(f.plan, null, { mode: 'cancel', operations: f.operations })
  assert.deepEqual(f.calls, []); assert.equal(result.exit_code, 1)
})
test('target cannot be cancelled into an automatic shared downgrade; a changed selector blocks everything', async () => {
  const f = fixture()
  await assert.rejects(executeSystemRecovery(f.plan, f.prior, { mode: 'cancel', operations: f.operations }), /不能|不授权/)
  f.operations.selected = async () => 'c'.repeat(64)
  await assert.rejects(executeSystemRecovery(f.plan, f.prior, { mode: 'continue', operations: f.operations }), { code: 'CRABOT_SYSTEM_INSTANCE_CHANGED' })
  assert.deepEqual(f.calls, [])
})
test('source recovery refuses root evidence of migration or unknown dispatch format', () => {
  const f = fixture(); f.prior.results[0].migration_dispatched = true
  assert.throws(() => systemRecoveryOptions(f.plan, f.prior, source.id), { code: 'CRABOT_SYSTEM_RECOVERY_UNKNOWN' })
  delete f.prior.results[0].migration_dispatched
  assert.throws(() => systemRecoveryOptions(f.plan, f.prior, source.id), { code: 'CRABOT_SYSTEM_RECOVERY_UNKNOWN' })
})
test('journal failure before resumed migration performs no compensating mutation or replay', async () => {
  const f = fixture(); let saves = 0
  f.operations.save = async () => { if (++saves === 2) throw new Error('fsync failed') }
  await assert.rejects(executeSystemRecovery(f.plan, f.prior, { mode: 'continue', operations: f.operations }), { code: 'CRABOT_SYSTEM_JOURNAL_FAILED' })
  assert.deepEqual(f.calls, [])
})
test('batch recovery observes issued unknown actions and continues only untouched targets', async () => {
  const plan = await planSystemBatch('restart', entries, entry => ({ state: 'running', generation: 'old-' + entry.uid }))
  const calls = []
  const prior = { current_uid: 1001, dispatched: [1001], results: [] }
  const result = await executeSystemRecovery(plan, prior, { mode: 'continue', operations: {
    save: async () => {}, observe: async () => stopped,
    apply: async entry => { calls.push(entry.uid); return { state: 'skipped', observed_state: 'stopped' } },
  } })
  assert.deepEqual(calls, [1002]); assert.equal(result.results[0].state, 'observed_stopped')
  assert.equal(result.results[0].original_action_unknown, true); assert.equal(result.exit_code, 1)
})
test('a second recovery still distinguishes untouched targets from placeholder pending rows', async () => {
  const plan = await planSystemBatch('start', entries, () => stopped), calls = []
  const prior = { recovery_mode: 'continue', results: [{ uid: 1001, state: 'unknown', dispatched: true }, { uid: 1002, state: 'pending', dispatched: false }] }
  await executeSystemRecovery(plan, prior, { mode: 'continue', operations: {
    save: async () => {}, observe: async () => stopped, apply: async entry => { calls.push(entry.uid); return { state: 'started' } },
  } })
  assert.deepEqual(calls, [1002])
})
test('pending data maintenance cannot be released merely because a batch instance is stopped', async () => {
  const plan = await planSystemBatch('start', entries.slice(0, 1), () => stopped)
  const result = await executeSystemRecovery(plan, { current_uid: 1001, results: [] }, { mode: 'cancel', operations: {
    save: async () => {}, observe: async () => ({ ...stopped, maintenance: { phase: 'verifying' } }), apply: () => assert.fail(),
  } })
  assert.equal(result.results[0].state, 'unknown')
})


test('a known preflight failure with no dispatch remains local and does not block independent recovery', async () => {
  const plan = await planSystemBatch('start', entries, entry => {
    if (entry.uid === 1001) throw new Error('account changed before planning')
    return stopped
  })
  const calls = []
  const result = await executeSystemRecovery(plan, { results: [{ uid: 1001, state: 'failed' }], dispatched: [] }, { mode: 'continue', operations: {
    save: async () => {}, observe: async entry => { assert.equal(entry.uid, 1002); return stopped },
    apply: async entry => { calls.push(entry.uid); return { state: 'started' } },
  } })
  assert.deepEqual(calls, [1002]); assert.equal(result.results[0].state, 'failed'); assert.equal(result.exit_code, 1)
})


test('source cancellation only observes a healthy replacement and never signals or restarts that generation', async () => {
  const f = fixture(); f.operations.selected = async () => source.id
  f.states.set(1001, { state: 'running', ready: true, core_id: source.id, generation: 'independent-replacement' })
  const result = await executeSystemRecovery(f.plan, f.prior, { mode: 'cancel', operations: f.operations })
  assert.equal(result.results[0].state, 'observed_running'); assert.equal(result.results[0].original_action_unknown, true)
  assert.equal(f.calls.some(call => call.endsWith('1001')), false)
})
