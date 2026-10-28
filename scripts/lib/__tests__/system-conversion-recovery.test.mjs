import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { planSystemConversion } from '../system-conversion.mjs'
import { systemRecoveryOptions, executeSystemRecovery } from '../system-recovery.mjs'
const source = { version: 'v2026.10.15.1', installRoot: '/opt/legacy', code_fingerprint: 'a'.repeat(64) }
function fixture() {
  const instances = [1001, 1002].map((uid, i) => {
    const entry = { user: 'employee' + uid, uid, gid: uid, home: '/home/user' + uid, data_dir: '/home/user' + uid + '/.crabot/data-' + (i + 1) * 100,
      port_offset: (i + 1) * 100, enabled: true, autostart: false }
    const running = i === 0
    const observation = { user: entry.user, uid, port_offset: entry.port_offset, data_dir: entry.data_dir, data_directory: { device: '1', inode: String(uid) },
      install_root: source.installRoot, code_fingerprint: source.code_fingerprint, manifest_fingerprint: 'b'.repeat(64),
      runtime_state: running ? 'running' : 'stopped', data_binding: running ? 'observed_running' : 'verified_stopped' }
    if (running) Object.assign(observation, { controller: { pid: 71001, parent: 1, owner: String(uid), started: 'original-controller', executable: '/usr/bin/node' },
      mm: { pid: 71002, parent: 71001, owner: String(uid), started: 'original-mm', executable: '/usr/bin/node' }, mm_port: 19100, launch_kind: 'daemon' })
    return { entry, observation }
  })
  const plan = planSystemConversion({ installRoot: '/opt/legacy/.managed', source, target: { id: 'c'.repeat(64), version: '1.2.4' }, instances })
  const prior = { schema_version: 1, kind: 'conversion', id: plan.id, phase: 'interrupted', stage: 'service_configure_dispatched', source_fence_id: randomUUID(),
    results: instances.map(({ entry, observation }) => ({ uid: entry.uid, user: entry.user, originally_running: observation.runtime_state === 'running',
      resume_required: observation.runtime_state === 'running', stopped: true, stop_dispatched: observation.runtime_state === 'running', snapshot_dispatched: true, migration_dispatched: true, migrated: true,
      registration_dispatched: true, registered: true, configured: true, state: 'pending',
      snapshot: { id: randomUUID(), system_operation_id: plan.id, target_id: plan.target.id, backup: { id: randomUUID(), sha256: 'd'.repeat(64) } } })) }
  const calls = [], saves = [], states = new Map(instances.map(({ entry }) => [entry.uid, { state: 'stopped', generation: null }]))
  const ready = generation => ({ state: 'running', ready: true, generation, core_id: plan.target.id, core_version: plan.target.version })
  const operations = { verifyTargetData: async entry => { calls.push('data-check-' + entry.uid); return { verified: true, service_started: false } }, save: async value => { saves.push(structuredClone(value)) }, verify: async () => { calls.push('verify') },
    observeTarget: async entry => { calls.push('observe-' + entry.uid); return states.get(entry.uid) },
    startTarget: async (entry, previous) => {
      calls.push('start-' + entry.uid); assert.equal(previous.state, 'stopped')
      assert.equal(saves.at(-1).stage, 'target_start_dispatched'); assert.deepEqual(saves.at(-1).allow_start, { uid: entry.uid, core_id: plan.target.id })
      const generation = 'systemd:' + entry.uid; states.set(entry.uid, ready(generation)); return { state: 'started', generation }
    },
    migrate: () => assert.fail('completed conversion recovery never migrates'), snapshot: () => assert.fail('never repeats backup'),
    register: () => assert.fail('never repeats registration'), configure: () => assert.fail('never repeats service configuration'),
    apply: () => assert.fail('not a batch'), selected: () => assert.fail('not a sealed-source upgrade') }
  return { plan, prior, operations, calls, saves, states, ready, run: mode => executeSystemRecovery(plan, prior, { mode, operations }) }
}
test('completed data/configuration recovery only starts the original unissued running set after fresh checks', async () => {
  const f = fixture(); assert.deepEqual(systemRecoveryOptions(f.plan, f.prior), { continue: true, cancel: true })
  const result = await f.run('continue')
  assert.equal(result.exit_code, 0); assert.equal(result.phase, 'completed')
  assert.deepEqual(f.calls.filter(value => value.startsWith('start-')), ['start-1001'])
  assert.deepEqual(result.results.map(row => row.state), ['healthy', 'observed_stopped'])
  assert.equal(result.allow_start, undefined); assert.equal(result.current_uid, undefined)
})
for (const current of ['running', 'stopped']) test('a lost start reply is observed without repeating the issued start: ' + current, async () => {
  const f = fixture(); f.prior.results[0].start_dispatched = true
  if (current === 'running') f.states.set(1001, f.ready('current-target'))
  const result = await f.run('continue')
  assert.equal(result.exit_code, 1); assert.equal(result.results[0].original_action_unknown, true)
  assert.equal(result.results[0].state, 'observed_' + current)
  assert.equal(f.calls.some(value => value.startsWith('start-')), false)
})
test('a user who stopped an already successful target is never revived by continue', async () => {
  const f = fixture(); Object.assign(f.prior.results[0], { state: 'healthy', start_dispatched: true, started: true, generation: 'original-target' })
  const result = await f.run('continue')
  assert.equal(result.results[0].state, 'observed_stopped'); assert.equal(result.exit_code, 0)
  assert.equal(f.calls.some(value => value.startsWith('start-')), false)
})
test('cancel leaves unissued startup stopped and does not undo data, registration or a running target', async () => {
  const f = fixture(); f.states.set(1002, f.ready('later-target'))
  const result = await f.run('cancel')
  assert.equal(result.exit_code, 1); assert.equal(result.results[0].cancelled, true)
  assert.deepEqual(result.results.map(row => row.state), ['observed_stopped', 'observed_running'])
  assert.equal(f.calls.some(value => value.startsWith('start-')), false)
})
for (const changed of ['missing-stop', 'not-migrated', 'not-registered', 'not-configured', 'unknown-migration', 'wrong-receipt', 'missing-fence', 'wrong-original-set', 'wrong-rows']) {
  test('earlier/inconsistent conversion stages cannot reach ordinary UID control: ' + changed, async () => {
    const f = fixture(), row = f.prior.results[0]
    if (changed === 'missing-stop') delete row.stop_dispatched
    if (changed === 'not-migrated') row.migrated = false
    if (changed === 'not-registered') row.registered = false
    if (changed === 'not-configured') row.configured = false
    if (changed === 'unknown-migration') delete row.migrated
    if (changed === 'wrong-receipt') row.snapshot.target_id = 'e'.repeat(64)
    if (changed === 'missing-fence') delete f.prior.source_fence_id
    if (changed === 'wrong-original-set') row.originally_running = false
    if (changed === 'wrong-rows') f.prior.results.reverse()
    await assert.rejects(f.run('continue'), { code: 'CRABOT_SYSTEM_CONVERSION_RECOVERY_REQUIRED' })
    assert.deepEqual(f.calls, []); assert.deepEqual(f.saves, [])
  })
}
for (const changed of ['data-maintenance', 'wrong-core', 'wrong-version', 'not-ready', 'starting', 'observation-error', 'start-error', 'post-start-changed']) {
  test('unknown target facts retain protection without affecting another independent user: ' + changed, async () => {
    const f = fixture()
    if (changed === 'data-maintenance') f.states.set(1001, { state: 'stopped', maintenance: {} })
    if (['wrong-core', 'wrong-version', 'not-ready'].includes(changed)) f.states.set(1001, { ...f.ready('target'),
      ...(changed === 'wrong-core' ? { core_id: 'f'.repeat(64) } : changed === 'wrong-version' ? { core_version: '9.0.0' } : { ready: false }) })
    if (changed === 'starting') f.states.set(1001, { state: 'starting' })
    if (changed === 'observation-error') { const original = f.operations.observeTarget; f.operations.observeTarget = entry => entry.uid === 1001 ? Promise.reject(Error('controlled observation')) : original(entry) }
    if (changed === 'start-error') f.operations.startTarget = async () => { throw Error('controlled startup') }
    if (changed === 'post-start-changed') { const original = f.operations.startTarget; f.operations.startTarget = async (...args) => { const value = await original(...args); f.states.set(1001, f.ready('replacement')); return value } }
    const result = await f.run('continue')
    assert.equal(result.exit_code, 1); assert.equal(result.results[0].state, 'unknown')
    assert.equal(result.results[1].state, 'observed_stopped'); assert.equal(result.allow_start, undefined)
  })
}
test('journal failure cannot dispatch or continue to another UID', async () => {
  const f = fixture(); f.operations.save = async () => { throw Error('controlled journal failure') }
  await assert.rejects(f.run('continue'), { code: 'CRABOT_SYSTEM_JOURNAL_FAILED' })
  assert.deepEqual(f.calls, [])
})

