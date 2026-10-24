import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
const secret = 'never-print-bearer-url-or-server-body'
async function fixture(t, mode) {
  let calls = 0, context
  const server = createServer((req, res) => {
    calls++; assert.equal(req.method, 'GET'); assert.equal(req.headers.authorization, 'Bearer ' + secret)
    if (mode === 'unauthorized' || mode === 'unavailable') { res.writeHead(mode === 'unauthorized' ? 401 : 503).end(JSON.stringify({ error: secret })); return }
    if (mode === 'invalid') { res.end(JSON.stringify({ error: secret })); return }
    if (mode === 'changed') context = { ...context, generation: 'other' }
    if (req.url.endsWith('/inbound-status')) { res.end(JSON.stringify({ manager_key: secret, snapshot_at: new Date().toISOString(), items: [] })); return }
    res.end(JSON.stringify(req.url.startsWith('/api/agent/workers?') ? { total_running: mode === 'active' ? 1 : 0, total_queued: 0 }
      : { items: mode === 'unknown_manager' ? [{ manager_key: secret, execution_status: 'unknown' }] : [],
        pagination: { page: 1, page_size: 100, total_items: mode === 'unknown_manager' ? 1 : 0, total_pages: mode === 'unknown_manager' ? 1 : 0 } }))
  }).listen(0, '127.0.0.1')
  await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)))
  context = { instance_id: 'fixture', generation: 'same', admin_url: 'http://127.0.0.1:' + server.address().port, connection_epoch: 1 }
  const credential = { ...context, token: secret }
  return { calls: () => calls, host: { snapshot: () => ({ phase: 'ready' }), context: () => context, credential: async () => credential } }
}
for (const mode of ['idle', 'active', 'unauthorized', 'unavailable', 'invalid', 'changed', 'unknown_manager']) test('source idle failure diagnostics read the real SDK without leaking credentials: ' + mode, async t => {
  const f = await fixture(t, mode), { captureSourceActivityEvidence } = await import('../../crabot-desktop/tests/fixtures/paired-update-source-activity.cjs')
  const result = await captureSourceActivityEvidence(f.host)
  assert.equal(result.phase, 'ready'); assert.equal(result.credential_present, true)
  assert.equal(result.activity, ['idle', 'active'].includes(mode) ? mode : 'unknown')
  assert.equal(JSON.stringify(result).includes(secret), false)
  assert.ok(result.requests.length <= 8); assert.equal(result.requests[0].route, 'workers')
  if (mode === 'unauthorized') assert.deepEqual(result.requests[0], { route: 'workers', status: 401, error: 'unauthorized' })
  if (mode === 'unavailable') assert.deepEqual(result.requests[0], { route: 'workers', status: 503, error: 'http' })
  if (mode === 'invalid') assert.deepEqual(result.requests[0], { route: 'workers', status: 200, error: 'validation' })
  if (mode === 'unknown_manager') {
    assert.equal(result.manager_unknown, 1); assert.equal(result.manager_running, 0); assert.equal(result.worker_running, 0)
    assert.ok(result.requests.every(request => request.status === 200 && request.error === undefined))
  }
  assert.equal(result.context_matches, mode !== 'changed'); assert.ok(f.calls() > 0)
})
test('missing or failed source credentials remain unknown and make no business request', async () => {
  const { captureSourceActivityEvidence } = await import('../../crabot-desktop/tests/fixtures/paired-update-source-activity.cjs')
  for (const credential of [async () => null, async () => { throw new Error(secret) }]) {
    const result = await captureSourceActivityEvidence({ snapshot: () => ({ phase: 'disconnected' }), credential, context: () => null })
    assert.equal(result.credential_present, false); assert.equal(result.activity, 'unknown'); assert.deepEqual(result.requests, [])
    assert.equal(JSON.stringify(result).includes(secret), false)
  }
})
