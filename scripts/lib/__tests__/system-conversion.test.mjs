import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { planSystemConversion, executeSystemConversion } from '../system-conversion.mjs'

function fixture({ fail, selectedAfterFailure, saveFailure, initiallyStopped = true, stoppedBeforeRequest = false } = {}) {
  const source = { version: 'v2026.10.15.1', installRoot: '/opt/crabot-old', code_fingerprint: 'a'.repeat(64) }
  const target = { version: '1.2.4', id: 'b'.repeat(64) }
  const instances = [1001, 1002].map((uid, index) => {
    const entry = { user: 'employee' + uid, uid, gid: uid, home: '/home/employee' + uid,
      data_dir: '/srv/employee' + uid, port_offset: 100 + index * 100, enabled: true, autostart: false }
    const running = index === 0 || !initiallyStopped
    const observation = { user: entry.user, uid, port_offset: entry.port_offset, install_root: source.installRoot,
      code_fingerprint: source.code_fingerprint, manifest_fingerprint: 'c'.repeat(64), data_dir: entry.data_dir,
      data_binding: running ? 'observed_running' : 'verified_stopped', runtime_state: running ? 'running' : 'stopped' }
    if (running) Object.assign(observation, { controller: { pid: uid + 10000, parent: 1, owner: String(uid), started: 'fixture-controller', executable: '/usr/bin/node' },
      mm: { pid: uid + 20000, parent: uid + 10000, owner: String(uid), started: 'fixture-mm', executable: '/usr/bin/node' }, mm_port: 19000 + entry.port_offset, launch_kind: 'daemon' })
    return { entry, observation }
  })
  const plan = planSystemConversion({ installRoot: '/opt/crabot-managed', source, target, instances })
  const calls = [], journals = [], states = new Map(instances.map(item => [item.entry.uid, item.observation.runtime_state]))
  let command = 'legacy', fenceId = randomUUID()
  const action = (name, apply = () => ({})) => async (...args) => {
    const uid = args[0]?.uid, key = name + (uid ? ':' + uid : '')
    calls.push(key)
    if (fail === key) { if (selectedAfterFailure) command = selectedAfterFailure; throw Object.assign(new Error('controlled operation failure'), { code: 'CRABOT_CONTROLLED_FAILURE' }) }
    return apply(...args)
  }
  const operations = {
    save: async value => { journals.push(structuredClone(value)); if (saveFailure === value.stage) throw new Error('controlled journal failure') },
    fence: action('fence', () => ({ id: fenceId, operation_id: plan.id, phase: 'fenced', installation: source })),
    stop: action('stop', entry => { states.set(entry.uid, 'stopped'); return { state: 'stopped', request_acknowledged: stoppedBeforeRequest ? null : true } }),
    snapshot: action('snapshot', () => ({ id: randomUUID(), system_operation_id: plan.id, backup: { id: randomUUID(), sha256: 'd'.repeat(64) }, target_id: target.id })),
    selectTarget: action('selectTarget', () => { command = 'target' }), selected: async () => command,
    sealSource: action('sealSource'), cancelSnapshot: action('cancelSnapshot'), restoreSource: action('restoreSource'),
    startSource: action('startSource', entry => { states.set(entry.uid, 'running'); return { state: 'started' } }),
    migrate: action('migrate', () => ({ migrated: true, service_started: false })), register: action('register'), configure: action('configure'),
    startTarget: action('startTarget', entry => { states.set(entry.uid, 'running'); return { state: 'started', generation: randomUUID() } }),
    observeTarget: action('observeTarget', entry => ({ state: states.get(entry.uid) })),
  }
  return { plan, operations, calls, journals, states, fenceId, run: () => executeSystemConversion(plan, operations) }
}

