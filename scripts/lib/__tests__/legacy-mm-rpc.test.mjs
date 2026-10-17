import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import identity from '../process-identity.cjs'
import { openLegacyMmRpc } from '../legacy-mm-rpc.mjs'

async function fixture(t, handler) {
  const requests = [], sockets = new Set()
  const server = createServer(async (request, response) => {
    let text = ''; for await (const bytes of request) text += bytes
    const body = JSON.parse(text)
    requests.push({ path: request.url, headers: request.headers, body })
    if (handler) handler(request, response)
    else response.end(JSON.stringify({ id: body.id, success: true, data: { definition: { module_id: 'crabot-agent', env: { DATA_DIR: 'synthetic' } } } }))
  })
  server.on('connection', socket => sockets.add(socket))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  return { server, port: server.address().port, requests, sockets, process: identity.inspectProcess(process.pid) }
}

test('legacy read and shutdown use one OS-owned established connection without credentials', async t => {
  const f = await fixture(t), rpc = await openLegacyMmRpc(f.process, f.port)
  t.after(() => rpc.close())
  assert.equal((await rpc.getDefinition('crabot-agent')).module_id, 'crabot-agent')
  await rpc.shutdown()
  assert.equal(f.sockets.size, 1)
  assert.deepEqual(f.requests.map(request => request.path), ['/get_module_definition', '/shutdown'])
  for (const request of f.requests) assert.equal(request.headers.authorization, undefined)
  await assert.rejects(rpc.getDefinition('unknown-module'))
})

test('a changed process identity is refused before a request is sent', async t => {
  const f = await fixture(t)
  await assert.rejects(openLegacyMmRpc({ ...f.process, started: 'old incarnation' }, f.port), { code: 'CRABOT_LEGACY_RUNTIME_UNVERIFIED' })
  assert.equal(f.requests.length, 0)
})

test('closed legacy connection never reconnects a mutation to a rebound listener', async t => {
  const f = await fixture(t), rpc = await openLegacyMmRpc(f.process, f.port)
  t.after(() => rpc.close())
  await rpc.getDefinition('crabot-agent')
  f.server.closeAllConnections(); await new Promise(resolve => f.server.close(resolve))
  const replacement = createServer((request, response) => { assert.fail('A shutdown must not reach the replacement server'); response.end() })
  replacement.listen(f.port, '127.0.0.1'); await once(replacement, 'listening')
  t.after(() => new Promise(resolve => replacement.close(resolve)))
  await assert.rejects(rpc.shutdown(), { code: 'CRABOT_LEGACY_RUNTIME_UNVERIFIED' })
})

test('oversized and malformed replies fail without echoing server contents', async t => {
  for (const body of ['secret invalid JSON', 'x'.repeat(300 * 1024)]) {
    const f = await fixture(t, (request, response) => response.end(body))
    const rpc = await openLegacyMmRpc(f.process, f.port); t.after(() => rpc.close())
    await assert.rejects(rpc.getDefinition('crabot-agent'), error => error.code === 'CRABOT_LEGACY_RUNTIME_UNVERIFIED' && !error.message.includes('secret'))
  }
})
