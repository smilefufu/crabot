import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
const secret = 'never-print-source-human-credential'
async function fixture(t, mode) {
  const calls = []; let config = mode === 'existing' ? { default_llm_provider_id: 'existing', default_llm_model_id: 'keep' } : {}
  let context
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer ' + secret)
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined
    calls.push({ path: req.url, method: req.method, body })
    res.setHeader('Content-Type', 'application/json')
    if (req.method === 'GET' && req.url === '/api/model-config/global') { res.end(JSON.stringify({ config })); return }
    if (req.method === 'POST' && req.url === '/api/model-providers') {
      if (mode === 'changed') context = { ...context, generation: 'other' }
      res.writeHead(201).end(JSON.stringify({ id: mode === 'invalid-provider' ? 99 : 'created-provider' })); return
    }
    if (req.method === 'PATCH' && req.url === '/api/model-config/global') {
      if (mode === 'failed-save') { res.writeHead(500).end(JSON.stringify({ error: secret })); return }
      config = body; res.end(JSON.stringify({ config })); return
    }
    res.writeHead(404).end('{}')
  }).listen(0, '127.0.0.1')
  await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)))
  context = { instance_id: 'fixture', generation: 'same', connection_epoch: 1, admin_url: 'http://127.0.0.1:' + server.address().port }
  const credential = { ...context, token: secret }
  return { calls, host: { snapshot: () => ({ phase: mode === 'not-ready' ? 'stopped' : 'ready' }), context: () => context,
    credential: async () => mode === 'no-credential' ? null : credential } }
}
for (const mode of ['fresh', 'existing', 'changed', 'invalid-provider', 'failed-save', 'remote-model', 'no-credential', 'not-ready']) test('paired source model setup uses real SDK/HTTP and never generation calls: ' + mode, async t => {
  const f = await fixture(t, mode), { configurePairedSourceModel } = await import('../../crabot-desktop/tests/fixtures/paired-update-source-model.cjs')
  const endpoint = mode === 'remote-model' ? 'https://example.com/v1' : 'http://127.0.0.1:31999/v1'
  if (mode === 'fresh') {
    assert.deepEqual(await configurePairedSourceModel(f.host, endpoint), { configured_via_http: true, provider_id: 'created-provider', model_id: 'desktop-paired-update' })
    assert.deepEqual(f.calls.map(call => [call.method, call.path]), [['GET', '/api/model-config/global'], ['POST', '/api/model-providers'], ['PATCH', '/api/model-config/global'], ['GET', '/api/model-config/global']])
    assert.deepEqual(f.calls[2].body, { default_llm_provider_id: 'created-provider', default_llm_model_id: 'desktop-paired-update' })
    assert.equal(f.calls[1].body.endpoint, endpoint); assert.equal(f.calls[1].body.format, 'openai'); assert.equal(f.calls[1].body.models[0].model_id, 'desktop-paired-update')
    assert.equal(JSON.stringify(f.calls).includes(secret), false)
  } else {
    await assert.rejects(configurePairedSourceModel(f.host, endpoint), error => error.code === 'PAIRED_SOURCE_MODEL_SETUP' && !String(error.message).includes(secret))
    if (['remote-model', 'no-credential', 'not-ready'].includes(mode)) assert.deepEqual(f.calls, [])
    if (mode === 'existing') assert.equal(f.calls.length, 1)
    if (['changed', 'invalid-provider'].includes(mode)) assert.equal(f.calls.some(call => call.method === 'PATCH'), false)
  }
})

test('paired-update Provider fixture only serves local metadata and rejects generation', async t => {
  const { startPairedUpdateModelProvider } = await import('../../crabot-desktop/tests/fixtures/paired-update-model-provider.mjs')
  const provider = await startPairedUpdateModelProvider(); t.after(() => provider.close())
  assert.match(provider.endpoint, /^http:\/\/127\.0\.0\.1:[1-9]\d*\/v1$/)
  const models = await fetch(provider.endpoint + '/models'); assert.equal(models.status, 200)
  assert.equal((await models.json()).data[0].id, 'desktop-paired-update')
  const reply = await fetch(provider.endpoint + '/chat/completions', { method: 'POST', body: '{}' }); assert.equal(reply.status, 503)
  assert.deepEqual(provider.evidence, { metadata_requests: 1, generation_requests: 1, unexpected_requests: 0 })
})