test('conversion keeps a real legacy source distinct, snapshots all UIDs before switching, and preserves stopped users', async () => {
  const f = fixture(), result = await f.run()
  assert.equal(f.plan.source.version, 'v2026.10.15.1'); assert.equal(f.plan.source.id, undefined)
  assert.equal(result.exit_code, 0)
  assert.deepEqual(f.calls, ['fence', 'stop:1001', 'snapshot:1001', 'snapshot:1002', 'selectTarget', 'sealSource',
    'migrate:1001', 'register:1001', 'configure:1001', 'startTarget:1001', 'migrate:1002', 'register:1002', 'configure:1002', 'observeTarget:1002'])
  assert.equal(f.states.get(1002), 'stopped')
  assert.equal(f.journals.some(value => value.stage === 'migration_dispatched' && value.current_uid === 1001 && !value.results[0].migrated), true)
})

test('unverified stopped hints and conflicting identity/data bindings do not become a conversion plan', () => {
  for (const changed of ['unverified', 'directory', 'offset', 'source', 'secret']) {
    const f = fixture(), instances = structuredClone(f.plan.instances), observation = instances[1].observation
    if (changed === 'unverified') observation.data_binding = 'unverified'
    if (changed === 'directory') observation.data_dir = '/srv/other'
    if (changed === 'offset') observation.port_offset = 900
    if (changed === 'source') observation.code_fingerprint = 'f'.repeat(64)
    if (changed === 'secret') observation.api_key = 'must-not-store'
    assert.throws(() => planSystemConversion({ installRoot: f.plan.install_root, source: f.plan.source, target: f.plan.target, instances }))
  }
})

for (const failure of ['fence', 'stop:1001']) test('unconfirmed source fencing or shutdown cannot switch software or restore unsafe entries: ' + failure, async () => {
  const f = fixture({ fail: failure }), result = await f.run()
  assert.equal(result.phase, 'interrupted'); assert.equal(result.exit_code, 1)
  assert.equal(f.calls.includes('selectTarget'), false); assert.equal(f.calls.includes('restoreSource'), false)
  assert.equal(f.calls.some(value => value.startsWith('migrate:')), false)
})

test('a data preparation failure restores source only after all UID preparations are cancelled', async () => {
  const f = fixture({ fail: 'snapshot:1002' }), result = await f.run()
  assert.equal(result.exit_code, 1)
  assert.deepEqual(f.calls, ['fence', 'stop:1001', 'snapshot:1001', 'snapshot:1002', 'cancelSnapshot:1001', 'cancelSnapshot:1002', 'restoreSource', 'startSource:1001'])
  assert.equal(f.states.get(1002), 'stopped')
})

test('an uncertain command switch never infers that source is still selected or automatically restores entries', async () => {
  const f = fixture({ fail: 'selectTarget', selectedAfterFailure: 'target' }), result = await f.run()
  assert.equal(result.phase, 'interrupted'); assert.equal(f.calls.includes('restoreSource'), false)
  assert.equal(f.calls.some(value => value.startsWith('cancelSnapshot:')), false)
  assert.equal(f.calls.some(value => value.startsWith('migrate:')), false)
})

test('a failed UID migration keeps that user protected while an independent original runner proceeds', async () => {
  const f = fixture({ fail: 'migrate:1001', initiallyStopped: false }), result = await f.run()
  assert.equal(result.exit_code, 1); assert.equal(result.results[0].state, 'unknown'); assert.equal(result.results[1].state, 'healthy')
  assert.equal(f.calls.includes('register:1001'), false); assert.equal(f.calls.includes('startTarget:1001'), false)
  assert.equal(f.calls.includes('startTarget:1002'), true); assert.equal(f.calls.includes('restoreSource'), false)
})

test('a preview runner already stopped before its own request is not revived', async () => {
  const f = fixture({ stoppedBeforeRequest: true }), result = await f.run()
  assert.equal(result.exit_code, 0); assert.equal(f.calls.includes('startTarget:1001'), false)
  assert.equal(result.results[0].resume_required, false); assert.equal(f.states.get(1001), 'stopped')
})

