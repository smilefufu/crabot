import test from 'node:test'
import assert from 'node:assert/strict'
import { runRemovalOperation } from '../dist/removal-operation.js'

function fixture(failingStage, choice = 'retry') {
  let phase = 'preparing', failed = false, abort, cancellationFails = false
  const calls = [], counts = new Map()
  const action = name => async () => {
    calls.push(name); counts.set(name, (counts.get(name) || 0) + 1)
    if (name === failingStage && !failed) { failed = true; throw Object.assign(new Error('fixture failure'), { code: 'EIO' }) }
  }
  const stop = async () => { await action('stop')(); phase = 'stopping' }
  const exit = action('exit')
  const remove = async (signal, beforeRemoving) => {
    await action('remove')()
    if (phase === 'stopping') { signal.throwIfAborted(); beforeRemoving(); phase = 'removing' }
    return { retained: [] }
  }
  const options = {
    lease: { current: async () => ({ phase }), stop, retryStop: stop, exitSource: exit, retrySourceExit: exit,
      removePrograms: remove, retryRemovePrograms: remove,
      cancel: async () => { calls.push('cancel'); assert.equal(phase, 'stopping'); if (cancellationFails) throw new Error('cannot settle'); phase = 'cancelled' },
      close: () => calls.push('release') },
    openProgress: async controller => { abort = controller; calls.push('open'); return { update: (message, allowCancel) => {
      assert.equal(typeof message, 'string'); if (!allowCancel) calls.push('uncancellable')
    }, close: async () => { calls.push('close') } } },
    decide: async ({ canCancel, code }) => { calls.push('decide'); assert.equal(typeof canCancel, 'boolean'); assert.equal(typeof code, 'string'); return choice },
    removeEntries: action('entries'), finish: async () => { await action('finish')(); phase = 'completed' },
  }
  return { options, calls, counts, phase: () => phase, abort: () => abort.abort(), forbidCancellation: () => { cancellationFails = true } }
}

test('removal operation closes display and releases locks after ordered completion', async () => {
  const f = fixture()
  assert.equal(await runRemovalOperation(f.options), 'completed')
  assert.deepEqual(f.calls, ['open', 'stop', 'exit', 'remove', 'uncancellable', 'uncancellable', 'entries', 'uncancellable', 'finish', 'close', 'release'])
})
for (const stage of ['stop', 'exit', 'remove', 'entries', 'finish']) test('retry resumes only the failed removal stage: ' + stage, async () => {
  const f = fixture(stage)
  assert.equal(await runRemovalOperation(f.options), 'completed')
  for (const name of ['stop', 'exit', 'remove', 'entries', 'finish']) assert.equal(f.counts.get(name), name === stage ? 2 : 1)
  assert.equal(f.calls.filter(value => value === 'decide').length, 1)
  assert.equal(f.calls.filter(value => value === 'close').length, 2)
})
test('cancel during source exit verifies cancellation and never enters removal', async () => {
  const f = fixture(), exit = f.options.lease.exitSource
  f.options.lease.exitSource = async () => { await exit(); f.abort() }
  assert.equal(await runRemovalOperation(f.options), 'cancelled')
  assert.equal(f.phase(), 'cancelled'); assert.equal(f.counts.has('remove'), false)
  assert.equal(f.calls.at(-1), 'release')
})
test('a signal arriving after removing cannot cancel or interrupt entry settlement', async () => {
  const f = fixture(), remove = f.options.lease.removePrograms
  f.options.lease.removePrograms = async (...args) => { const result = await remove(...args); f.abort(); return result }
  assert.equal(await runRemovalOperation(f.options), 'completed')
  assert.equal(f.calls.includes('cancel'), false); assert.equal(f.phase(), 'completed')
})
test('unknown cancellation result retains the job and allows closing without false success', async () => {
  const f = fixture('exit', 'close'); f.forbidCancellation()
  const original = f.options.lease.exitSource
  f.options.lease.exitSource = async () => { f.abort(); return original() }
  assert.equal(await runRemovalOperation(f.options), 'retained')
  assert.equal(f.phase(), 'stopping'); assert.equal(f.counts.has('remove'), false)
  assert.equal(f.calls.includes('cancel'), true); assert.equal(f.calls.at(-1), 'release')
})
test('a retained program prevents all entry cleanup and completion', async () => {
  const f = fixture(undefined, 'close')
  f.options.lease.removePrograms = async (_signal, beforeRemoving) => { beforeRemoving(); return { retained: ['custom'] } }
  assert.equal(await runRemovalOperation(f.options), 'retained')
  assert.equal(f.counts.has('entries'), false); assert.equal(f.counts.has('finish'), false)
})
