import test from 'node:test'
import assert from 'node:assert/strict'
import { coordinatorStopped, coordinatorUnit, assertCoordinatorStopped, coordinatorRunning, coordinatorIsRunning } from '../system-coordinator.mjs'
const id = '11111111-1111-1111-1111-111111111111'
const text = (patch = {}) => Object.entries({ LoadState: 'loaded', ActiveState: 'inactive', MainPID: '0', TasksCurrent: '0', ControlGroup: '', ...patch }).map(([key, value]) => key + '=' + value).join('\n')
test('a coordinator is settled only when the service and its whole cgroup have ended', () => {
  assert.equal(coordinatorStopped(text()), true)
  assert.equal(coordinatorStopped(text({ LoadState: 'not-found', TasksCurrent: '[not set]' })), true)
  for (const patch of [{ ActiveState: 'active' }, { ActiveState: 'deactivating' }, { MainPID: '123' }, { TasksCurrent: '1' },
    { TasksCurrent: '[not set]', ControlGroup: '/system.slice/old.service' }, { LoadState: 'error' }]) assert.equal(coordinatorStopped(text(patch)), false)
  assert.equal(coordinatorStopped(''), false)
})
test('recovery checks the latest attempt and never accepts arbitrary service names or root environments', async () => {
  assert.equal(coordinatorUnit({ plan: { id } }), 'crabot-operation-' + id)
  assert.equal(coordinatorUnit({ plan: { id }, recovery: { id } }), 'crabot-recovery-' + id)
  assert.throws(() => coordinatorUnit({ plan: { id: 'x; reboot' } }))
  await assertCoordinatorStopped({ plan: { id } }, async (command, args, options) => {
    assert.equal(command, '/usr/bin/systemctl'); assert.equal(args[1], 'crabot-operation-' + id)
    assert.equal(options.env.NODE_OPTIONS, undefined); assert.equal(options.env.HOME, undefined)
    return { stdout: text() }
  })
})
test('leftover helper/migration children and failed observation refuse recovery without any kill', async () => {
  await assert.rejects(assertCoordinatorStopped({ plan: { id } }, async () => ({ stdout: text({ ActiveState: 'failed', TasksCurrent: '1', ControlGroup: '/old' }) })), { code: 'CRABOT_SYSTEM_OPERATION_ACTIVE' })
  await assert.rejects(assertCoordinatorStopped({ plan: { id } }, async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) }), /无法核验/)
  await assertCoordinatorStopped({ plan: { id } }, async () => { throw Object.assign(new Error('unit not loaded'), { code: 1, stdout: text({ LoadState: 'not-found' }) }) })
})


test('a stale maintenance stage cannot authorize a new service after its coordinator has died', async () => {
  const active = text({ ActiveState: 'active', MainPID: '123', TasksCurrent: '2' })
  assert.equal(coordinatorRunning(active), true)
  assert.equal(coordinatorRunning(text()), false)
  assert.equal(coordinatorRunning(text({ ActiveState: 'active', MainPID: '123', TasksCurrent: '[not set]' })), false)
  assert.equal(await coordinatorIsRunning({ id }, async () => ({ stdout: active })), true)
  assert.equal(await coordinatorIsRunning({ id }, async () => ({ stdout: text({ ActiveState: 'failed' }) })), false)
  assert.equal(await coordinatorIsRunning({ id }, async () => { throw new Error('observation unavailable') }), false)
})
