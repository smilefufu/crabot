import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { handoffDesktopPair } from '../dist/paired-handoff.js'

function fixture() {
  const app = new EventEmitter(), calls = [], target = { executable: '/verified/target', dataDir: '/same/data' }
  app.relaunch = options => { calls.push(['relaunch', options]) }
  app.quit = () => { calls.push('quit'); app.emit('will-quit'); app.emit('quit') }
  const options = { app, target, verify: async actual => { assert.equal(actual, target); calls.push('verified') },
    beginExit: () => { calls.push('exit-mode'); return () => { calls.push('undo-exit') } } }
  return { app, calls, options }
}
test('handoff verifies selected target before suppressing ordinary stop and relaunches with no inherited arguments', async () => {
  const f = fixture(); await handoffDesktopPair(f.options)
  assert.deepEqual(f.calls, ['verified', 'exit-mode', ['relaunch', { execPath: f.options.target.executable, args: [] }], 'quit'])
  assert.equal(f.app.listenerCount('quit'), 0)
})
test('an unverified target never enters exit mode, relaunches or quits', async () => {
  const f = fixture(); f.options.verify = async () => { throw new Error('Target pair changed') }
  await assert.rejects(handoffDesktopPair(f.options), /Target pair changed/)
  assert.deepEqual(f.calls, []); assert.equal(f.app.listenerCount('quit'), 0)
})
test('failed relaunch restores the ordinary exit handler and removes its listener', async () => {
  const f = fixture(); f.app.relaunch = () => { throw new Error('Relaunch unavailable') }
  await assert.rejects(handoffDesktopPair(f.options), /Relaunch unavailable/)
  assert.deepEqual(f.calls, ['verified', 'exit-mode', 'undo-exit'])
  assert.equal(f.app.listenerCount('quit'), 0)
})
test('a cancelled application quit cannot report a completed GUI handoff', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(); f.app.quit = () => { f.calls.push('quit-cancelled'); f.app.emit('will-quit') }
  const pending = handoffDesktopPair(f.options)
  await new Promise(resolve => setImmediate(resolve))
  const rejected = assert.rejects(pending, { code: 'CRABOT_DESKTOP_HANDOFF' })
  t.mock.timers.tick(180_000); await rejected
  assert.equal(f.calls.at(-1), 'undo-exit'); assert.equal(f.app.listenerCount('quit'), 0)
})
