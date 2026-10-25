import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import native from '../process-identity.cjs'
import { probeKnownProcessExit } from '../known-process-exit.cjs'

const processInfo = (pid, started = 'born', owner = 'self', executable = '/fixture/node') => ({ pid, parent: 1, owner, started, executable })
function fixture() {
  const queried = [], values = new Map(), exited = new Map()
  const api = { inspectProcess(pid) {
    if (pid === process.pid) return processInfo(pid)
    queried.push(pid)
    const value = values.get(pid)
    if (value instanceof Error) throw value
    return value ?? null
  }, isProcessExited(pid) {
    const value = exited.get(pid)
    if (value instanceof Error) throw value
    return value
  } }
  return { queried, values, exited, api }
}

test('keeps an observed child active after its recorded parent has exited', () => {
  const f = fixture(), parent = processInfo(11), child = processInfo(12)
  f.exited.set(parent.pid, true); f.values.set(child.pid, { ...child, parent: 1 })
  assert.deepEqual(probeKnownProcessExit([parent, child], f.api), { state: 'running', running_pids: [12], unknown_pids: [] })
  f.values.delete(child.pid); f.exited.set(child.pid, true)
  assert.equal(probeKnownProcessExit([parent, child], f.api).state, 'stopped')
})
test('old PID generations end without adopting or signalling the replacement', () => {
  const f = fixture(), old = processInfo(11)
  f.values.set(11, processInfo(11, 'replacement', 'another-user'))
  assert.deepEqual(probeKnownProcessExit([old], f.api), { state: 'stopped', running_pids: [], unknown_pids: [] })
})
test('same kernel creation identity with a different executable is still active', () => {
  const f = fixture(), old = processInfo(11)
  f.values.set(11, { ...old, executable: '/fixture/different-image' })
  assert.equal(probeKnownProcessExit([old], f.api).state, 'running')
})
for (const failure of ['missing image', 'unreadable image', 'unreadable exit', 'missing exit helper', 'changed owner', 'malformed identity', 'missing owner in new generation', 'missing image in new generation', 'invalid exit result']) test('insufficient evidence remains unknown: ' + failure, () => {
  const f = fixture(), target = processInfo(11)
  f.exited.set(11, false)
  if (failure === 'unreadable image') f.values.set(11, new Error('cannot read image'))
  if (failure === 'unreadable exit') f.exited.set(11, new Error('cannot query exit'))
  if (failure === 'missing exit helper') delete f.api.isProcessExited
  if (failure === 'changed owner') f.values.set(11, processInfo(11, 'born', 'other'))
  if (failure === 'malformed identity') f.values.set(11, { ...target, started: '' })
  if (failure === 'missing owner in new generation') f.values.set(11, { ...target, started: 'replacement', owner: '' })
  if (failure === 'missing image in new generation') f.values.set(11, { ...target, started: 'replacement', executable: '' })
  if (failure === 'invalid exit result') f.exited.set(11, 'true')
  assert.deepEqual(probeKnownProcessExit([target], f.api), { state: 'unknown', running_pids: [], unknown_pids: [11] })
})
test('an OS-confirmed exited process does not require an available image', () => {
  const f = fixture(), target = processInfo(11)
  f.values.set(11, new Error('image already gone')); f.exited.set(11, true)
  assert.equal(probeKnownProcessExit([target], f.api).state, 'stopped')
})
test('rejects malformed/sparse or foreign-owner sets before inspecting target PIDs', () => {
  const f = fixture()
  for (const values of [[processInfo(11, 'born', 'another')], [processInfo(0)], [null], new Array(1)]) {
    assert.throws(() => probeKnownProcessExit(values, f.api), { code: 'CRABOT_PROCESS_IDENTITY' })
  }
  assert.deepEqual(f.queried, [])
})

test('real POSIX exec changes the image without making the original process disappear', { skip: process.platform === 'win32', timeout: 15_000 }, async t => {
  const child = spawn('/bin/sh', ['-c', 'printf ready; IFS= read -r value; exec "$1" -e "$2"', 'sh', process.execPath, 'setInterval(() => {}, 1000)'], { stdio: ['pipe', 'pipe', 'inherit'] })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited }
    child.stdin.destroy(); child.stdout.destroy()
  })
  await once(child.stdout, 'data')
  const before = native.inspectProcess(child.pid)
  assert.equal(native.isProcessExited(child.pid), false)
  child.stdin.write('continue\n')
  const deadline = Date.now() + 5000
  let current
  do { current = native.inspectProcess(child.pid); if (current?.executable !== before.executable) break; await new Promise(resolve => setTimeout(resolve, 20)) } while (Date.now() < deadline)
  assert.ok(current && current.executable !== before.executable)
  assert.equal(current.started, before.started)
  assert.equal(probeKnownProcessExit([before]).state, 'running')
})


test('real parent exit keeps an observed detached child in the exit proof', { timeout: 15_000 }, async t => {
  const source = `const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
    child.once('spawn', () => process.send(child.pid)); child.unref();
    process.on('message', () => process.exit(0));`
  const parent = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  let leaf
  const stopLeaf = () => {
    if (!leaf) return
    const current = native.inspectProcess(leaf.pid)
    if (current && current.started === leaf.started && current.owner === leaf.owner) process.kill(leaf.pid, 'SIGTERM')
  }
  t.after(async () => {
    if (parent.exitCode === null && parent.signalCode === null) { const exited = once(parent, 'exit'); parent.kill(); await exited }
    stopLeaf()
    const deadline = Date.now() + 5000
    while (leaf && !native.isProcessExited(leaf.pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    if (leaf) assert.equal(native.isProcessExited(leaf.pid), true, 'controlled child must exit before fixture cleanup')
  })
  const [pid] = await once(parent, 'message'), root = native.inspectProcess(parent.pid)
  leaf = native.inspectProcess(pid)
  const exited = once(parent, 'exit'); parent.send('orphan'); await exited
  assert.equal(native.isProcessExited(root.pid), true)
  assert.deepEqual(probeKnownProcessExit([root, leaf]), { state: 'running', running_pids: [leaf.pid], unknown_pids: [] })
  stopLeaf()
  const deadline = Date.now() + 5000
  while (!native.isProcessExited(leaf.pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(probeKnownProcessExit([root, leaf]), { state: 'stopped', running_pids: [], unknown_pids: [] })
})
