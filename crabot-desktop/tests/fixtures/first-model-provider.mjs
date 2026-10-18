// Loopback model substitute for isolated first-run acceptance. No remote model,
// shell, worker or other channel may be selected by this fixture.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
export const firstModelReply = '桌面首次对话链路已连通。'
export async function startFirstModelProvider() {
  const evidence = { requests: 0, tool_sent: false, finished: false, failures: 0 }
  const server = createServer(async (request, response) => {
    try {
      evidence.requests++
      assert.ok(evidence.requests <= 4)
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/chat/completions')
      assert.equal(request.headers.authorization, 'Bearer isolated-first-model-fixture')
      let text = '', size = 0
      for await (const bytes of request) { size += bytes.length; assert.ok(size <= 2 * 1024 * 1024); text += bytes }
      const body = JSON.parse(text)
      assert.equal(body.model, 'desktop-first-model'); assert.equal(body.stream, true)
      assert.ok(Array.isArray(body.messages)); assert.ok(Array.isArray(body.tools))
      const delivered = body.messages.some(message => message.role === 'tool' && message.tool_call_id === 'call_first_model_reply')
      if (!delivered) {
        assert.ok(body.tools.some(tool => tool.function?.name === 'send_message'))
        assert.equal(evidence.tool_sent, false, 'Never replay the synthetic delivery')
      } else assert.equal(evidence.tool_sent, true)
      const chunk = (delta, finish_reason = null) => ({ id: 'first-model-' + evidence.requests, object: 'chat.completion.chunk', created: 1,
        model: body.model, choices: [{ index: 0, delta, finish_reason }] })
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const send = value => response.write('data: ' + JSON.stringify(value) + '\n\n')
      if (!delivered) {
        evidence.tool_sent = true
        send(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_first_model_reply', type: 'function', function: { name: 'send_message',
          arguments: JSON.stringify({ channel_id: 'admin-web', session_id: 'admin-chat', content: firstModelReply }) } }] }))
      }
      send(chunk({}, delivered ? 'stop' : 'tool_calls'))
      send({ id: 'first-model-usage', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })
      response.end('data: [DONE]\n\n')
      if (delivered) evidence.finished = true
    } catch {
      evidence.failures++
      if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'Unexpected isolated first-model request' } }))
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { endpoint: 'http://127.0.0.1:' + server.address().port + '/v1', evidence,
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}
