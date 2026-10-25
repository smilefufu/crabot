import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import native from '../process-identity.cjs'
import { probeKnownProcessExit } from '../known-process-exit.cjs'

async function fixture(t) {
  const child = spawn(process.execPath, ['-e', 'process.send("ready");process.on("message",()=>process.send("pong"));const timer=setInterval(()=>{},1000);setTimeout(()=>clearInterval(timer),30000)'], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  })
  const ended = once(child, 'exit')
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await ended })
  await once(child, 'message')
  return { child, expected: native.inspectProcess(child.pid), ended }
}
async function live(child) { const replied = once(child, 'message'); child.send('ping'); const [message] = await replied; assert.equal(message, 'pong') }
async function gone(expected) {
  const deadline = Date.now() + 5000
  while (probeKnownProcessExit([expected]).state !== 'stopped') {
    assert.ok(Date.now() < deadline, 'kernel exit was not confirmed')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('unknown generations and foreign owners never receive a termination request', async t => {
  const { child, expected } = await fixture(t)
  assert.equal(native.terminateKnownProcess({ ...expected, started: 'a-different-generation' }), false)
  await live(child)
  assert.throws(() => native.terminateKnownProcess({ ...expected, owner: 'a-different-owner' }), { code: 'CRABOT_PROCESS_SIGNAL' })
  await live(child)
})
test('only the recorded generation is targeted; submission still needs independent exit evidence', async t => {
  const { expected, ended } = await fixture(t)
  assert.equal(native.terminateKnownProcess(expected), true)
  await ended; await gone(expected)
  assert.equal(native.terminateKnownProcess(expected), false)
})
test('a changed image/old parent field is not mistaken for the original generation being gone', async t => {
  const { expected, ended } = await fixture(t)
  assert.equal(native.terminateKnownProcess({ ...expected, executable: expected.executable + '.previous-image', parent: 1 }), true)
  await ended; await gone(expected)
})
test('self, malformed and incomplete identities are rejected without sending any signal', () => {
  const self = native.inspectProcess(process.pid)
  for (const value of [null, {}, [], self, { ...self, pid: 0 }, { ...self, pid: -1 }, { ...self, pid: 1.5 },
    { ...self, pid: '1' }, { ...self, started: '' }, { ...self, owner: '' }, { ...self, executable: '' },
    { ...self, parent: -1 }, { ...self, started: 'embedded\0value' }, { ...self, command: 'do not accept arbitrary commands' }]) {
    assert.throws(() => native.terminateKnownProcess(value), { code: 'CRABOT_PROCESS_SIGNAL' })
  }
  assert.equal(native.isProcessExited(process.pid), false)
})
