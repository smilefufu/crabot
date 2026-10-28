import test from 'node:test'
import assert from 'node:assert/strict'
import { captureTmuxProcessTree } from '../tmux-process-tree.cjs'
const info = (pid, parent, started = '100', owner = 'self', executable = '/fixture/node') => ({ pid, parent, started, owner, executable })
function fixture() {
  const carrier = { session_name: 'crabot-w-scope', session_id: '$1', pane_id: '%1', pane_pid: 11, dead: false, server_pid: 10 }
  const processes = new Map([[10, info(10, 1, '90', 'self', '/fixture/tmux')], [11, info(11, 10)], [12, info(12, 11, '101')]])
  let reads = 0
  const api = { inspectProcess(pid) { return pid === process.pid ? info(pid, 1, '1') : processes.get(pid) ?? null },
    listChildProcessIds(pid) { return pid === 11 ? [12] : [] } }
  return { carrier, processes, api, read: async () => { reads++; return { ...carrier } }, reads: () => reads }
}

test('binds a fresh exact carrier to its same-owner OS pane tree and excludes the tmux server', async () => {
  const f = fixture(), result = await captureTmuxProcessTree(f.read, f.api)
  assert.deepEqual(result.map(item => item.pid), [11, 12]); assert.equal(f.reads(), 2)
})
for (const failure of ['dead', 'foreign server', 'different parent', 'missing server', 'missing pane', 'unreadable server', 'invalid metadata', 'extra fields']) test('does not adopt an unverifiable carrier: ' + failure, async () => {
  const f = fixture()
  if (failure === 'dead') f.carrier.dead = true
  if (failure === 'foreign server') f.processes.set(10, info(10, 1, '90', 'other'))
  if (failure === 'different parent') f.processes.set(11, info(11, 9))
  if (failure === 'missing server') f.processes.delete(10)
  if (failure === 'missing pane') f.processes.delete(11)
  if (failure === 'unreadable server') { const read = f.api.inspectProcess; f.api.inspectProcess = pid => { if (pid === 10) throw new Error('unknown server'); return read(pid) } }
  if (failure === 'invalid metadata') f.carrier.session_id = '1'
  if (failure === 'extra fields') f.carrier.command = 'must not accept arbitrary command metadata'
  await assert.rejects(captureTmuxProcessTree(f.read, f.api), { code: 'CRABOT_PROCESS_SCOPE' })
})
for (const change of ['session_id', 'pane_id', 'pane_pid', 'server_pid', 'dead', 'server generation', 'pane generation', 'pane parent', 'read failure']) test('rejects a carrier change around OS capture: ' + change, async () => {
  const f = fixture(); let reads = 0
  const read = async () => {
    if (++reads === 2) {
      if (change === 'read failure') throw new Error('tmux lost')
      if (change === 'server generation') f.processes.set(10, info(10, 1, '200', 'self', '/fixture/tmux'))
      else if (change === 'pane generation') f.processes.set(11, info(11, 10, '200'))
      else if (change === 'pane parent') f.processes.set(11, info(11, 1))
      else f.carrier[change] = change.endsWith('_pid') ? 99 : change === 'dead' ? true : 'changed'
    }
    return { ...f.carrier }
  }
  await assert.rejects(captureTmuxProcessTree(read, f.api), { code: 'CRABOT_PROCESS_SCOPE' })
})
test('a same-generation pane exec does not masquerade as exit', async () => {
  const f = fixture(); let reads = 0
  const result = await captureTmuxProcessTree(async () => { if (++reads === 2) f.processes.set(11, info(11, 10, '100', 'self', '/fixture/after-exec')); return { ...f.carrier } }, f.api)
  assert.deepEqual(result.map(item => item.pid), [11, 12])
})

test('does not let a reused mutable carrier object erase the original session identity', async () => {
  const f = fixture(); let reads = 0
  await assert.rejects(captureTmuxProcessTree(async () => { if (++reads === 2) f.carrier.pane_id = '%2'; return f.carrier }, f.api), { code: 'CRABOT_PROCESS_SCOPE' })
})
for (const key of ['session_name', 'session_id', 'pane_id']) test('rejects coerced non-string carrier metadata: ' + key, async () => {
  const f = fixture(); f.carrier[key] = [f.carrier[key]]
  await assert.rejects(captureTmuxProcessTree(f.read, f.api), { code: 'CRABOT_PROCESS_SCOPE' })
})
