import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { runOwnSystemCommand } from '../system-own-cli.mjs'
const entry = { user: 'alice', port_offset: 100 }
const running = { state: 'running', generation: 'original' }
const cancelled = () => Object.assign(new Error('cancelled'), { code: 'CRABOT_SYSTEM_START_CANCELLED' })
test('Ctrl+C during startup is registered before dispatch and stops the observed own generation', async () => {
  const signals = new EventEmitter(), calls = []
  await runOwnSystemCommand(entry, 'start', [], { signals, log: () => {}, observe: async () => ({ state: 'starting', generation: 'starting-original' }),
    control: async (_, action, previous, options) => {
      calls.push({ action, previous })
      if (action === 'start') { assert.equal(signals.listenerCount('SIGINT'), 1); signals.emit('SIGINT'); assert.equal(options.signal.aborted, true); throw cancelled() }
      assert.equal(previous.generation, 'starting-original'); return { state: 'stopped' }
    } })
  assert.deepEqual(calls.map(call => call.action), ['start', 'stop'])
  assert.equal(signals.listenerCount('SIGINT'), 0); assert.equal(signals.listenerCount('SIGTERM'), 0)
})
test('startup finishing during cancellation still waits for the exact stop and exposes its failure', async () => {
  const signals = new EventEmitter()
  await assert.rejects(runOwnSystemCommand(entry, 'start', [], { signals, log: () => {}, observe: async () => running,
    control: async (_, action, previous) => {
      if (action === 'start') { signals.emit('SIGTERM'); return { state: 'started' } }
      assert.equal(previous, running); throw new Error('stop result unknown')
    } }), /stop result unknown/)
  assert.equal(signals.listenerCount('SIGTERM'), 0)
})
test('a foreground attachment ends without stopping an independently replaced generation', async () => {
  let probes = 0
  await runOwnSystemCommand(entry, 'start', [], { signals: new EventEmitter(), log: () => {},
    observe: async () => ++probes === 1 ? running : { state: 'running', generation: 'replacement' },
    control: async (_, action) => { assert.equal(action, 'start'); return { state: 'skipped' } } })
  assert.equal(probes, 2)
})
test('a signal arriving during observation still awaits and reports an unknown stop', async () => {
  const signals = new EventEmitter(); let probes = 0
  await assert.rejects(runOwnSystemCommand(entry, 'start', [], { signals, log: () => {},
    observe: async () => { if (++probes === 1) return running; signals.emit('SIGINT'); return { state: 'stopped' } },
    control: async (_, action) => { if (action === 'start') return { state: 'started' }; throw new Error('stop unknown') } }), /stop unknown/)
})
test('background start does not install foreground shutdown handlers or keep the CLI attached', async () => {
  const signals = new EventEmitter()
  await runOwnSystemCommand(entry, 'start', ['-d'], { signals, log: () => {}, observe: () => assert.fail(),
    control: async () => { assert.equal(signals.listenerCount('SIGINT'), 0); return { state: 'started' } } })
})
