import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import transport from '../local-auth-transport.cjs'
import identity from '../process-identity.cjs'

test('Windows native pipe entry points reject arbitrary paths and foreign handle types', { skip: process.platform !== 'win32' }, () => {
  for (const name of ['\\\\remote\\pipe\\x', '\\\\.\\pipe\\arbitrary', '']) assert.throws(() => identity.createPipeServer(name))
  for (const value of [{}, null, 1]) {
    assert.throws(() => identity.acceptPipe(value))
    assert.throws(() => identity.inspectPeer(value))
    assert.throws(() => identity.readPipe(value))
  }
})

test('private local transport identifies both OS peers across processes, ignoring claimed PID; idle accept cancels', { timeout: 15_000 }, async t => {
  const data = mkdtempSync(join(tmpdir(), 'crabot-local-auth-中文 space-'))
  const address = transport.authAddress(data)
  let server, child
  t.after(async () => {
    child?.kill(); await server?.close()
    rmSync(data, { recursive: true, force: true })
    if (process.platform !== 'win32') rmSync(dirname(address), { recursive: true, force: true })
  })
  let peer
  server = await transport.listenLocalAuth(address, (socket, nativePeer) => {
    peer = nativePeer
    socket.on('data', () => socket.end('verified'))
  }, error => { throw error })
  if (process.platform !== 'win32') {
    assert.equal(lstatSync(dirname(address)).mode & 0o777, 0o700)
    assert.equal(lstatSync(address).mode & 0o777, 0o600)
  }
  const source = `import transport from ${JSON.stringify(new URL('../local-auth-transport.cjs', import.meta.url).href)};
    import {once} from 'node:events';
    const {socket,peer}=await transport.connectLocalAuth(process.env.TEST_AUTH_ADDRESS);
    const result=once(socket,'data'); socket.write(JSON.stringify({pid:1}));
    await result;socket.destroy();process.send({peer});process.disconnect();`
  child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, TEST_AUTH_ADDRESS: address }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  })
  const [result] = await once(child, 'message')
  assert.equal(peer.pid, child.pid)
  assert.equal(peer.owner, identity.inspectProcess(process.pid).owner)
  assert.equal(result.peer.pid, process.pid)
  assert.equal(identity.sameProcess(result.peer, identity.inspectProcess(process.pid)), true)
  await once(child, 'exit')
  await server.close(); server = null
})