test('durable-intent failure prevents a new migration from being issued', async () => {
  const f = fixture({ saveFailure: 'migration_dispatched' })
  await assert.rejects(f.run(), { code: 'CRABOT_SYSTEM_JOURNAL_FAILED' })
  assert.equal(f.calls.some(value => value.startsWith('migrate:')), false)
})

for (const failure of ['sealSource', 'register:1001', 'configure:1001']) test('a post-switch failure does not restore old code or replay the successful migration: ' + failure, async () => {
  const f = fixture({ fail: failure, initiallyStopped: false }), result = await f.run()
  assert.equal(result.exit_code, 1); assert.equal(f.calls.includes('restoreSource'), false)
  if (failure === 'sealSource') {
    assert.equal(result.phase, 'interrupted'); assert.equal(f.calls.some(value => value.startsWith('migrate:')), false)
  } else {
    assert.equal(result.results[0].migrated, true); assert.equal(result.results[0].state, 'unknown')
    assert.equal(f.calls.filter(value => value === 'migrate:1001').length, 1)
    assert.equal(f.calls.includes('startTarget:1001'), false); assert.equal(f.calls.includes('startTarget:1002'), true)
  }
})

test('unknown preparation cancellation cannot reopen shared old launchers', async () => {
  const f = fixture({ fail: 'snapshot:1002' })
  f.operations.cancelSnapshot = async () => { throw new Error('controlled cancellation unknown') }
  const result = await f.run()
  assert.equal(result.phase, 'interrupted'); assert.equal(f.calls.includes('restoreSource'), false)
  assert.equal(f.calls.some(value => value.startsWith('startSource:')), false)
})

test('malformed or business-bearing snapshot data is never persisted in root progress', async () => {
  const f = fixture()
  f.operations.snapshot = async () => ({ id: randomUUID(), system_operation_id: f.plan.id,
    backup: { id: randomUUID(), sha256: 'd'.repeat(64) }, target_id: f.plan.target.id, api_key: 'must-not-persist' })
  const result = await f.run()
  assert.equal(result.exit_code, 1); assert.equal(f.calls.includes('selectTarget'), false)
  assert.equal(JSON.stringify(f.journals).includes('must-not-persist'), false)
})

test('unexpected target activity for an originally stopped user is reported without killing that generation', async () => {
  const f = fixture()
  f.operations.observeTarget = async () => ({ state: 'running', generation: randomUUID() })
  const result = await f.run()
  assert.equal(result.results[1].state, 'unknown'); assert.equal(result.exit_code, 1)
  assert.equal(f.calls.includes('startTarget:1002'), false)
})

for (const stage of ['source_fence_dispatched', 'command_switch_dispatched', 'source_seal_dispatched', 'migration_completed', 'registration_dispatched', 'target_start_dispatched']) {
  test('journal failure stops conversion at its exact durable-intent boundary: ' + stage, async () => {
    const f = fixture({ saveFailure: stage })
    await assert.rejects(f.run(), { code: 'CRABOT_SYSTEM_JOURNAL_FAILED' })
    const guarded = { source_fence_dispatched: 'fence', command_switch_dispatched: 'selectTarget', source_seal_dispatched: 'sealSource',
      migration_completed: 'register:1001', registration_dispatched: 'register:1001', target_start_dispatched: 'startTarget:1001' }[stage]
    assert.equal(f.calls.includes(guarded), false)
  })
}

test('a migration that reports business already started cannot authorize registration or another start', async () => {
  const f = fixture({ initiallyStopped: false }), migrate = f.operations.migrate
  f.operations.migrate = async (entry, snapshot) => ({ ...await migrate(entry, snapshot), service_started: entry.uid === 1001 })
  const result = await f.run()
  assert.equal(result.exit_code, 1); assert.equal(result.results[0].state, 'unknown')
  assert.equal(f.calls.includes('register:1001'), false); assert.equal(f.calls.includes('startTarget:1001'), false)
  assert.equal(f.calls.includes('startTarget:1002'), true)
})
