import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import native from '../process-identity.cjs'
import { captureOwnedProcessTree } from '../owned-process-tree.cjs'
import { probeKnownProcessExit } from '../known-process-exit.cjs'

const info = (pid, parent = 1, started = '100', owner = 'self') => ({ pid, parent, started, owner, executable: '/fixture/node' })
function fixture() {
  const values = new Map([[11, info(11)], [12, info(12, 11, '101')], [13, info(13, 12, '102')]])
  const children = new Map([[11, [12]], [12, [13]], [13, []]]), queried = []
  const api = { inspectProcess(pid) {
    if (pid === process.pid) return info(pid)
    queried.push(pid)
    const value = values.get(pid)
    if (value instanceof Error) throw value
    return value ?? null
  }, listChildProcessIds(pid) { const value = children.get(pid); if (value instanceof Error) throw value; return value } }
  return { values, children, queried, api }
}

test('captures a transitive kernel-owned tree from a verified root and returns immutable identity facts only', () => {
  const f = fixture(), result = captureOwnedProcessTree([info(11)], f.api)
  assert.deepEqual(result.map(item => item.pid), [11, 12, 13])
  assert.ok(Object.isFrozen(result) && result.every(Object.isFrozen))
  assert.deepEqual(Object.keys(result[0]).sort(), ['executable', 'owner', 'parent', 'pid', 'started'])
})

for (const failure of ['reused root', 'foreign root', 'foreign child', 'older child', 'reparented child', 'missing child', 'unreadable child', 'unreadable list', 'truncated list', 'cycle', 'equal-birth cycle', 'duplicate child', 'invalid birth', 'self root', 'self descendant']) test('refuses unverified ancestry without returning a partial tree: ' + failure, () => {
  const f = fixture(), roots = [info(11)]
  if (failure === 'reused root') f.values.set(11, info(11, 1, '200'))
  if (failure === 'foreign root') f.values.set(11, info(11, 1, '100', 'other'))
  if (failure === 'foreign child') f.values.set(12, info(12, 11, '101', 'other'))
  if (failure === 'older child') f.values.set(12, info(12, 11, '99'))
  if (failure === 'reparented child') f.values.set(12, info(12, 1, '101'))
  if (failure === 'missing child') f.values.delete(12)
  if (failure === 'unreadable child') f.values.set(12, new Error('unknown process'))
  if (failure === 'unreadable list') f.children.set(11, new Error('unknown list'))
  if (failure === 'truncated list') f.children.set(11, undefined)
  if (failure === 'cycle') { f.children.set(13, [11]); f.values.set(11, info(11, 13)) }
  if (failure === 'equal-birth cycle') { for (const [pid, item] of f.values) f.values.set(pid, { ...item, started: '100' }); f.children.set(13, [11]); f.values.set(11, info(11, 13)) }
  if (failure === 'duplicate child') f.children.set(11, [12, 12])
  if (failure === 'invalid birth') f.values.set(12, info(12, 11, 'not a kernel timestamp'))
  if (failure === 'self root') roots[0] = info(process.pid)
  if (failure === 'self descendant') { f.children.set(11, [process.pid]); f.values.set(process.pid, info(process.pid, 11, '101')) }
  assert.throws(() => captureOwnedProcessTree(roots, f.api), { code: 'CRABOT_PROCESS_SCOPE' })
})

test('an image change in the same kernel generation remains inside the captured set', () => {
  const f = fixture(); f.values.set(11, { ...info(11), executable: '/fixture/after-exec' })
  assert.equal(captureOwnedProcessTree([info(11)], f.api)[0].executable, '/fixture/after-exec')
})

test('an identity change while reading children rejects the entire observation', () => {
  const f = fixture(), read = f.api.listChildProcessIds
  f.api.listChildProcessIds = pid => { const children = read(pid); if (pid === 11) f.values.set(11, info(11, 1, '200')); return children }
  assert.throws(() => captureOwnedProcessTree([info(11)], f.api), { code: 'CRABOT_PROCESS_SCOPE' })
})

