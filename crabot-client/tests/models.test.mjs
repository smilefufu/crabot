import test from 'node:test'
import assert from 'node:assert/strict'
import { HttpClient, ModelClient } from '../dist/index.js'

function fixture({ config = {}, manager = null, status = 'active', type = 'llm' } = {}) {
  const calls = []
  const client = new ModelClient(new HttpClient({ endpoint: 'http://127.0.0.1:3000/api', fetch: async (url, options) => {
    calls.push({ url, options })
    return new Response(JSON.stringify(url.endsWith('/model-providers') ? { items: [{ id: 'provider', name: '已有配置', status,
      api_key: 'fixture-secret-never-in-choice-state', models: [{ model_id: 'model', display_name: '模型', type }] }] }
      : url.endsWith('/crabot-agent') ? { config: manager } : { config }))
  } }))
  return { client, calls }
}

test('first-run reads neither test the remote model nor copy credentials into choice state', async () => {
  const { client, calls } = fixture({ config: { default_llm_provider_id: 'provider', default_llm_model_id: 'model' } })
  assert.equal(await client.hasManagerModel(), true)
  assert.equal(JSON.stringify(await client.choices()).includes('fixture-secret'), false)
  assert.equal(calls.some(call => /test|validate/.test(call.url)), false)
  assert.ok(calls.every(call => !call.options.method || call.options.method === 'GET'))
})
test('existing explicit Manager model is retained when the global default is empty', async () => {
  const { client } = fixture({ manager: { models: { powerful: { provider_id: 'provider', model_id: 'model' } } } })
  assert.equal(await client.hasManagerModel(), true)
  assert.equal(await fixture().client.hasManagerModel(), false)
})
test('an explicit powerful slot is authoritative and never falls back to a global model or retired manager slot', async () => {
  const config = { default_llm_provider_id: 'provider', default_llm_model_id: 'model' }
  assert.equal(await fixture({ config, manager: { models: { powerful: { provider_id: 'missing', model_id: 'missing' } } } }).client.hasManagerModel(), false)
  assert.equal(await fixture({ manager: { models: { manager: { provider_id: 'provider', model_id: 'model' } } } }).client.hasManagerModel(), false)
})
test('dangling, inactive and image-only defaults are not presented as an existing chat model', async () => {
  const config = { default_llm_provider_id: 'provider', default_llm_model_id: 'model' }
  for (const options of [{ config: { ...config, default_llm_model_id: 'deleted' } }, { config, status: 'inactive' }, { config, type: 'image' }]) {
    assert.equal(await fixture(options).client.hasManagerModel(), false)
  }
})
test('default selection patches references only; malformed configuration responses fail validation', async () => {
  const { client, calls } = fixture({ config: { default_llm_provider_id: 'provider', default_llm_model_id: 'model' } })
  await client.selectDefault({ provider_id: 'provider', model_id: 'model', endpoint: 'https://unused', apikey: 'must-not-save' })
  assert.deepEqual(JSON.parse(calls[0].options.body), { default_llm_provider_id: 'provider', default_llm_model_id: 'model' })
  const broken = new ModelClient(new HttpClient({ endpoint: 'http://127.0.0.1:3000/api', fetch: async () => new Response('{"config":{"default_llm_model_id":42}}') }))
  await assert.rejects(broken.globalConfig(), { kind: 'validation' })
  await assert.rejects(fixture().client.selectDefault({ provider_id: 'provider', model_id: 'model' }), { kind: 'validation' })
})
