/**
 * temperature 透传（spec 2026-11-18 派工复核确定性）：
 * 显式传 temperature 时四个 adapter 都要进请求体；不传时请求体不得出现该字段。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { AnthropicAdapter } from '../../src/engine/anthropic-adapter'
import { OpenAIAdapter } from '../../src/engine/openai-adapter'
import { OpenAIResponsesAdapter } from '../../src/engine/openai-responses-adapter'
import { buildGeminiRequest } from '../../src/engine/gemini-adapter'
import type { LLMStreamParams } from '../../src/engine/llm-adapter-types'

const base: LLMStreamParams = { model: 'm', messages: [], systemPrompt: 's', tools: [] }

afterEach(() => vi.restoreAllMocks())

function sseResponse(): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close() } })
  return new Response(body, { status: 200 })
}

async function captureFetchBody(adapter: { streamOnce: (p: unknown) => AsyncGenerator<unknown> }, params: Record<string, unknown>) {
  const fetchMock = vi.fn(async () => sseResponse())
  vi.stubGlobal('fetch', fetchMock)
  try {
    for await (const _ of adapter.streamOnce(params)) { /* drain */ }
  } catch { /* 空流收尾差异不影响请求体断言 */ }
  vi.unstubAllGlobals()
  expect(fetchMock).toHaveBeenCalledTimes(1)
  return JSON.parse(String((fetchMock.mock.calls[0][1] as { body: string }).body))
}

async function captureAnthropicBody(params: LLMStreamParams) {
  const adapter = new AnthropicAdapter({ endpoint: 'https://example.test', apikey: 'k' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spy = vi.spyOn((adapter as any).client.messages, 'stream').mockReturnValue({
    abort: vi.fn(), finalMessage: vi.fn().mockResolvedValue({ stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }),
    [Symbol.asyncIterator]: async function* () { /* empty */ },
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for await (const _ of (adapter as any).streamOnce(params)) { /* drain */ }
  return spy.mock.calls[0][0] as Record<string, unknown>
}

describe('temperature passthrough', () => {
  it.each([0, 0.7])('openai sends temperature=%s when set and omits it otherwise', async value => {
    const adapter = new OpenAIAdapter({ endpoint: 'https://example.test', apikey: 'k' })
    const withTemp = await captureFetchBody(adapter as never, { ...base, temperature: value })
    expect(withTemp.temperature).toBe(value)
    const without = await captureFetchBody(adapter as never, { ...base })
    expect(without).not.toHaveProperty('temperature')
  })

  it.each([0, 0.7])('openai-responses sends temperature=%s when set and omits it otherwise', async value => {
    const adapter = new OpenAIResponsesAdapter({ endpoint: 'https://example.test', apikey: 'k' })
    const withTemp = await captureFetchBody(adapter as never, { ...base, temperature: value })
    expect(withTemp.temperature).toBe(value)
    const without = await captureFetchBody(adapter as never, { ...base })
    expect(without).not.toHaveProperty('temperature')
  })

  it.each([0, 0.7])('anthropic sends temperature=%s when set and omits it otherwise', async value => {
    expect((await captureAnthropicBody({ ...base, temperature: value })).temperature).toBe(value)
    expect(await captureAnthropicBody(base)).not.toHaveProperty('temperature')
  })

  it.each([0, 0.7])('gemini sends temperature=%s in generationConfig when set and omits it otherwise', value => {
    const withTemp = buildGeminiRequest({ ...base, temperature: value }) as { generationConfig?: Record<string, unknown> }
    expect(withTemp.generationConfig?.temperature).toBe(value)
    const without = buildGeminiRequest(base) as { generationConfig?: Record<string, unknown> }
    expect(without.generationConfig ?? {}).not.toHaveProperty('temperature')
  })
})
