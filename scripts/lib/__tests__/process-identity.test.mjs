import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, connect } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import identity from '../process-identity.cjs'

test('native identity includes OS owner, precise creation identity and executable; invalid PIDs fail closed', () => {
  const self = identity.inspectProcess(process.pid)
  assert.equal(self.pid, process.pid)
  assert.ok(self.owner && self.started && self.executable)
  assert.equal(identity.sameProcess(self, identity.inspectProcess(process.pid)), true)
  assert.equal(identity.sameProcess({ ...self, started: 'reused PID' }, self), false)
  assert.ok(identity.listProcessIds().includes(process.pid))
  assert.ok(identity.inspectProcessArguments(process.pid).length > 0)
  for (const pid of [-1, 0, NaN, Infinity, '1', 1.5]) assert.throws(() => identity.inspectProcess(pid))
})

test('OS process arguments preserve Unicode, spaces and empty arguments', async t => {
  const args = ['中文 space', '', 'quote"literal']
  const child = spawn(process.execPath, ['-e', 'process.send("ready");setInterval(()=>{},1000)', ...args], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  t.after(() => child.kill())
  await once(child, 'message')
  assert.deepEqual(identity.inspectProcessArguments(child.pid).slice(-args.length), args)
})

test('Unix local peer is obtained from the OS, not from client-reported PID', { skip: process.platform === 'win32' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'crabot-peer-'))
  const server = createServer(), path = join(directory, 'peer.sock')
  let client
  try {
    server.listen(path); await once(server, 'listening')
    const accepted = once(server, 'connection')
    client = connect(path)
    const [socket] = await accepted
    assert.equal(identity.inspectPeer(socket._handle.fd).pid, process.pid)
    socket.destroy()
  } finally {
    client?.destroy(); await new Promise(resolve => server.close(resolve))
    rmSync(directory, { recursive: true, force: true })
  }
})
