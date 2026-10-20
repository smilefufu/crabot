import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import native from '../process-identity.cjs'
import { captureSpawnedProcessTree } from '../spawned-process-tree.cjs'
import { probeKnownProcessExit } from '../known-process-exit.cjs'
import { stopKnownProcessScope } from '../known-process-stop.cjs'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function fixture(t, later = false) {
  const source = `const {spawn}=require('node:child_process'); let child;
    function create(){child=spawn(process.execPath,['-e','setTimeout(()=>{},20000)'],{detached:true,stdio:'ignore'});child.unref()}
    if(!${later})create();process.send('ready');
    process.on('message',()=>{if(!child)create();process.send('stopping');${later ? '' : 'setTimeout(()=>process.exit(0),20)'}});
    setTimeout(()=>process.exit(0),20000);`
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  await once(child, 'message')
  const initial = captureSpawnedProcessTree(child), observed = new Map(initial.map(item => [item.pid, item]))
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      try { for (const item of captureSpawnedProcessTree(child)) observed.set(item.pid, item) } catch {}
    }
    for (const item of observed.values()) native.terminateKnownProcess(item)
    const end = Date.now() + 5000
    while (probeKnownProcessExit([...observed.values()]).state !== 'stopped' && Date.now() < end) await delay(20)
    assert.equal(probeKnownProcessExit([...observed.values()]).state, 'stopped')
  })
  return { child, initial, observed, remember: async items => { for (const item of items) observed.set(item.pid, item) } }
}
test('observed detached descendant is still stopped after its parent exits gracefully', async t => {
  const f = await fixture(t)
  assert.equal(f.initial.length, 2)
  const result = await stopKnownProcessScope(f.initial, { timeoutMs: 80, onObserved: f.remember,
    graceful: async () => { f.child.send('stop'); await once(f.child, 'message') } })
  assert.equal(probeKnownProcessExit(result).state, 'stopped')
  assert.equal(result.length, 2)
})
test('new descendants are acknowledged before they can receive a termination request', async t => {
  const f = await fixture(t, true), submitted = []
  const api = { ...native, terminateKnownProcess(item) {
    assert.deepEqual(f.observed.get(item.pid), item); submitted.push(item.pid); return native.terminateKnownProcess(item)
  } }
  const result = await stopKnownProcessScope(f.initial, { timeoutMs: 80, onObserved: f.remember,
    graceful: async () => { f.child.send('stop'); await once(f.child, 'message') } }, api)
  assert.equal(result.length, 2); assert.equal(submitted.length, 2)
  assert.equal(probeKnownProcessExit(result).state, 'stopped')
})
test('a journal rejection cannot dispatch a graceful or native stop', async t => {
  const f = await fixture(t), calls = []
  await assert.rejects(stopKnownProcessScope(f.initial, { timeoutMs: 30,
    onObserved: async () => { throw new Error('storage failed') }, graceful: async () => calls.push('graceful') },
    { ...native, terminateKnownProcess: () => { calls.push('signal') } }))
  assert.deepEqual(calls, []); assert.equal(probeKnownProcessExit(f.initial).state, 'running')
})
test('unknown metadata does not become successful exit or trigger signals', async t => {
  const f = await fixture(t), calls = []
  const api = { ...native, inspectProcess: pid => pid === process.pid ? native.inspectProcess(pid) : null,
    isProcessExited: () => false, terminateKnownProcess: () => calls.push('signal') }
  await assert.rejects(stopKnownProcessScope(f.initial, { timeoutMs: 30, onObserved: f.remember, graceful: async () => calls.push('graceful') }, api))
  assert.deepEqual(calls, [])
})

