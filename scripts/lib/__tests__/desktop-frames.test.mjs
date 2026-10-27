import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import frames from '../desktop-frames.cjs'

test('fragmented UTF-8 and an early next handshake frame retain their exact JSON value', async t => {
  const socket = new PassThrough(), channel = new frames.DesktopFrames(socket)
  t.after(() => channel.close())
  const message = { challenge: '中文挑战', instance_id: 'exact-instance' }, bytes = Buffer.from(JSON.stringify(message) + '\n')
  const split = bytes.indexOf(Buffer.from('中')) + 1
  socket.write(bytes.subarray(0, split)); socket.write(bytes.subarray(split))
  assert.deepEqual(await channel.read(), message)
  socket.write(Buffer.from('{"type":"session","generation":"next-step"}\n'))
  assert.deepEqual(await channel.read(), { type: 'session', generation: 'next-step' })
})

test('another pending read is rejected without consuming the original handshake response', async t => {
  const socket = new PassThrough(), channel = new frames.DesktopFrames(socket)
  t.after(() => channel.close())
  const original = channel.read()
  await assert.rejects(channel.read(), /already pending/)
  socket.write(Buffer.from('{"verified":true}\n'))
  assert.deepEqual(await original, { verified: true })
})

for (const [kind, bytes] of [
  ['invalid UTF-8', Buffer.from([0xc3, 0x28, 0x0a])],
  ['malformed JSON', Buffer.from('{\n')],
  ['extra frames', Buffer.from('{}\n{}\n')],
  ['oversized frame', Buffer.alloc(65537, 0x20)],
]) test('invalid desktop transport closes the connection: ' + kind, async () => {
  const socket = new PassThrough(), channel = new frames.DesktopFrames(socket)
  socket.write(bytes)
  await assert.rejects(channel.read(), /Invalid desktop frame/)
  assert.equal(socket.destroyed, true)
  channel.close()
})

test('oversized outgoing data is never written and ending a handshake releases its pending reader', async () => {
  const socket = new PassThrough(), channel = new frames.DesktopFrames(socket)
  let written = false; socket.on('data', () => { written = true })
  assert.throws(() => channel.write({ value: 'x'.repeat(65536) }), /64 KiB/)
  assert.equal(written, false)
  const pending = assert.rejects(channel.read(), /handshake ended/)
  channel.close(); await pending
  assert.equal(socket.destroyed, true)
})