test('failed durable startup intent cannot reach the UID start or later users', async () => {
  const f = fixture(), save = f.operations.save
  f.operations.save = async value => { if (value.allow_start) throw Error('controlled startup intent failure'); return save(value) }
  await assert.rejects(f.run('continue'), { code: 'CRABOT_SYSTEM_JOURNAL_FAILED' })
  assert.equal(f.calls.some(value => value.startsWith('start-')), false)
  assert.equal(f.calls.includes('observe-1002'), false)
})
test('a changed global proof at completion retains maintenance after already observed effects', async () => {
  const f = fixture(); let verification = 0
  f.operations.verify = async () => { if (++verification === 4) throw Error('controlled final root change') }
  const result = await f.run('continue')
  assert.equal(result.phase, 'interrupted'); assert.equal(result.exit_code, 1)
  assert.equal(result.allow_start, undefined); assert.equal(result.current_uid, undefined)
  assert.deepEqual(f.calls.filter(value => value.startsWith('start-')), ['start-1001'])
})

test('a successful root migration receipt cannot bypass current UID schema/backup verification', async () => {
  const f = fixture(); f.operations.verifyTargetData = async entry => { if (entry.uid === 1001) throw Error('actual data no longer matches target'); return { verified: true, service_started: false } }
  const result = await f.run('continue')
  assert.equal(result.results[0].state, 'unknown'); assert.equal(result.results[1].state, 'observed_stopped')
  assert.equal(f.calls.some(value => value.startsWith('start-')), false)
})
