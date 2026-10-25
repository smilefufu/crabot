import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAdapter, callNonStreaming } from '../../src/engine/llm-adapter.js'
import type { EngineMessage, StreamChunk, ToolDefinition, EngineAssistantMessage } from '../../src/engine/types.js'

const config = { format: 'gemini' as const, endpoint: 'https://gateway.example/antigravity', apikey: 'test-key' }
import type { LLMStreamParams } from '../../src/engine/llm-adapter-types.js'
import { buildGeminiRequest, normalizeMessagesForGemini } from '../../src/engine/gemini-adapter.js'
import { createAssistantMessage, createUserMessage, createToolResultMessage } from '../../src/engine/types.js'
import { runEngine } from '../../src/engine/query-loop.js'

const params: LLMStreamParams = { model: 'gemini-4-argon-low', messages: [] as EngineMessage[], systemPrompt: 'Be brief', tools: [] }
function sse(events: unknown[]): Response {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
}
async function collect(events: unknown[], overrides: Partial<LLMStreamParams> = {}): Promise<StreamChunk[]> {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse(events))
  const chunks: StreamChunk[] = []
  for await (const chunk of createAdapter(config).stream({ ...params, ...overrides })) chunks.push(chunk)
  return chunks
}
afterEach(() => vi.restoreAllMocks())

describe('native Gemini adapter', () => {
  it('selects a native adapter rather than Chat Completions', () => {
    expect(createAdapter(config).constructor.name).toBe('GeminiAdapter')
  })
  it('uses native URL, Header and systemInstruction and consumes a complete native stream', async () => {
    const chunks = await collect([{ candidates: [{ content: { role: 'model', parts: [{ text: 'OK' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2 } }])
    expect(globalThis.fetch).toHaveBeenCalledWith(`${config.endpoint}/v1beta/models/gemini-4-argon-low:streamGenerateContent?alt=sse`, expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
    }))
    const body = JSON.parse(String(vi.mocked(globalThis.fetch).mock.calls[0][1]?.body))
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'Be brief' }] })
    expect(body).not.toHaveProperty('messages')
    expect(chunks.filter(chunk => chunk.type === 'text_delta')).toEqual([{ type: 'text_delta', text: 'OK' }])
    expect(chunks.filter(chunk => chunk.type === 'message_end')).toHaveLength(1)
  })
})

const tool: ToolDefinition = { name: 'probe', description: 'test only', inputSchema: { type: 'object', properties: { label: { type: 'string' } }, additionalProperties: false }, isReadOnly: true, call: async () => ({ output: 'OK', isError: false }) }
const signedParts = [{ text: 'before', thoughtSignature: 'text-signature' }, { thought: true, text: 'private', thoughtSignature: 'thought-signature' }, { functionCall: { name: 'probe', args: { label: 'health' }, id: 'call-1' }, thoughtSignature: 'tool-signature' }]
const response = (parts: unknown[], finishReason?: string, usageMetadata?: unknown) => ({ candidates: [{ content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }], ...(usageMetadata ? { usageMetadata } : {}) })

async function signedAssistant(parts = signedParts): Promise<EngineAssistantMessage> {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse([response(parts, 'STOP')]))
  const result = await callNonStreaming(createAdapter(config), { ...params, tools: [tool] })
  return { ...createAssistantMessage(result.content, 'tool_use'), providerState: result.providerState }
}

