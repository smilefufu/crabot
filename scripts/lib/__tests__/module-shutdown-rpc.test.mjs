import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import identity from '../process-identity.cjs'
import moduleRpc from '../module-shutdown-rpc.cjs'
import transport from '../pinned-process-rpc.cjs'
import runtimeRpc from '../module-runtime-rpc.cjs'

const expected = { instance_id: 'fixture-instance', module_id: 'fixture-memory', runtime_id: 'fixture-generation' }
async function fixture(t, handler) {
  const calls = [], sockets = new Set()
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk
    const body = JSON.parse(text); calls.push({ url: req.url, body })
    const data = req.url === '/get_runtime_identity' ? expected : {}
    if (handler) handler(req, res, body, data)
    else res.end(JSON.stringify({ id: body.id, success: true, data }))
  })
  server.on('connection', socket => sockets.add(socket))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  return { server, calls, sockets, port: server.address().port, process: identity.inspectProcess(process.pid) }
}
test('module shutdown proves exact runtime then uses the same socket only once', async t => {
  const f = await fixture(t), rpc = await moduleRpc.openModuleShutdownRpc(f.process, f.port, expected)
  t.after(() => rpc.close())
  await rpc.shutdown()
  assert.equal(f.sockets.size, 1)
  assert.deepEqual(f.calls.map(call => call.url), ['/get_runtime_identity', '/shutdown'])
  for (const { url, body } of f.calls) {
    assert.equal(body.source, 'module-manager'); assert.equal('/' + body.method, url)
    assert.ok(Number.isFinite(Date.parse(body.timestamp)))
  }
  await assert.rejects(rpc.shutdown(), { code: 'CRABOT_MODULE_SHUTDOWN_UNVERIFIED' })
  assert.equal(f.calls.length, 2)
})
for (const key of ['instance_id', 'module_id', 'runtime_id']) test(`mismatched ${key} cannot dispatch shutdown`, async t => {
  const f = await fixture(t)
  await assert.rejects(moduleRpc.openModuleShutdownRpc(f.process, f.port, { ...expected, [key]: 'different' }), { code: 'CRABOT_MODULE_SHUTDOWN_UNVERIFIED' })
  assert.deepEqual(f.calls.map(call => call.url), ['/get_runtime_identity'])
})
test('wrong process generation rejects before even reading runtime', async t => {
  const f = await fixture(t)
  await assert.rejects(moduleRpc.openModuleShutdownRpc({ ...f.process, started: 'other' }, f.port, expected))
  assert.equal(f.calls.length, 0)
})
test('closed module socket does not reconnect shutdown to a replacement', async t => {
  const f = await fixture(t), rpc = await moduleRpc.openModuleShutdownRpc(f.process, f.port, expected)
  t.after(() => rpc.close())
  f.server.closeAllConnections(); await new Promise(resolve => f.server.close(resolve))
  let replacements = 0
  const replacement = createServer((req, res) => { replacements++; res.end('{}') })
  replacement.listen(f.port, '127.0.0.1'); await once(replacement, 'listening')
  t.after(() => new Promise(resolve => replacement.close(resolve)))
  await assert.rejects(rpc.shutdown(), { code: 'CRABOT_MODULE_SHUTDOWN_UNVERIFIED' })
  assert.equal(replacements, 0)
})
for (const kind of ['oversize', 'bad-json', 'wrong-id', 'failed', 'timeout']) test(`invalid module reply: ${kind}`, async t => {
  const f = await fixture(t, (req, res, body, data) => {
    if (kind === 'timeout') return
    res.end(kind === 'oversize' ? 'x'.repeat(300 * 1024) : kind === 'bad-json' ? 'private-invalid-payload' : JSON.stringify({
      id: kind === 'wrong-id' ? 'different' : body.id, success: kind !== 'failed', data,
    }))
  })
  await assert.rejects(moduleRpc.openModuleShutdownRpc(f.process, f.port, expected, { timeoutMs: 50 }), error =>
    error.code === 'CRABOT_MODULE_SHUTDOWN_UNVERIFIED' && !error.message.includes('private-invalid-payload'))
  assert.equal(f.calls.some(call => call.url === '/shutdown'), false)
})

