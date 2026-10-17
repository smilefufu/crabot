import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, connect } from 'node:net'
import { mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs'
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

test('read-only directory ownership never substitutes for private bootstrap ACLs', t => {
  const directory = mkdtempSync(join(tmpdir(), 'crabot-owned-directory-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const before = statSync(directory).mode
  assert.equal(identity.isOwnedDirectory(directory), true)
  assert.equal(statSync(directory).mode, before)
  if (process.platform === 'win32') assert.equal(identity.isPrivateDirectory(directory), false)
  else {
    const alias = join(directory, 'alias'); symlinkSync(directory, alias, 'dir')
    assert.equal(identity.isOwnedDirectory(alias), false)
  }
})

test('OS process arguments preserve Unicode, spaces and empty arguments', async t => {
  const args = ['中文 space', '', 'quote"literal']
  const child = spawn(process.execPath, ['-e', 'process.send("ready");setInterval(()=>{},1000)', ...args], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  t.after(() => child.kill())
  await once(child, 'message')
  assert.deepEqual(identity.inspectProcessArguments(child.pid).slice(-args.length), args)
})

test('exit-race identity remains exact or explicitly unknown until the OS confirms absence', async () => {
  for (let i = 0; i < 12; i++) {
    const child = spawn(process.execPath, ['-e', 'process.on("message",()=>process.exit(0));process.send("ready")'], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    })
    const exited = once(child, 'exit')
    await once(child, 'message')
    const expected = identity.inspectProcess(child.pid)
    assert.ok(expected)
    child.send('exit')
    while (child.exitCode === null && child.signalCode === null) {
      try {
        const current = identity.inspectProcess(child.pid)
        if (current) assert.equal(identity.sameProcess(expected, current), true)
      } catch (error) { assert.equal(error.code, 'CRABOT_PROCESS_IDENTITY') }
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    await exited
    const deadline = Date.now() + 2000
    for (;;) {
      try { assert.equal(identity.inspectProcess(child.pid), null); break }
      catch (error) {
        if (error.code !== 'CRABOT_PROCESS_IDENTITY' || Date.now() >= deadline) throw error
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
  }
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