describe('Gemini wire semantics', () => {
  it.each([
    ['gemini-4-argon-low', undefined, undefined],
    ['gemini-4-argon-low', { level: 'high' }, { thinkingLevel: 'high' }],
    ['gemini-4-argon-low', { level: 'off' }, { thinkingBudget: 0 }],
    ['gemini-4-argon-low', { custom: 'minimal' }, { thinkingLevel: 'minimal' }],
    ['gemini-2.5-flash', { level: 'low' }, { thinkingBudget: 1024 }],
    ['gemini-2.5-flash', { level: 'medium' }, { thinkingBudget: 8192 }],
    ['gemini-2.5-flash', { custom: 'high' }, { thinkingBudget: 24576 }],
  ] as const)('maps thinking for %s case %#', (model, thinking, expected) => {
    const body = buildGeminiRequest({ ...params, model, thinking }) as { generationConfig?: { thinkingConfig?: unknown } }
    expect(body.generationConfig?.thinkingConfig).toEqual(expected)
  })

  it('preserves tool JSON schema, image bytes and explicit output budget', () => {
    const body = buildGeminiRequest({ ...params, tools: [tool], maxTokens: 123, messages: [createUserMessage([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'pixels' } }])] })
    expect(body).toMatchObject({ tools: [{ functionDeclarations: [{ parametersJsonSchema: tool.inputSchema }] }], generationConfig: { maxOutputTokens: 123 }, contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'pixels' } }] }] })
    expect(body).not.toHaveProperty('prompt_cache_key')
    expect(() => buildGeminiRequest({ ...params, thinking: { custom: 123 } })).toThrow(/Numeric/)
    expect(() => normalizeMessagesForGemini([createUserMessage([{ type: 'image', source: { type: 'url', media_type: 'image/png', data: 'https://example.test/p.png' } }])])).toThrow(/base64/)
  })

  it('keeps every signed part attached to its original text/function call without exposing thoughts', async () => {
    const message = await signedAssistant()
    expect(message.content).toEqual([{ type: 'text', text: 'before' }, { type: 'tool_use', id: 'call-1', name: 'probe', input: { label: 'health' } }])
    const output = normalizeMessagesForGemini([message, createToolResultMessage('call-1', 'failed', true, [{ media_type: 'image/png', data: 'pixels' }])])
    expect(output[0]).toEqual({ role: 'model', parts: signedParts })
    expect(output[1].parts).toEqual([{ functionResponse: { name: 'probe', id: 'call-1', response: { error: 'failed' }, parts: [{ inlineData: { mimeType: 'image/png', data: 'pixels' } }] } }])
    const changed = { ...message, content: [{ type: 'text' as const, text: 'tampered' }, ...message.content.slice(1)] }
    expect(() => normalizeMessagesForGemini([changed])).toThrow(/does not match/)
  })

  it('uses local identity for an id-less call without inventing an upstream ID', async () => {
    const message = await signedAssistant([{ functionCall: { name: 'probe', args: { label: 'health' } }, thoughtSignature: 'signed' }] as typeof signedParts)
    const id = message.content.find(block => block.type === 'tool_use')!.id
    const output = normalizeMessagesForGemini([message, createToolResultMessage(id, 'OK', false)])
    expect(output[0].parts[0].functionCall).not.toHaveProperty('id')
    expect(output[1].parts[0].functionResponse).not.toHaveProperty('id')
  })

  it('preserves multiple same-name calls and maps out-of-order results by ID', async () => {
    const message = await signedAssistant([
      { functionCall: { name: 'probe', args: { label: 'health' }, id: 'call-1' }, thoughtSignature: 'one' },
      { functionCall: { name: 'probe', args: { label: 'other' }, id: 'call-2' }, thoughtSignature: 'two' },
    ] as typeof signedParts)
    const output = normalizeMessagesForGemini([message, createToolResultMessage('call-2', 'second', false), createToolResultMessage('call-1', 'first', false)])
    expect(output[1].parts.map(part => part.functionResponse)).toEqual([
      { name: 'probe', id: 'call-2', response: { result: 'second' } }, { name: 'probe', id: 'call-1', response: { result: 'first' } },
    ])
    expect(() => normalizeMessagesForGemini([message])).toThrow(/missing tool results/)
    expect(() => normalizeMessagesForGemini([createToolResultMessage('missing', 'no', false)])).toThrow(/unmatched/)
  })

  it('uses the final cumulative usage snapshot and emits just one terminal event', async () => {
    const chunks = await collect([
      response([{ text: 'O' }], undefined, { promptTokenCount: 20, cachedContentTokenCount: 4, candidatesTokenCount: 1 }),
      response([{ text: 'K' }], 'STOP', { promptTokenCount: 22, cachedContentTokenCount: 5, candidatesTokenCount: 2, thoughtsTokenCount: 3 }),
    ])
    expect(chunks.filter(chunk => chunk.type === 'message_end')).toEqual([{ type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 17, cacheReadTokens: 5, outputTokens: 5 } }])
  })

  it.each([
    [response([{ text: 'partial' }]), /finishReason/],
    [response([], 'STOP'), /empty/],
    [{ error: { code: 400 } }, /error event/],
    [{ promptFeedback: { blockReason: 'SAFETY' } }, /blocked/],
    [response([], 'SAFETY'), /stopped/],
    [response([{ functionCall: { name: 'probe', args: 'broken' } }], 'STOP'), /invalid functionCall/],
    [response([{ functionCall: { name: 'probe', partialArgs: [{ jsonPath: '$.label', stringValue: 'heal' }] } }], 'STOP'), /invalid functionCall/],
    [response([{ text: 'x' }], 'STOP', { promptTokenCount: 1, cachedContentTokenCount: 2 }), /cached tokens/],
    [{ candidates: [{ index: 1, content: { parts: [{ text: 'x' }] } }] }, /unexpected candidate/],
    [{ candidates: [{ content: { role: 'user', parts: [{ text: 'x' }] }, finishReason: 'STOP' }] }, /invalid content/],
  ])('rejects incomplete or invalid native responses %#', async (event, error) => {
    await expect(collect([event], { tools: [tool] })).rejects.toThrow(error)
  })

  it('does not retry permanent native HTTP failures or leak the API key', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('invalid test-key', { status: 400 }))
    await expect(callNonStreaming(createAdapter(config), params)).rejects.toThrow('Gemini HTTP 400: invalid [REDACTED]')
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('accepts CRLF/data-without-space and releases an early-returned stream reader', async () => {
    let cancelled = false
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`data:${JSON.stringify(response([{ text: 'OK' }], 'STOP'))}\r\n\r\n`)) }, cancel() { cancelled = true } })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body))
    const stream = createAdapter(config).stream(params)
    for await (const chunk of stream) { if (chunk.type === 'text_delta') break }
    expect(cancelled).toBe(true)
  })

  it('executes a synthetic tool once in Engine and retains its native state in final history', async () => {
    const call = vi.fn(async () => ({ output: 'OK', isError: false }))
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(sse([response(signedParts, 'STOP')]))
      .mockResolvedValueOnce(sse([response([{ text: 'done', thoughtSignature: 'final' }], 'STOP')]))
    const result = await runEngine({ prompt: 'test', adapter: createAdapter(config), options: { ...params, tools: [{ ...tool, call }], maxTurns: 4, disableCompaction: true } })
    expect(result.outcome).toBe('completed')
    expect(result.finalText).toBe('done')
    expect(call).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const second = JSON.parse(String(fetchMock.mock.calls[1][1]?.body))
    expect(second.contents[1].parts).toEqual(signedParts)
    expect(second.contents[2].parts[0].functionResponse).toEqual({ name: 'probe', id: 'call-1', response: { result: expect.stringMatching(/\nOK$/) } })
    expect(result.finalMessages.filter(message => message.role === 'assistant').every(message => message.providerState?.format === 'gemini')).toBe(true)
  })

  it('returns a missing tool result through Engine without executing or replaying other tools', async () => {
    const call = vi.fn(async () => ({ output: 'OK', isError: false }))
    const missing = [{ functionCall: { name: 'missing_probe', args: {}, id: 'missing' }, thoughtSignature: 'missing-signature' }]
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(sse([response(missing, 'STOP')]))
      .mockResolvedValueOnce(sse([response(signedParts, 'STOP')]))
      .mockResolvedValueOnce(sse([response([{ text: 'done' }], 'STOP')]))
    const result = await runEngine({ prompt: 'test', adapter: createAdapter(config), options: {
      ...params, tools: [{ ...tool, call }], maxTurns: 3, disableCompaction: true,
    } })
    expect(result.outcome).toBe('completed')
    expect(call).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const second = JSON.parse(String(fetchMock.mock.calls[1][1]?.body))
    expect(second.contents[1].parts).toEqual(missing)
    expect(second.contents[2].parts[0].functionResponse).toEqual({ name: 'missing_probe', id: 'missing', response: { error: expect.stringContaining('Tool not found: missing_probe') } })
    const third = JSON.parse(String(fetchMock.mock.calls[2][1]?.body))
    expect(third.contents[1].parts).toEqual(missing)
    expect(third.contents[3].parts).toEqual(signedParts)
  })

  it('still rejects function calls when no tools were offered', async () => {
    await expect(collect([response([{ functionCall: { name: 'missing_probe', args: {} } }], 'STOP')]))
      .rejects.toThrow('Gemini returned an undeclared function')
  })

  it.each([
    { name: 'missing_probe', args: 'broken' },
    { name: 'missing_probe', partialArgs: [] },
    { name: 'missing_probe', args: {}, willContinue: true },
  ])('still rejects an invalid undeclared function before executable events %#', async functionCall => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse([response([{ functionCall }], 'STOP')]))
    const chunks: StreamChunk[] = []
    await expect((async () => {
      for await (const chunk of createAdapter(config).stream({ ...params, tools: [tool] })) chunks.push(chunk)
    })()).rejects.toThrow('Gemini returned an invalid functionCall')
    expect(chunks.some(chunk => chunk.type.startsWith('tool_use'))).toBe(false)
  })

  it('still rejects duplicate IDs in complete undeclared calls', async () => {
    const part = { functionCall: { name: 'missing_probe', args: {}, id: 'same' } }
    await expect(collect([response([part, part], 'STOP')], { tools: [tool] }))
      .rejects.toThrow('Gemini returned duplicate function call IDs')
  })
})

it('textualizes tool history for a no-tool fork without mutating signed source history', async () => {
  const message = await signedAssistant()
  const original = JSON.stringify(message)
  const body = buildGeminiRequest({ ...params, messages: [message, createToolResultMessage('call-1', 'done', false)] })
  expect(JSON.stringify(body)).toContain('Historical tool call')
  expect(JSON.stringify(body)).not.toMatch(/functionCall|functionResponse|thoughtSignature/)
  expect(JSON.stringify(message)).toBe(original)
})

it('does not manufacture complete token counts from partial metadata and preserves an explicitly reported zero cache', async () => {
  const partial = await collect([response([{ text: 'OK' }], 'STOP', { promptTokenCount: 10 })])
  expect(partial.find(chunk => chunk.type === 'message_end')).not.toHaveProperty('usage')
  const complete = await collect([response([{ text: 'OK' }], 'STOP', { promptTokenCount: 10, candidatesTokenCount: 1, cachedContentTokenCount: 0 })])
  expect(complete.find(chunk => chunk.type === 'message_end')).toMatchObject({ usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0 } })
})