test('metadata lost between the exit probe and the active-root read remains unknown', async t => {
  const f = await fixture(t), reads = new Map(), calls = []
  let dropping = false
  const api = { ...native, inspectProcess(pid) {
    if (pid === process.pid || !dropping) return native.inspectProcess(pid)
    const count = (reads.get(pid) ?? 0) + 1; reads.set(pid, count)
    return count === 1 ? native.inspectProcess(pid) : null
  }, isProcessExited: () => false, terminateKnownProcess: () => calls.push('signal') }
  await assert.rejects(stopKnownProcessScope(f.initial, { timeoutMs: 30, onObserved: f.remember,
    graceful: async () => { dropping = true } }, api))
  assert.deepEqual(calls, [])
})

async function delayedShutdownFixture(t) {
  const child = spawn(process.execPath, ['-e', `const {spawn}=require('node:child_process');
    process.send('ready');process.on('message',message=>{
      if(message==='finish')process.exit(0);
      if(message==='stop'){
        const descendant=spawn(process.execPath,['-e','process.send("ready");setTimeout(()=>{},20000)'],{detached:true,stdio:['ignore','ignore','ignore','ipc']});
        descendant.once('message',()=>process.send({descendant:descendant.pid}));descendant.unref();
      }
    });setTimeout(()=>process.exit(0),20000);`], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const ended = once(child, 'exit'), born = new Promise(resolve => child.on('message', message => {
    if (message?.descendant) resolve(native.inspectProcess(message.descendant))
  }))
  await once(child, 'message')
  const initial = captureSpawnedProcessTree(child), observed = new Map(initial.map(item => [item.pid, item]))
  t.after(async () => {
    for (const item of observed.values()) native.terminateKnownProcess(item)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await ended
    const end = Date.now() + 5000
    while (probeKnownProcessExit([...observed.values()]).state !== 'stopped' && Date.now() < end) await delay(20)
    assert.equal(probeKnownProcessExit([...observed.values()]).state, 'stopped')
  })
  return { child, initial, observed, born, ended }
}

test('descendants created while the graceful reply is pending remain observed after their parent exits', async t => {
  const f = await delayedShutdownFixture(t)
  let descendant, requests = 0
  const result = await stopKnownProcessScope(f.initial, { timeoutMs: 80,
    onObserved: async items => {
      for (const item of items) f.observed.set(item.pid, item)
      if (items.length > f.initial.length) {
        descendant = await f.born; f.observed.set(descendant.pid, descendant); f.child.send('finish')
      }
    },
    graceful: async () => {
      requests++; f.child.send('stop'); descendant = await f.born; f.observed.set(descendant.pid, descendant)
      const timer = setTimeout(() => f.child.send('finish'), 2500)
      try { await f.ended } finally { clearTimeout(timer) }
    },
  })
  assert.equal(requests, 1)
  assert.ok(result.some(item => item.pid === descendant.pid), 'the acknowledged scope must retain the detached descendant')
  assert.equal(probeKnownProcessExit(result).state, 'stopped')
  assert.equal(native.isProcessExited(descendant.pid), true)
})

test('a failed new-descendant acknowledgement during graceful shutdown never sends native stops', async t => {
  const f = await delayedShutdownFixture(t), signals = []
  let descendant, requests = 0
  const api = { ...native, terminateKnownProcess: item => { signals.push(item.pid) } }
  await assert.rejects(stopKnownProcessScope(f.initial, { timeoutMs: 80,
    onObserved: async items => {
      for (const item of items) f.observed.set(item.pid, item)
      if (items.length > f.initial.length) {
        descendant = await f.born; f.observed.set(descendant.pid, descendant); throw new Error('journal unavailable')
      }
    },
    graceful: async () => {
      requests++; f.child.send('stop'); descendant = await f.born; f.observed.set(descendant.pid, descendant)
      const timer = setTimeout(() => f.child.send('finish'), 2500)
      try { await f.ended } finally { clearTimeout(timer) }
    },
  }, api), /journal unavailable/)
  assert.equal(requests, 1); assert.deepEqual(signals, [])
  assert.equal(probeKnownProcessExit([descendant]).state, 'running')
})
