import test from 'node:test'
import assert from 'node:assert/strict'
import { planSystemUpgrade, executeSystemUpgrade } from '../system-upgrade.mjs'
const source = { id: 'a'.repeat(64), version: '1.2.3' }, target = { id: 'b'.repeat(64), version: '1.2.4' }
const entries = () => [1, 2, 3].map(n => ({ user: 'user' + n, uid: 1000 + n, gid: 1000 + n, home: '/home/user' + n,
  data_dir: '/home/user' + n + '/.crabot/data-' + n * 100, port_offset: n * 100, enabled: true, autostart: false }))
function fixture() {
  const plan = planSystemUpgrade({ installRoot: '/opt/crabot', source, target, instances: entries().map((entry, n) => ({ entry,
    observation: n === 1 ? { state: 'stopped', generation: null } : { state: 'running', generation: 'instance-' + n } })) })
  const calls = [], records = []
  const states = new Map(plan.instances.map(item => [item.entry.uid, structuredClone(item.observation)]))
  let selected = source.id
  const operations = {
    save: record => { records.push(record) }, selected: async () => selected,
    observe: async entry => structuredClone(states.get(entry.uid)),
    stop: async entry => { calls.push('stop-' + entry.uid); states.set(entry.uid, { state: 'stopped' }); return { state: 'stopped' } },
    snapshot: async entry => { calls.push('snapshot-' + entry.uid); return { system_operation_id: plan.id, id: 'snapshot-' + entry.uid } },
    select: async (expected, next) => { assert.equal(expected, selected); selected = next; calls.push('select-target') },
    cancelSnapshot: async entry => { calls.push('cancel-' + entry.uid) },
    migrate: async entry => { calls.push('migrate-' + entry.uid) },
    startSource: async entry => { calls.push('source-' + entry.uid); states.set(entry.uid, { state: 'running' }); return { state: 'started' } },
    startTarget: async entry => { calls.push('target-' + entry.uid); assert.equal(records.at(-1).allow_start.core_id, target.id); return { state: 'started' } },
  }
  return { plan, operations, calls, records, states }
}
test('shared upgrade backs up all users before selection and only restores the original running set', async () => {
  const f = fixture(), result = await executeSystemUpgrade(f.plan, f.operations)
  assert.deepEqual(f.calls, ['stop-1001', 'stop-1003', 'snapshot-1001', 'snapshot-1002', 'snapshot-1003', 'select-target',
    'migrate-1001', 'target-1001', 'migrate-1002', 'migrate-1003', 'target-1003'])
  assert.equal(result.exit_code, 0); assert.deepEqual(result.results.map(row => row.state), ['healthy', 'kept_stopped', 'healthy'])
  assert.equal(result.allow_start, undefined); assert.equal(result.current_uid, undefined)
})
test('unknown identity, pending data maintenance or startup in progress blocks before shutdown', () => {
  const f = fixture()
  for (const observation of [{ state: 'unknown' }, { state: 'starting', generation: 'starting' }, { state: 'stopped', maintenance: { phase: 'verifying' } }]) {
    assert.throws(() => planSystemUpgrade({ installRoot: '/opt/crabot', source, target, instances: [{ entry: entries()[0], observation }] }), { code: 'CRABOT_SYSTEM_UPGRADE_NOT_READY' })
  }
  assert.equal(f.calls.length, 0)
})
test('snapshot failure while source is selected cancels only preparation and restores stopped original instances', async () => {
  const f = fixture()
  f.operations.snapshot = async entry => { f.calls.push('snapshot-' + entry.uid); if (entry.uid === 1002) throw new Error('backup full'); return { system_operation_id: f.plan.id } }
  const result = await executeSystemUpgrade(f.plan, f.operations)
  assert.equal(result.exit_code, 1); assert.equal(result.error.message, 'backup full')
  assert.deepEqual(f.calls, ['stop-1001', 'stop-1003', 'snapshot-1001', 'snapshot-1002', 'cancel-1001', 'source-1001', 'cancel-1002', 'source-1003'])
  assert.equal(f.calls.some(call => call.startsWith('migrate') || call.startsWith('target') || call === 'select-target'), false)
})
test('unconfirmed stop prevents shared switch and never starts the user whose stop is unknown', async () => {
  const f = fixture()
  f.operations.stop = async entry => { f.calls.push('stop-' + entry.uid); if (entry.uid === 1003) throw new Error('stop unknown'); return { state: 'stopped' } }
  const result = await executeSystemUpgrade(f.plan, f.operations)
  assert.deepEqual(f.calls, ['stop-1001', 'stop-1003', 'source-1001']); assert.equal(result.results[2].state, 'unknown')
  assert.equal(result.exit_code, 1)
})
test('selection failure that already changed the selector is not automatically rolled back or replayed', async () => {
  const f = fixture()
  f.operations.select = async () => { f.calls.push('select-target'); throw new Error('directory sync failed') }
  f.operations.selected = async () => target.id
  const result = await executeSystemUpgrade(f.plan, f.operations)
  assert.equal(result.phase, 'interrupted'); assert.equal(result.stage, 'selection_unsettled'); assert.equal(result.exit_code, 1)
  assert.equal(f.calls.some(call => call.startsWith('source-') || call.startsWith('cancel-') || call.startsWith('migrate-')), false)
})
test('partial migration failure keeps the target and processes other users without restoring old code/data', async () => {
  const f = fixture()
  f.operations.migrate = async entry => { f.calls.push('migrate-' + entry.uid); if (entry.uid === 1001) throw new Error('migration interrupted') }
  const result = await executeSystemUpgrade(f.plan, f.operations)
  assert.equal(result.exit_code, 1); assert.deepEqual(result.results.map(row => row.state), ['unknown', 'kept_stopped', 'healthy'])
  assert.ok(f.calls.includes('target-1003')); assert.equal(f.calls.includes('target-1001'), false)
  assert.equal(f.calls.some(call => call.startsWith('source-') || call.startsWith('cancel-')), false)
})
test('journal failure stops immediately before dispatch and never enters compensating mutation', async () => {
  const f = fixture(); let saves = 0
  f.operations.save = () => { if (++saves === 3) throw new Error('disk failed') }
  await assert.rejects(executeSystemUpgrade(f.plan, f.operations), { code: 'CRABOT_SYSTEM_JOURNAL_FAILED' })
  assert.deepEqual(f.calls, ['stop-1001'])
})
test('failed source recovery stays protected while other independent source users recover', async () => {
  const f = fixture(); f.operations.snapshot = async () => { throw new Error('snapshot preparation interrupted') }
  f.operations.cancelSnapshot = async entry => { f.calls.push('cancel-' + entry.uid); throw new Error('writer still alive') }
  const result = await executeSystemUpgrade(f.plan, f.operations)
  assert.equal(result.results[0].state, 'unknown'); assert.equal(result.results[2].state, 'healthy')
  assert.equal(f.calls.includes('source-1001'), false); assert.ok(f.calls.includes('source-1003'))
})

test('a previously stopped user that starts during preview is not falsely reported stopped or killed during compensation', async () => {
  const f = fixture()
  f.states.set(1002, { state: 'running', generation: 'late-start' })
  f.operations.snapshot = async entry => { if (entry.uid === 1002) throw new Error('instance changed'); return { system_operation_id: f.plan.id } }
  const result = await executeSystemUpgrade(f.plan, f.operations)
  assert.equal(result.results[1].state, 'unknown'); assert.equal(result.exit_code, 1)
  assert.equal(f.calls.includes('stop-1002'), false); assert.equal(f.calls.includes('source-1002'), false)
})
test('a migrated stopped user is freshly checked before being declared kept stopped', async () => {
  const f = fixture()
  f.operations.migrate = async entry => { f.calls.push('migrate-' + entry.uid); if (entry.uid === 1002) f.states.set(entry.uid, { state: 'running', generation: 'unexpected' }) }
  const result = await executeSystemUpgrade(f.plan, f.operations)
  assert.equal(result.results[1].state, 'unknown'); assert.equal(f.calls.includes('target-1002'), false)
  assert.equal(result.results[2].state, 'healthy')
})
