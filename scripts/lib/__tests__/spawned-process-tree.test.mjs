import test from 'node:test'
import assert from 'node:assert/strict'
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
