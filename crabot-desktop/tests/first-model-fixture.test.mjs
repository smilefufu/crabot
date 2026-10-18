import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { OpenAIAdapter } from '../../crabot-agent/dist/engine/openai-adapter.js'
import { startFirstModelProvider, firstModelReply } from './fixtures/first-model-provider.mjs'
test('the local first-run substitute is accepted by the actual native adapter and confines delivery to the synthetic desktop session', async t => {
  const fixture = await startFirstModelProvider(); t.after(() => fixture.close())
  const adapter = new OpenAIAdapter({ endpoint: fixture.endpoint, apikey: 'isolated-first-model-fixture' })
  const parameters = { model: 'desktop-first-model', systemPrompt: 'Isolated protocol fixture', messages: [{ role: 'user', content: 'First reply' }],
    tools: [{ name: 'send_message', description: 'Synthetic current-session delivery', inputSchema: { type: 'object', properties: {} }, isReadOnly: false }] }
  const first = []
  for await (const chunk of adapter.stream(parameters)) first.push(chunk)
  const started = first.find(chunk => chunk.type === 'tool_use_start')
  assert.equal(started?.name, 'send_message')
  const argumentsText = first.filter(chunk => chunk.type === 'tool_use_delta').map(chunk => chunk.inputJson).join('')
  assert.deepEqual(JSON.parse(argumentsText), { channel_id: 'admin-web', session_id: 'admin-chat', content: firstModelReply })
  const second = []
  for await (const chunk of adapter.stream({ ...parameters, messages: [{ role: 'user', toolResults: [{ tool_use_id: 'call_first_model_reply', content: '{"sent":true}' }] }] })) second.push(chunk)
  assert.equal(second.some(chunk => chunk.type === 'message_end' && chunk.stopReason === 'end_turn'), true)
  assert.deepEqual(fixture.evidence, { requests: 2, tool_sent: true, finished: true, failures: 0 })
})


test('first-run setup goes directly to the current Admin origin, not the app static resource origin', async () => {
  const firstModel = createRequire(import.meta.url)('./fixtures/first-model-renderer.cjs')
  const contents = new EventEmitter(), requests = [], reachedUi = new Error('Reached actual-UI boundary')
  let scripts = 0
  contents.reload = () => queueMicrotask(() => contents.emit('did-finish-load'))
  contents.executeJavaScript = async source => {
    if (scripts++ > 0) throw reachedUi
    return runInNewContext(source, { URL, window: { crabotDesktop: { getState: async () => ({ phase: 'ready', admin_url: 'http://127.0.0.1:3199' }) } },
      fetch: async (url, options) => {
        assert.equal(new URL(url).origin, 'http://127.0.0.1:3199')
        requests.push({ url, method: options?.method ?? 'GET' })
        return { ok: true, status: options?.method === 'POST' ? 201 : 200,
          json: async () => options?.method === 'POST' ? { id: 'provider-created' } : { config: {} } }
      } })
  }
  await assert.rejects(firstModel({ webContents: contents }, 'http://127.0.0.1:4399/v1'), error => error === reachedUi)
  assert.deepEqual(requests, [{ url: 'http://127.0.0.1:3199/api/model-config/global', method: 'GET' },
    { url: 'http://127.0.0.1:3199/api/model-providers', method: 'POST' }])
})
test('the first-run substitute cannot be redirected to a remote model', async () => {
  const firstModel = createRequire(import.meta.url)('./fixtures/first-model-renderer.cjs')
  await assert.rejects(firstModel({ webContents: { executeJavaScript: () => assert.fail('no remote side effect') } }, 'https://example.com/v1'), /loopback/)
})
