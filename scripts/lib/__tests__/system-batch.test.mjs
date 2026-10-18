import test from 'node:test'
import assert from 'node:assert/strict'
import { planSystemBatch, executeSystemBatch, selectSystemUserAction, requireBatchConfirmation } from '../system-batch.mjs'

const entries = () => [1, 2, 3].map((n) => ({ uid: 1000 + n, gid: 1000 + n, user: 'user' + n, home: '/home/user' + n,
  data_dir: '/home/user' + n + '/.crabot/data-' + n * 100, port_offset: n * 100, enabled: true, autostart: false }))
const stopped = { state: 'stopped', generation: null }
const running = n => ({ state: 'running', generation: 'generation-' + n, ready: true })

test('batch targets registered enabled users only and preserves stopped restart semantics', async () => {
  const list = entries(); list[2].enabled = false
  const plan = await planSystemBatch('restart', list, async entry => entry.uid === 1001 ? running(1) : stopped)
  assert.deepEqual(plan.items.map(item => [item.entry.uid, item.mutate]), [[1001, true], [1002, false]])
  assert.equal(plan.confirmation_required, true)
  list[0].data_dir = '/changed'
  assert.equal(plan.items[0].entry.data_dir, '/home/user1/.crabot/data-100')
  const result = await executeSystemBatch(plan, { apply: async (_, action, observation) => {
    assert.equal(action, 'restart')
    return selectSystemUserAction(action, observation, observation) === 'skip' ? { state: 'skipped', observed_state: 'stopped' } : { state: 'restarted' }
  } })
  assert.deepEqual(result.results.map(row => row.state), ['restarted', 'skipped']); assert.equal(result.exit_code, 0)
})

test('empty all-user operation succeeds without prompting or dispatching', async () => {
  const plan = await planSystemBatch('stop', [], () => assert.fail())
  assert.equal(requireBatchConfirmation(plan), false)
  const result = await executeSystemBatch(plan, { apply: () => assert.fail() })
  assert.deepEqual(result.results, []); assert.equal(result.exit_code, 0)
})

test('destructive noninteractive batch requires explicit yes, start does not', async () => {
  const plan = await planSystemBatch('stop', entries(), () => running(1))
  assert.throws(() => requireBatchConfirmation(plan), { code: 'CRABOT_SYSTEM_CONFIRMATION_REQUIRED' })
  assert.equal(requireBatchConfirmation(plan, { yes: true }), false)
  assert.equal(requireBatchConfirmation(plan, { interactive: true }), true)
  assert.equal(requireBatchConfirmation(await planSystemBatch('start', entries(), () => stopped)), false)
})

test('per-user failure and unknown outcome preserve other users and produce nonzero result', async () => {
  const plan = await planSystemBatch('start', entries(), () => stopped)
  const calls = [], persisted = []
  let active = false
  const result = await executeSystemBatch(plan, { save: value => { persisted.push(structuredClone(value)) }, apply: async entry => {
    assert.equal(active, false, 'batch must be sequential'); active = true
    assert.equal(persisted.at(-1).current_uid, entry.uid, 'intent must be durable before dispatch')
    calls.push(entry.uid); await new Promise(resolve => setImmediate(resolve)); active = false
    if (entry.uid === 1002) throw new Error('cannot stop/inspect this user')
    return { state: entry.uid === 1003 ? 'unknown' : 'started' }
  } })
  assert.deepEqual(calls, [1001, 1002, 1003]); assert.equal(result.exit_code, 1)
  assert.deepEqual(result.results.map(row => row.state), ['started', 'failed', 'unknown'])
})

test('failed user observation never dispatches but later independently safe users continue', async () => {
  const plan = await planSystemBatch('stop', entries(), entry => { if (entry.uid === 1002) throw new Error('UID changed'); return running(entry.uid) })
  const calls = []
  const result = await executeSystemBatch(plan, { apply: async entry => { calls.push(entry.uid); return { state: 'stopped' } } })
  assert.deepEqual(calls, [1001, 1003]); assert.equal(result.exit_code, 1)
})

test('journal failure prevents dispatch or later mutation instead of losing crash evidence', async () => {
  const plan = await planSystemBatch('restart', entries(), entry => running(entry.uid))
  let dispatched = 0, writes = 0
  await assert.rejects(executeSystemBatch(plan, { save: () => { if (++writes === 3) throw new Error('disk full') }, apply: () => {
    dispatched++; return { state: 'restarted' }
  } }), /disk full/)
  assert.equal(dispatched, 1, 'never replay the unacknowledged action or run later users')
})

test('atomic action decision preserves stopped users and rejects replacement/unknown processes', () => {
  assert.equal(selectSystemUserAction('restart', running(1), stopped), 'skip')
  assert.equal(selectSystemUserAction('restart', stopped, running(2)), 'skip')
  assert.equal(selectSystemUserAction('start', stopped, stopped), 'start')
  assert.equal(selectSystemUserAction('start', running(1), running(1)), 'skip')
  assert.equal(selectSystemUserAction('stop', running(1), stopped), 'skip')
  assert.throws(() => selectSystemUserAction('restart', running(1), running(2)), { code: 'CRABOT_SYSTEM_INSTANCE_CHANGED' })
  assert.throws(() => selectSystemUserAction('stop', running(1), { state: 'unknown' }))
  assert.throws(() => selectSystemUserAction('stop', stopped, running(1)), { code: 'CRABOT_SYSTEM_INSTANCE_CHANGED' })
  assert.throws(() => selectSystemUserAction('restart', { state: 'starting', generation: 'generation-1' }, running(1)), { code: 'CRABOT_SYSTEM_INSTANCE_BUSY' })
  assert.throws(() => selectSystemUserAction('start', stopped, { ...running(1), ready: false }))
  assert.throws(() => selectSystemUserAction('start', stopped, { state: 'starting', generation: 'new' }))
})

test('an unknown preflight observation is retained and never dispatched as a new start', async () => {
  const plan = await planSystemBatch('start', entries(), entry => {
    if (entry.uid === 1002) throw Object.assign(new Error('service query incomplete'), { code: 'CRABOT_SYSTEM_SERVICE_FAILED' })
    return stopped
  })
  assert.equal(plan.items[1].mutate, false)
  const calls = []
  const result = await executeSystemBatch(plan, { apply: async entry => { calls.push(entry.uid); return { state: 'started' } } })
  assert.deepEqual(calls, [1001, 1003]); assert.equal(result.results[1].state, 'unknown'); assert.equal(result.exit_code, 1)
})
