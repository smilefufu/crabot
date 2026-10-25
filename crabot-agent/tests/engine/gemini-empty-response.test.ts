import { afterEach, describe, expect, it, vi } from 'vitest'
import { callNonStreaming, createAdapter } from '../../src/engine/llm-adapter.js'
import type { LLMStreamParams } from '../../src/engine/llm-adapter-types.js'
import type { StreamChunk } from '../../src/engine/types.js'
import { DEFAULT_MAX_RETRIES, isConnectionRecoveryError, isRetryableError } from '../../src/engine/retry-utils.js'

const config = { format: 'gemini' as const, endpoint: 'https://example.test', apikey: 'test-key' }
const params: LLMStreamParams = { model: 'gemini-4-argon-high', systemPrompt: 'test', messages: [], tools: [] }
// Sanitized shape captured from the gateway: signature + empty text, usage, no finishReason.
const emptyEvent = {
  candidates: [{ content: { role: 'model', parts: [{ thoughtSignature: 'synthetic-signature', text: '' }] } }],
  usageMetadata: { promptTokenCount: 42, totalTokenCount: 42, cachedContentTokenCount: 30 },
}
const doneEvent = { candidates: [{ content: { role: 'model', parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] }
const sse = (event: unknown) => new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } })

async function failedStream(response: Response, overrides: Partial<LLMStreamParams> = {}) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)
  const chunks: StreamChunk[] = []
  let error: unknown
  try { for await (const chunk of createAdapter(config).stream({ ...params, ...overrides })) chunks.push(chunk) }
  catch (caught) { error = caught }
  expect(error).toBeInstanceOf(Error)
  return { chunks, error: error as Error }
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('Gemini empty response recovery', () => {
  it.each([emptyEvent, { usageMetadata: { promptTokenCount: 42 } }])('uses bounded retries for a normal EOF with only metadata or empty signed text %#', async event => {
    const { error, chunks } = await failedStream(sse(event))
    expect(error.name).toBe('EmptyResponseError')
    expect(error.message).toContain('Gemini returned an empty response without finishReason')
    expect(isRetryableError(error)).toBe(true)
    expect(isConnectionRecoveryError(error)).toBe(false)
    expect(chunks.map(chunk => chunk.type)).toEqual(['message_start', 'heartbeat'])
    expect(error.message).not.toContain('synthetic-signature')
    expect(error.message).not.toContain(config.apikey)
  })

  it.each([
    { text: 'partial' },
    { thought: true, text: 'partial thought' },
    { functionCall: { name: 'probe', args: {}, id: 'call' } },
  ])('keeps connection recovery when actual output loses its terminal event %#', async part => {
    const { error } = await failedStream(sse({ candidates: [{ content: { role: 'model', parts: [part] } }] }), {
      tools: [{ name: 'probe', description: 'synthetic', inputSchema: { type: 'object' }, call: vi.fn() }],
    })
    expect(error.name).toBe('StreamProtocolError')
    expect(isConnectionRecoveryError(error)).toBe(true)
  })

  it('keeps connection recovery if no native event was received at all', async () => {
    const { error } = await failedStream(new Response(''))
    expect(error.name).toBe('StreamProtocolError')
    expect(isConnectionRecoveryError(error)).toBe(true)
  })

  it('keeps real transport errors out of the empty response classification', async () => {
    const socketError = Object.assign(new Error('socket closed'), { code: 'ECONNRESET' })
    const body = new ReadableStream({ start(controller) { controller.error(socketError) } })
    const { error } = await failedStream(new Response(body))
    expect(error).toBe(socketError)
    expect(isConnectionRecoveryError(error)).toBe(true)
  })

  it('recovers from an empty response without fabricating an intermediate success', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(sse(emptyEvent)).mockResolvedValueOnce(sse(doneEvent))
    const onRetry = vi.fn()
    const resultPromise = callNonStreaming(createAdapter(config), { ...params, onRetry })
    await vi.advanceTimersByTimeAsync(10_000)
    const result = await resultPromise
    expect(result.content).toEqual([{ type: 'text', text: 'OK' }])
    expect(result.stopReason).toBe('end_turn')
    expect(result.providerState?.content.parts).toEqual([{ text: 'OK' }])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ retryMode: 'bounded_retry', maxAttempts: DEFAULT_MAX_RETRIES + 1 }))
  })

  it('exhausts the existing retry budget instead of remaining in connection recovery', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => sse(emptyEvent))
    const onRetry = vi.fn()
    const controller = new AbortController()
    const outcome = callNonStreaming(createAdapter(config), { ...params, signal: controller.signal, onRetry })
      .then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
    await vi.advanceTimersByTimeAsync(60_000)
    controller.abort() // Keeps the old, unbounded implementation from hanging the regression.
    const result = await outcome
    expect(result.value).toBeUndefined()
    expect(result.error.name).toBe('EmptyResponseError')
    expect(result.error.message).toContain(`${DEFAULT_MAX_RETRIES + 1} 次尝试`)
    expect(fetchMock).toHaveBeenCalledTimes(DEFAULT_MAX_RETRIES + 1)
    expect(onRetry).toHaveBeenCalledTimes(DEFAULT_MAX_RETRIES)
    expect(onRetry.mock.calls.every(([event]) => event.retryMode === 'bounded_retry')).toBe(true)
  })

  it('still allows cancellation during an empty response retry wait', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => sse(emptyEvent))
    const result = callNonStreaming(createAdapter(config), { ...params, signal: controller.signal })
    const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(100)
    controller.abort()
    await rejection
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('still consumes a model switch while waiting after an empty response', async () => {
    vi.useFakeTimers()
    const changed = new AbortController()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(sse(emptyEvent)).mockResolvedValueOnce(sse(doneEvent))
    const onConfigChanged = vi.fn(async () => ({ model: 'new-model' }))
    const result = callNonStreaming(createAdapter(config), { ...params, configChangedSignal: changed.signal, onConfigChanged })
    await vi.advanceTimersByTimeAsync(100)
    changed.abort()
    expect((await result).content).toEqual([{ type: 'text', text: 'OK' }])
    expect(onConfigChanged).toHaveBeenCalledOnce()
    expect(String(fetchMock.mock.calls[1][0])).toContain('/models/new-model:streamGenerateContent')
  })
})