for (const [parent, child, valid] of [['100:9', '100:10', true], ['100:10', '100:9', false], ['100', '100', true],
  ['133710000000000000', '133710000000000001', true], ['133710000000000001', '133710000000000000', false]]) test('kernel birth ordering compares exact integers: ' + parent + '/' + child, () => {
  const f = fixture(); f.values.set(11, info(11, 1, parent)); f.values.set(12, info(12, 11, child)); f.children.set(12, [])
  if (valid) assert.equal(captureOwnedProcessTree([info(11, 1, parent)], f.api).length, 2)
  else assert.throws(() => captureOwnedProcessTree([info(11, 1, parent)], f.api), { code: 'CRABOT_PROCESS_SCOPE' })
})

test('reads the actual controlled child and grandchild without observing unrelated processes', async t => {
  const inner = `process.send('ready');const timer=setInterval(()=>{},1000);setTimeout(()=>clearInterval(timer),30000)`
  const outer = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(inner)}],{detached:true,stdio:['ignore','ignore','inherit','ipc']});child.once('message',()=>process.send({child:child.pid}));process.on('message',message=>{if(message==='orphan')process.exit(0);child.once('exit',()=>process.exit(0));child.kill()});setInterval(()=>{},1000)`
  const root = spawn(process.execPath, ['-e', outer], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  const ended = once(root, 'exit')
  let childInfo
  t.after(async () => {
    if (root.exitCode === null && root.signalCode === null) { root.send('finish'); await ended }
    if (childInfo) {
      const deadline = Date.now() + 5000
      let signalled = false
      while (probeKnownProcessExit([childInfo]).state !== 'stopped') {
        assert.ok(Date.now() < deadline, 'controlled descendant did not exit')
        let current
        try { current = native.inspectProcess(childInfo.pid) } catch { /* Keep unknown until kernel exit or a readable identity. */ }
        if (!signalled && native.sameProcess(childInfo, current)) {
          try { process.kill(childInfo.pid, 'SIGKILL'); signalled = true }
          catch (error) { if (error.code !== 'ESRCH') throw error }
        }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
  })
  const [{ child }] = await once(root, 'message'), expected = native.inspectProcess(root.pid)
  const result = captureOwnedProcessTree([expected])
  assert.deepEqual(result.map(item => item.pid).sort((a, b) => a - b), [root.pid, child].sort((a, b) => a - b))
  assert.ok(result.every(item => item.owner === expected.owner))
  childInfo = result.find(item => item.pid === child)
  root.send('orphan'); await ended
  const deadline = Date.now() + 5000
  let observed
  do {
    observed = probeKnownProcessExit(result)
    if (observed.state !== 'unknown') break
    assert.ok(Date.now() < deadline, 'kernel exit evidence remains unknown')
    await new Promise(resolve => setTimeout(resolve, 10))
  } while (true)
  assert.deepEqual(observed, { state: 'running', running_pids: [child], unknown_pids: [] })
})


test('refuses an over-capacity or sparse root set without inspecting any target or returning a truncated result', () => {
  const f = fixture()
  for (const roots of [Array(32769).fill(info(11)), Array(1)]) {
    assert.throws(() => captureOwnedProcessTree(roots, f.api), { code: 'CRABOT_PROCESS_SCOPE' })
    assert.deepEqual(f.queried, [])
  }
})

test('a child that reparents during capture cannot silently leave a partial successful snapshot', () => {
  const f = fixture(), read = f.api.listChildProcessIds
  f.api.listChildProcessIds = pid => { const children = read(pid); if (pid === 13) f.values.set(12, info(12, 1, '101')); return children }
  assert.throws(() => captureOwnedProcessTree([info(11)], f.api), { code: 'CRABOT_PROCESS_SCOPE' })
})


for (const newline of ['', '\n']) test('Linux boot identity and ticks remain opaque while creation ordering uses integer ticks: ' + JSON.stringify(newline), () => {
  const f = fixture(), boot = '11111111-1111-4111-8111-111111111111' + newline
  f.values.set(11, info(11, 1, boot + ':100')); f.values.set(12, info(12, 11, boot + ':101')); f.children.set(12, [])
  assert.equal(captureOwnedProcessTree([info(11, 1, boot + ':100')], f.api).length, 2)
})
test('processes from different Linux boots cannot share an ancestry observation even when ticks look newer', () => {
  const f = fixture(), root = info(11, 1, '11111111-1111-4111-8111-111111111111\n:100')
  f.values.set(11, root); f.values.set(12, info(12, 11, '22222222-2222-4222-8222-222222222222\n:101')); f.children.set(12, [])
  assert.throws(() => captureOwnedProcessTree([root], f.api), { code: 'CRABOT_PROCESS_SCOPE' })
})
