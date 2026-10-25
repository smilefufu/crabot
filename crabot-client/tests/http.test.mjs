import test from 'node:test'
import assert from 'node:assert/strict'
import { HttpClient, ChatClient, createChatRequest, ChatMessageSchema, z } from '../dist/index.js'

const message = { message_id: 'server-message', role: 'user', content: { type: 'text', text: ' hello ' }, request_id: 'same-request', timestamp: '2026-10-17T12:00:00.000Z' }

test('response schemas reject missing/wrong fields and preserve compatible extra fields', async () => {
  for (const body of [{}, { ...message, role: 'root' }, { ...message, content: 'old unhydrated content' }]) {
    const client = new HttpClient({ endpoint: 'http://127.0.0.1:3000/api', fetch: async () => Response.json(body) })
    await assert.rejects(client.request('/chat/messages', ChatMessageSchema), { kind: 'validation' })
  }
  const client = new HttpClient({ endpoint: 'http://127.0.0.1:3000/api', fetch: async () => Response.json({ ...message, compatible_field: 42 }) })
  assert.equal((await client.request('/chat/messages', ChatMessageSchema)).compatible_field, 42)
})

test('fixed endpoint, redirect rejection and path validation keep credentials at the intended Admin', async () => {
  const requests = []
  const client = new HttpClient({ endpoint: 'http://127.0.0.1:3000/api/', token: () => 'secret', fetch: async (url, init) => {
    requests.push([url, init]); return Response.json({ ok: true })
  } })
  await client.request('/test', z.object({ ok: z.boolean() }))
  assert.equal(requests[0][0], 'http://127.0.0.1:3000/api/test')
  assert.equal(requests[0][1].redirect, 'error')
  assert.equal(new Headers(requests[0][1].headers).get('Authorization'), 'Bearer secret')
  for (const path of ['https://other/api', '//other/api', '/../other', '/%2e%2e/other', '/bad\\path', '/bad%ZZ']) {
    await assert.rejects(client.request(path, z.unknown()), { kind: 'validation' })
  }
  assert.equal(requests.length, 1)
})

test('HTTP failures, cancellation, timeout and unreachable remain distinct; there are no automatic mutation retries', async () => {
  for (const [status, kind] of [[401, 'unauthorized'], [403, 'forbidden'], [409, 'conflict'], [503, 'http']]) {
    const client = new HttpClient({ endpoint: 'http://localhost/api', fetch: async () => Response.json({ error: 'known-code' }, { status }) })
    await assert.rejects(client.request('/x', z.unknown()), { kind, status, message: 'known-code' })
  }
  let calls = 0
  const unreachable = new HttpClient({ endpoint: 'http://localhost/api', fetch: async () => { calls++; throw new Error('raw possibly sensitive transport error') } })
  await assert.rejects(unreachable.request('/x', z.unknown(), { method: 'POST' }), { kind: 'unreachable', message: 'Cannot reach Admin' })
  assert.equal(calls, 1)
  const stalledAuth = new HttpClient({ endpoint: 'http://localhost/api', token: () => new Promise(() => {}), fetch: async () => { throw new Error('must not fetch') } })
  await assert.rejects(stalledAuth.request('/x', z.unknown(), { timeoutMs: 10 }), { kind: 'timeout' })
  const cancel = new AbortController(); cancel.abort()
  await assert.rejects(stalledAuth.request('/x', z.unknown(), { signal: cancel.signal }), { kind: 'cancelled' })
})

test('host instance cancellation discards a late body even when a transport ignores abort', async () => {
  const scope = new AbortController()
  let finish
  const body = new Promise(resolve => { finish = resolve })
  let fetched
  const started = new Promise(resolve => { fetched = resolve })
  const client = new HttpClient({ endpoint: 'http://localhost/api', signal: scope.signal, fetch: async () => {
    fetched(); return { status: 200, ok: true, text: () => body }
  } })
  const result = client.request('/old-instance', z.object({ ok: z.boolean() }))
  await started
  scope.abort()
  await assert.rejects(result, { kind: 'cancelled' })
  finish('{"ok":true}')
  await assert.rejects(client.request('/old-client', z.unknown()), { kind: 'cancelled' })
})

test('chat retry preserves request ID, exact whitespace and ordered attachments; a successful send uses the server message', async () => {
  const attempts = []
  const http = new HttpClient({ endpoint: 'http://localhost/api', fetch: async (url, init) => {
    attempts.push({ url, id: init.body.get('request_id'), text: init.body.get('text'), files: init.body.getAll('files').map(file => file.name) })
    if (attempts.length === 1) throw new Error('response lost after server commit')
    return Response.json({ message })
  } })
  const chat = new ChatClient(http)
  const input = createChatRequest(' hello ', [new File(['one'], 'one.txt'), new File(['two'], 'two.txt')], 'same-request')
  await assert.rejects(chat.send(input), { kind: 'unreachable' })
  const reply = await chat.send(input)
  assert.deepEqual(attempts[0], attempts[1])
  assert.equal(attempts[0].text, ' hello ')
  assert.equal(reply.message.message_id, 'server-message')
})

test('diagnostics omit body, query, token and transport error; a broken logger cannot turn a committed mutation into failure', async () => {
  const events = []
  const client = new HttpClient({ endpoint: 'http://localhost/api', token: () => 'private-token',
    diagnose: event => { events.push(event); throw new Error('logger broken') }, fetch: async () => Response.json({ ok: true }) })
  await client.request('/sensitive?text=private-text', z.object({ ok: z.boolean() }), { method: 'POST', body: 'private-body' })
  const log = JSON.stringify(events)
  for (const secret of ['private-token', 'private-text', 'private-body', '/sensitive']) assert.equal(log.includes(secret), false)
  assert.equal(events[0].operation, 'POST')
  assert.ok(events[0].request_id)
})
