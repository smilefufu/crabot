import test from 'node:test'
import assert from 'node:assert/strict'
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