test('runtime expectation is fixed before the asynchronous identity response', async t => {
  let respond, connected
  const ready = new Promise(resolve => { connected = resolve })
  const f = await fixture(t, (req, res, body, data) => {
    respond = () => res.end(JSON.stringify({ id: body.id, success: true, data })); connected()
  })
  const candidate = { ...expected, runtime_id: 'different' }
  const opened = moduleRpc.openModuleShutdownRpc(f.process, f.port, candidate)
  const rejected = assert.rejects(opened, { code: 'CRABOT_MODULE_SHUTDOWN_UNVERIFIED' })
  await ready; candidate.runtime_id = expected.runtime_id; respond(); await rejected
  assert.equal(f.calls.length, 1)
})
test('transport retains its initial process expectation without adopting caller changes', async t => {
  const f = await fixture(t), candidate = { ...f.process }
  const rpc = await transport.openPinnedProcessRpc(candidate, f.port)
  t.after(() => rpc.close())
  candidate.started = 'different generation'
  assert.deepEqual(await rpc.call('get_runtime_identity', {}), expected)
})
test('overlapping calls fail closed without creating a second connection', async t => {
  let connected
  const ready = new Promise(resolve => { connected = resolve })
  const f = await fixture(t, () => connected())
  const rpc = await transport.openPinnedProcessRpc(f.process, f.port)
  t.after(() => rpc.close())
  const first = assert.rejects(rpc.call('get_runtime_identity', {}), { code: 'CRABOT_PROCESS_RPC' })
  await ready
  await assert.rejects(rpc.call('shutdown', {}), { code: 'CRABOT_PROCESS_RPC' })
  await first
  assert.equal(f.sockets.size, 1); assert.equal(f.calls.length, 1)
})


test('runtime-bound verification sends human bearer only on the requested call after the credential-free probe', async t => {
  const headers = [], bearer = 'fixture-human-bearer'
  const f = await fixture(t, (req, res, body, data) => {
    headers.push(req.headers.authorization)
    assert.equal(JSON.stringify(body).includes(bearer), false)
    res.end(JSON.stringify({ id: body.id, success: true, data }))
  })
  const rpc = await runtimeRpc.openModuleRuntimeRpc(f.process, f.port, expected)
  t.after(() => rpc.close())
  await rpc.call('verify_workspace_relocation_request', { intent_id: 'fixed', intent_sha256: 'fixed' }, { authorizationBearer: bearer })
  await rpc.call('get_runtime_identity', {})
  assert.deepEqual(headers, [undefined, 'Bearer ' + bearer, undefined])
  assert.equal(f.sockets.size, 1)
})
test('wrong module runtime never receives a human bearer', async t => {
  const headers = []
  const f = await fixture(t, (req, res, body, data) => { headers.push(req.headers.authorization); res.end(JSON.stringify({ id: body.id, success: true, data })) })
  await assert.rejects(runtimeRpc.openModuleRuntimeRpc(f.process, f.port, { ...expected, runtime_id: 'other' }))
  assert.deepEqual(headers, [undefined]); assert.equal(f.calls.length, 1)
})
for (const bearer of ['', 'bad\r\nheader']) test('invalid request bearer is refused before transmission: ' + JSON.stringify(bearer), async t => {
  const f = await fixture(t), rpc = await runtimeRpc.openModuleRuntimeRpc(f.process, f.port, expected)
  t.after(() => rpc.close())
  await assert.rejects(rpc.call('verify_workspace_relocation_request', {}, { authorizationBearer: bearer }))
  assert.equal(f.calls.length, 1)
})
