import { afterEach, describe, expect, it, vi } from 'vitest'
import { callNonStreaming, createAdapter, OpenAIAdapter, type LLMStreamParams } from '../../src/engine/llm-adapter'
import { createAssistantMessage, createToolResultMessage, createUserMessage, type ToolDefinition } from '../../src/engine/types'

const connection = { endpoint: 'https://example.test/v1', apikey: 'test-key' }
const expectedKey = '1d5b695acfa33ddf798e8894e92ebf4356b859880d2698bc4bd8a51038b320f2'
const params: LLMStreamParams = {
  model: 'cache-test-model',
  systemPrompt: 'Stable instructions',
  messages: [createUserMessage('hello')],
  tools: [],
  maxTokens: 64,
}
const tool: ToolDefinition = {
  name: 'lookup',
  description: 'Look up a value',
  inputSchema: { type: 'object', properties: {} },
  isReadOnly: true,
  call: async () => ({ output: 'found', isError: false }),
}
const formats = ['openai', 'openai-responses'] as const

function mockFetch() {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    const data = url.endsWith('/responses')
      ? `event: response.completed\ndata: ${JSON.stringify({ response: { id: 'resp_1', output: [] } })}\n\n`
      : `data: ${JSON.stringify({ id: 'chat_1', choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
    return new Response(data, { headers: { 'Content-Type': 'text/event-stream' } })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function requestBodies(fetchMock: ReturnType<typeof mockFetch>): Array<Record<string, unknown>> {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse(init!.body as string))
}

afterEach(() => vi.unstubAllGlobals())

describe('OpenAI prompt cache key', () => {
  it.each(formats)('%s 加载尾部、full 回退与旧工具历史均不改变 key 和核心前缀', async (format) => {
    const fetchMock = mockFetch()
    const adapter = createAdapter({ ...connection, format })
    const core = { ...tool, cacheBreakpoint: true, traceMetadata: { connector_generation: 99 } }
    const tail = { ...tool, name: 'tail_tool' }
    const messages = [
      createAssistantMessage([{ type: 'tool_use', id: 'closed-call', name: 'old_episode_tool', input: {} }], 'tool_use'),
      createToolResultMessage('closed-call', 'closed result', false),
    ]
    for (const tools of [[core, tail], [core], [core, tail]]) await callNonStreaming(adapter, { ...params, messages, tools })
    const bodies = requestBodies(fetchMock)
    expect(new Set(bodies.map((body) => body.prompt_cache_key)).size).toBe(1)
    expect((bodies[0].tools as unknown[])[0]).toEqual((bodies[1].tools as unknown[])[0])
    expect(JSON.stringify(bodies[1])).toContain('old_episode_tool')
    expect(JSON.stringify(bodies)).not.toMatch(/cacheBreakpoint|connector_generation|additional_tools|prompt_cache_options/)
  })
  it('preserves an SSE error event instead of masking it as a missing finish reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      `data: ${JSON.stringify({ error: { code: 'insufficient_quota', message: 'fixture quota exhausted' } })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )))

    await expect(callNonStreaming(new OpenAIAdapter(connection), params))
      .rejects.toThrow(/insufficient_quota/)
  })

  it.each(formats)('adds only the top-level key to the %s request', async (format) => {
    const fetchMock = mockFetch()
    await callNonStreaming(createAdapter({ ...connection, format }), { ...params, tools: [tool] })

    const [body] = requestBodies(fetchMock)
    expect(body).toEqual(format === 'openai' ? {
      model: params.model,
      max_tokens: 64,
      messages: [{ role: 'system', content: params.systemPrompt }, { role: 'user', content: 'hello' }],
      tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }],
      stream: true,
      stream_options: { include_usage: true },
      prompt_cache_key: expectedKey,
    } : {
      model: params.model,
      instructions: params.systemPrompt,
      input: [{ type: 'message', role: 'user', content: 'hello' }],
      tools: [{ type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false }],
      tool_choice: 'auto',
      parallel_tool_calls: false,
      store: false,
      stream: true,
      max_output_tokens: 64,
      prompt_cache_key: expectedKey,
    })
  })

  it.each(formats)('keeps the %s key stable as history, tools and connection change', async (format) => {
    const fetchMock = mockFetch()
    const adapter = createAdapter({ ...connection, format })
    await callNonStreaming(adapter, params)
    const grown = {
      ...params,
      tools: [tool],
      messages: [
        ...params.messages,
        createAssistantMessage([{ type: 'tool_use', id: 'call_1', name: tool.name, input: {} }], 'tool_use'),
        createToolResultMessage('call_1', 'found', false),
        createUserMessage('continue'),
      ],
    }
    await callNonStreaming(adapter, grown)
    adapter.updateConfig({ endpoint: 'https://changed.test/v1', apikey: 'rotated-key' })
    await callNonStreaming(adapter, { ...params, messages: [createUserMessage('compacted history')] })
    await callNonStreaming(createAdapter({ ...connection, format }), params)

    expect(requestBodies(fetchMock).map((body) => body.prompt_cache_key)).toEqual(Array(4).fill(expectedKey))
  })

  it.each(formats)('changes the %s key with the model or exact system prompt', async (format) => {
    const fetchMock = mockFetch()
    const adapter = createAdapter({ ...connection, format })
    for (const request of [
      params,
      { ...params, model: 'another-model' },
      { ...params, systemPrompt: `${params.systemPrompt} ` },
      { ...params, systemPrompt: 'Other instructions' },
    ]) await callNonStreaming(adapter, request)

    const keys = requestBodies(fetchMock).map((body) => body.prompt_cache_key)
    expect(keys[0]).toBe(expectedKey)
    expect(new Set(keys).size).toBe(4)
  })

  it.each(['', '\u4f60\u597d', 'x'.repeat(10_000)])('uses a bounded key for prompt case %#', async (systemPrompt) => {
    const fetchMock = mockFetch()
    for (const format of formats) {
      await callNonStreaming(createAdapter({ ...connection, format }), { ...params, systemPrompt })
    }
    const bodies = requestBodies(fetchMock)
    expect(bodies[0].prompt_cache_key).toMatch(/^[a-f0-9]{64}$/)
    expect(bodies[1].prompt_cache_key).toBe(bodies[0].prompt_cache_key)
  })

  it('preserves OpenAI semantics for direct constructor callers', async () => {
    const fetchMock = mockFetch()
    await callNonStreaming(new OpenAIAdapter(connection), params)
    expect(requestBodies(fetchMock)[0].prompt_cache_key).toBe(expectedKey)
  })

  it('omits the key for Gemini even after connection updates', async () => {
    const fetchMock = mockFetch()
    const adapter = createAdapter({ ...connection, format: 'gemini' })
    await callNonStreaming(adapter, params)
    adapter.updateConfig({ endpoint: 'https://changed.test/v1', apikey: 'rotated-key' })
    await callNonStreaming(adapter, params)
    for (const body of requestBodies(fetchMock)) expect(body).not.toHaveProperty('prompt_cache_key')
  })

  it('adds the key for the Codex Responses backend without changing account headers or defaults', async () => {
    const fetchMock = mockFetch()
    const adapter = createAdapter({
      ...connection, endpoint: 'https://chatgpt.com/backend-api/codex', format: 'openai-responses', accountId: 'account-1',
    })
    await callNonStreaming(adapter, params)
    const [body] = requestBodies(fetchMock)
    expect(body.prompt_cache_key).toBe(expectedKey)
    expect(body.reasoning).toEqual({ effort: 'medium', summary: 'auto' })
    expect(body.include).toEqual(['reasoning.encrypted_content'])
    expect(body).not.toHaveProperty('max_output_tokens')
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({
      'Content-Type': 'application/json', Authorization: 'Bearer test-key', 'ChatGPT-Account-Id': 'account-1',
    })
  })

  it.each(formats)('retains the %s key when a failed request retries with a rebuilt adapter', async (format) => {
    const fetchMock = mockFetch()
    let generation = 0
    fetchMock.mockImplementationOnce(async () => {
      generation++
      return new Response('temporary failure', { status: 503 })
    })
    await callNonStreaming(createAdapter({ ...connection, format }), {
      ...params,
      configGeneration: () => generation,
      onConfigChanged: async () => ({ adapter: createAdapter({ ...connection, format }) }),
    })
    expect(requestBodies(fetchMock).map((body) => body.prompt_cache_key)).toEqual([expectedKey, expectedKey])
  })

  it('omits the key when buffered retry switches from OpenAI to Gemini', async () => {
    const fetchMock = mockFetch()
    let generation = 0
    fetchMock.mockImplementationOnce(async () => {
      generation++
      return new Response('temporary failure', { status: 503 })
    })
    await callNonStreaming(createAdapter({ ...connection, format: 'openai' }), {
      ...params,
      configGeneration: () => generation,
      onConfigChanged: async () => ({
        adapter: createAdapter({ ...connection, format: 'gemini' }), model: 'gemini-test-model',
      }),
    })
    const bodies = requestBodies(fetchMock)
    expect(bodies).toHaveLength(2)
    expect(bodies[0].prompt_cache_key).toBe(expectedKey)
    expect(bodies[1]).not.toHaveProperty('prompt_cache_key')
    expect(bodies[1].model).toBe('gemini-test-model')
  })

  it.each(formats)('surfaces a %s parameter rejection without retrying or dropping the key', async (format) => {
    const fetchMock = mockFetch()
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({
      error: { type: 'invalid_request_error', message: 'unsupported parameter: prompt_cache_key' },
    }), { status: 400 }))
    await expect(callNonStreaming(createAdapter({ ...connection, format }), params)).rejects.toThrow('prompt_cache_key')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(requestBodies(fetchMock)[0].prompt_cache_key).toBe(expectedKey)
  })
})
