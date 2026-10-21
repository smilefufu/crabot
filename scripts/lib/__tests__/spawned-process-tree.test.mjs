import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import native from '../process-identity.cjs'
import { captureSpawnedProcessTree } from '../spawned-process-tree.cjs'
const info = (pid, parent) => ({ pid, parent, owner: 'self', started: '100', executable: '/fixture/node' })
function fixture() {
  const child = { pid: 11, exitCode: null, signalCode: null }, root = info(11, process.pid)
  const api = { inspectProcess(pid) { return pid === process.pid ? info(pid, 1) : pid === 11 ? root : info(12, 11) },
    listChildProcessIds(pid) { return pid === 11 ? [12] : [] } }
  return { child, root, api }
}
test('captures only the actual spawned same-owner child and its descendants', () => {
  const f = fixture(); assert.deepEqual(captureSpawnedProcessTree(f.child, f.api).map(item => item.pid), [11, 12])
})
for (const failure of ['missing pid', 'exited child', 'signalled child', 'foreign owner', 'different parent', 'missing identity', 'exit during observation']) test('unknown spawned carrier cannot become a successful empty scope: ' + failure, () => {
  const f = fixture()
  if (failure === 'missing pid') delete f.child.pid
  if (failure === 'exited child') f.child.exitCode = 0
  if (failure === 'signalled child') f.child.signalCode = 'SIGTERM'
  if (failure === 'foreign owner') f.root.owner = 'other'
  if (failure === 'different parent') f.root.parent = 1
  if (failure === 'missing identity') f.api.inspectProcess = () => null
  if (failure === 'exit during observation') { const read = f.api.listChildProcessIds; f.api.listChildProcessIds = pid => { f.child.exitCode = 0; return read(pid) } }
  assert.throws(() => captureSpawnedProcessTree(f.child, f.api), { code: 'CRABOT_PROCESS_SCOPE' })
})


test('a rejected carrier retains the failing read-only stage without accepting a partial tree', () => {
  const f = fixture(), inspect = f.api.inspectProcess
  f.api.inspectProcess = pid => pid === 12 ? { ...inspect(pid), started: '99' } : inspect(pid)
  assert.throws(() => captureSpawnedProcessTree(f.child, f.api), { code: 'CRABOT_PROCESS_SCOPE', stage: 'child-birth-order' })
})

test('Windows repeatedly captures the actual just-spawned carrier before application readiness', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  for (let attempt = 0; attempt < 64; attempt++) {
    const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_PATH
    const child = spawn(process.execPath, ['-e', 'process.on("message",()=>process.exit(0));process.send("ready");setTimeout(()=>process.exit(4),5000)'],
      { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    child.on('error', () => {})
    const ended = once(child, 'exit'), ready = once(child, 'message')
    try {
      const scope = captureSpawnedProcessTree(child), root = scope.find(item => item.pid === child.pid)
      assert.equal(root.parent, process.pid); assert.ok(native.sameProcess(root, native.inspectProcess(child.pid)))
    } catch (error) {
      let root, children
      try {
        root = native.inspectProcess(child.pid)
        children = native.listChildProcessIds(child.pid).slice(0, 16).map(pid => {
          try { return native.inspectProcess(pid) } catch { return { pid, unavailable: true } }
        })
      } catch { /* Preserve the original failure. */ }
      t.diagnostic(JSON.stringify({ attempt, code: error.code, stage: error.stage, root, children }))
      throw error
    } finally {
      await Promise.race([ready, ended])
      if (child.connected) child.send('finish', () => {})
      await ended
    }
  }
})

for (const stage of ['pinned-open-identity', 'pinned-children-complete', 'pinned-child-ownership', 'pinned-refresh-child-inspect', 'pinned-refresh-parent', 'pinned-refresh-birth']) test('a rejected pinned observation preserves the exact native stage without a fallback: ' + stage, () => {
  const f = fixture(); let calls = 0
  f.api.captureProcessTreeGeneration = () => { calls++; throw Object.assign(new Error('Native observation denied'), { code: 'CRABOT_PROCESS_SCOPE', stage }) }
  f.api.listChildProcessIds = () => { assert.fail('A rejected pinned scope must not fall back to a weaker snapshot') }
  assert.throws(() => captureSpawnedProcessTree(f.child, f.api), { code: 'CRABOT_PROCESS_SCOPE', stage })
  assert.equal(calls, 1)
})
