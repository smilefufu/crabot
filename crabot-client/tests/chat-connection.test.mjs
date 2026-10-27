import test from 'node:test'
import assert from 'node:assert/strict'
import { ChatConnection } from '../dist/index.js'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
function fixture(options = {}) {
  const sockets = []
  const connection = new ChatConnection({
    url: () => 'ws://localhost/ws/chat', reconnectDelayMs: 1,
    socket: () => { const socket = { readyState: 0, close() { this.readyState = 3 } }; sockets.push(socket); return socket },
    ...options,
  })
  return { connection, sockets }
}

test('one active socket; subscriptions unsubscribe; malformed/unknown events invalidate without entering typed handlers', async () => {
  const { connection, sockets } = fixture()
  let count = 0, invalid = 0
  const unsubscribe = connection.onMessage(() => count++)
  connection.onInvalidation(() => invalid++)
  connection.connect(); await pause(0); connection.connect()
  assert.equal(sockets.length, 1)
  sockets[0].onmessage({ data: '{"type":"chat_message_deleted","message_id":"one"}' })
  sockets[0].onmessage({ data: '{"type":"future-event"}' })
  sockets[0].onmessage({ data: '{"type":"chat_push","message":{}}' })
  assert.equal(count, 1); assert.equal(invalid, 2)
  unsubscribe()
  sockets[0].onmessage({ data: '{"type":"chat_message_deleted","message_id":"two"}' })
  assert.equal(count, 1)
  connection.disconnect()
})

test('replaced chat client never starts a reconnect war; explicit reconnect creates one new socket', async () => {
  const { connection, sockets } = fixture()
  connection.connect(); await pause(0)
  sockets[0].onclose({ code: 1000, reason: 'New connection established' })
  await pause(20)
  assert.equal(connection.status, 'replaced'); assert.equal(sockets.length, 1)
  connection.connect(); await pause(0)
  assert.equal(sockets.length, 2)
  connection.disconnect()
})

test('disconnect cancels pending backoff and a late URL/old socket cannot overwrite a new connection', async () => {
  const { connection, sockets } = fixture()
  connection.connect(); await pause(0)
  sockets[0].onclose({ code: 1006 })
  connection.disconnect(); await pause(10)
  assert.equal(sockets.length, 1)
  connection.connect(); await pause(0)
  sockets[1].readyState = 1; sockets[1].onopen({})
  sockets[0].onclose({ code: 1006 })
  assert.equal(connection.status, 'connected')
  connection.disconnect()
  let resolveUrl
  const late = fixture({ url: () => new Promise(resolve => { resolveUrl = resolve }) })
  late.connection.connect(); late.connection.disconnect(); resolveUrl('ws://localhost')
  await pause(0); assert.equal(late.sockets.length, 0)
})

test('unavailable sockets retry finitely and stay in error until an explicit user/host reconnect', async () => {
  const { connection, sockets } = fixture({ maxReconnectAttempts: 2, socket: () => { throw new Error('unavailable') } })
  connection.connect(); await pause(20)
  assert.equal(connection.status, 'error'); assert.equal(sockets.length, 0)
  connection.disconnect()
})
