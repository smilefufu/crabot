import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { registerDesktopIpc } from '../dist/desktop-ipc.js'

function fixture(selectWorkspace) {
  const handlers = new Map(), frame = { parent: null, origin: 'app://crabot', url: 'app://crabot/', processId: 1, routingId: 2 }
  const contents = { id: 1, mainFrame: frame, isDestroyed: () => false }, event = { sender: { id: 1 }, senderFrame: frame }
  const remove = registerDesktopIpc({ ipc: { handle: (name, run) => handlers.set(name, run), removeHandler: name => handlers.delete(name) },
    contents: () => contents, controller: { host: { snapshot: () => ({}) } }, selectWorkspace })
  return { invoke: (...args) => handlers.get('desktop:select-workspace-directory')(...args), contents, event, remove, handlers }
}
test('directory selection rejects foreign callers and arguments before presenting a dialog', async () => {
  let calls = 0
  const f = fixture(async () => { calls++; return tmpdir() })
  assert.throws(() => f.invoke({ ...f.event, sender: { id: 2 } }))
  assert.throws(() => f.invoke(f.event, { target: '/injected' }))
  assert.throws(() => f.invoke({ ...f.event, senderFrame: { ...f.event.senderFrame, parent: {} } }))
  assert.equal(calls, 0)
  assert.equal(await f.invoke(f.event), tmpdir()); assert.equal(calls, 1)
  f.remove(); assert.equal(f.handlers.size, 0)
})
test('directory selection revalidates the original top-level frame after its asynchronous dialog', async () => {
  let finish
  const f = fixture(() => new Promise(resolve => { finish = resolve }))
  const pending = f.invoke(f.event)
  f.contents.mainFrame = { ...f.contents.mainFrame, routingId: 3 }
  finish(path.join(tmpdir(), 'selected'))
  await assert.rejects(pending, /Desktop request rejected/)
})
test('malformed selected-directory results never pass the host IPC schema', async () => {
  for (const result of ['', 'relative/path', 'https://untrusted/path', 'bad\0path', 'x'.repeat(32769), { path: tmpdir() }, [tmpdir()]]) {
    const f = fixture(async () => result)
    await assert.rejects(f.invoke(f.event)); f.remove()
  }
  const f = fixture(async () => null)
  assert.equal(await f.invoke(f.event), null); f.remove()
})
