import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, connect } from 'node:net'
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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

for (const host of ['127.0.0.1', '::1']) test('TCP listener ownership comes from the OS for ' + host, { timeout: 20_000 }, async t => {
  const server = createServer()
  t.after(() => new Promise(resolve => server.close(resolve)))
  server.listen(0, host); await once(server, 'listening')
  const port = server.address().port
  assert.ok(identity.listListeningTcpPorts(process.pid).includes(port))
  const child = spawn(process.execPath, ['-e', 'require("node:net").createServer().listen(0,"127.0.0.1",function(){process.send(this.address().port)})'], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  })
  t.after(async () => { const exited = once(child, 'exit'); child.kill(); await exited })
  const [otherPort] = await once(child, 'message')
  assert.ok(identity.listListeningTcpPorts(child.pid).includes(otherPort))
  assert.equal(identity.listListeningTcpPorts(process.pid).includes(otherPort), false)
  assert.equal(identity.listListeningTcpPorts(child.pid).includes(port), false)
  await new Promise(resolve => server.close(resolve))
  assert.equal(identity.listListeningTcpPorts(process.pid).includes(port), false)
  for (const invalid of [0, -1, NaN, '1']) assert.throws(() => identity.listListeningTcpPorts(invalid))
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

test('installation filesystem facts come from the actual OS without changing target permissions', t => {
  const directory = mkdtempSync(join(tmpdir(), 'crabot-install-volume-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const before = statSync(directory), facts = identity.inspectInstallFilesystem(directory)
  assert.equal(typeof facts.supported, 'boolean'); assert.ok(facts.filesystem)
  assert.deepEqual(statSync(directory), before)
  for (const invalid of ['', 'bad\0path', 1, null]) assert.throws(() => identity.inspectInstallFilesystem(invalid), { code: 'CRABOT_INSTALL_FILESYSTEM' })
  assert.throws(() => identity.inspectInstallFilesystem(join(directory, 'missing')), { code: 'CRABOT_INSTALL_FILESYSTEM' })
  const file = join(directory, 'ordinary-file'); writeFileSync(file, 'keep')
  assert.throws(() => identity.inspectInstallFilesystem(file), { code: 'CRABOT_INSTALL_FILESYSTEM' })
})
