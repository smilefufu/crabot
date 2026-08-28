/**
 * 槽位思考强度 → 各 adapter 请求参数映射（spec 2026-08 §5.2 映射表逐格断言）。
 *
 * 契约：跟随默认（无 thinking）时请求与现状逐字节等价（不发任何思考参数；
 * Codex 保持硬编码 effort='medium'）；off/低中高/自定义按 format 映射；
 * 不支持档位由 Provider 400 兜底，adapter 不做运行时降级。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { AnthropicAdapter } from '../../src/engine/anthropic-adapter'
import { OpenAIAdapter } from '../../src/engine/openai-adapter'
import { OpenAIResponsesAdapter } from '../../src/engine/openai-responses-adapter'
import { thinkingParam, thinkingEffortValue, type LLMThinkingConfig } from '../../src/engine/llm-adapter-types'

// --- helpers ---

function sseResponse(text: string): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
  return new Response(body, { status: 200 })
}

/** mock 全局 fetch，跑一次 streamOnce，返回发出的 JSON 请求体 */
async function captureBody(
  adapter: { streamOnce: (p: unknown) => AsyncGenerator<unknown> },
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const fetchMock = vi.fn(async (_url: unknown, init?: { body?: string }) =>
    sseResponse('data: [DONE]\n\n'),
  )
  vi.stubGlobal('fetch', fetchMock)
  try {
    for await (const _ of adapter.streamOnce(params)) {
      // drain
    }
  } catch {
    // 空流的收尾处理差异不影响请求体断言
  }
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const init = fetchMock.mock.calls[0][1] as { body: string }
  return JSON.parse(init.body)
}

// --- 共享 helper 单测 ---

describe('thinking helpers', () => {
  it('thinkingParam：两字段缺省返回 undefined（跟随默认）', () => {
    expect(thinkingParam(undefined, undefined)).toBeUndefined()
    expect(thinkingParam('high', undefined)).toEqual({ level: 'high' })
    expect(thinkingParam(undefined, 8192)).toEqual({ custom: 8192 })
  })

  it('thinkingEffortValue：off→none、档位字面量、自定义字符串透传、数字不适用', () => {
    expect(thinkingEffortValue(undefined)).toBeUndefined()
    expect(thinkingEffortValue({ level: 'off' })).toBe('none')
    expect(thinkingEffortValue({ level: 'medium' })).toBe('medium')
    expect(thinkingEffortValue({ custom: 'xhigh' })).toBe('xhigh')
    expect(thinkingEffortValue({ custom: 8192 })).toBeUndefined()
  })
})

// --- anthropic 映射 ---

describe('anthropic adapter thinking mapping', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  async function capture(thinking: LLMThinkingConfig | undefined): Promise<Record<string, unknown>> {
    const adapter = new AnthropicAdapter({ endpoint: 'https://example.test', apikey: 'k' })
    const fakeStream = {
      abort: vi.fn(),
      finalMessage: vi.fn().mockResolvedValue({ stop_reason: 'end_turn', usage: {} }),
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'message_start', message: { id: 'm' } }
      },
    }
    vi.spyOn((adapter as unknown as { client: { messages: { stream: unknown } } }).client.messages, 'stream')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockReturnValue(fakeStream as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gen = (adapter as unknown as { streamOnce: (p: unknown) => AsyncGenerator<unknown> }).streamOnce({
      messages: [],
      systemPrompt: 's',
      tools: [],
      model: 'claude-x',
      thinking,
    })
    for await (const _ of gen) { /* drain */ }
    const streamSpy = (adapter as unknown as { client: { messages: { stream: ReturnType<typeof vi.fn> } } }).client.messages.stream
    return (streamSpy.mock.calls[0][0]) as Record<string, unknown>
  }

  it('跟随默认：不发 thinking / output_config', async () => {
    const body = await capture(undefined)
    expect(body.thinking).toBeUndefined()
    expect(body.output_config).toBeUndefined()
  })

  it('off → thinking:{type:"disabled"}', async () => {
    const body = await capture({ level: 'off' })
    expect(body.thinking).toEqual({ type: 'disabled' })
  })

  it('low/medium/high → output_config:{effort}', async () => {
    expect((await capture({ level: 'low' })).output_config).toEqual({ effort: 'low' })
    expect((await capture({ level: 'medium' })).output_config).toEqual({ effort: 'medium' })
    expect((await capture({ level: 'high' })).output_config).toEqual({ effort: 'high' })
  })

  it('自定义字符串 → output_config:{effort:原样透传}', async () => {
    expect((await capture({ custom: 'xhigh' })).output_config).toEqual({ effort: 'xhigh' })
  })

  it('自定义数字 → thinking:{type:"enabled",budget_tokens}', async () => {
    const body = await capture({ custom: 8192 })
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 })
  })
})

// --- openai (chat) 映射 ---

describe('openai adapter thinking mapping', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  async function capture(thinking: LLMThinkingConfig | undefined): Promise<Record<string, unknown>> {
    const adapter = new OpenAIAdapter({ endpoint: 'https://api.example.test/v1', apikey: 'k' })
    return captureBody(
      adapter as unknown as { streamOnce: (p: unknown) => AsyncGenerator<unknown> },
      { messages: [], systemPrompt: 's', tools: [], model: 'gpt-x', thinking },
    )
  }

  it('跟随默认：不发 reasoning_effort', async () => {
    expect((await capture(undefined)).reasoning_effort).toBeUndefined()
  })

  it('off → reasoning_effort:"none"；low/medium/high 字面量', async () => {
    expect((await capture({ level: 'off' })).reasoning_effort).toBe('none')
    expect((await capture({ level: 'low' })).reasoning_effort).toBe('low')
    expect((await capture({ level: 'high' })).reasoning_effort).toBe('high')
  })

  it('自定义字符串原样透传（如 minimal / xhigh）', async () => {
    expect((await capture({ custom: 'minimal' })).reasoning_effort).toBe('minimal')
    expect((await capture({ custom: 'xhigh' })).reasoning_effort).toBe('xhigh')
  })
})

// --- openai-responses 映射 ---

describe('openai-responses adapter thinking mapping', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  async function capture(thinking: LLMThinkingConfig | undefined, codex = false): Promise<Record<string, unknown>> {
    const endpoint = codex
      ? 'https://chatgpt.com/backend-api/codex'
      : 'https://api.openai.com/v1'
    const adapter = new OpenAIResponsesAdapter({ endpoint, apikey: 'k' })
    return captureBody(
      adapter as unknown as { streamOnce: (p: unknown) => AsyncGenerator<unknown> },
      { messages: [], systemPrompt: 's', tools: [], model: 'gpt-x', thinking },
    )
  }

  it('Codex 跟随默认：保持现状 effort=medium', async () => {
    const body = await capture(undefined, true)
    expect(body.reasoning).toEqual({ effort: 'medium', summary: 'auto' })
  })

  it('Codex 配置档位：覆盖 effort，summary 保持 auto', async () => {
    expect((await capture({ level: 'high' }, true)).reasoning).toEqual({ effort: 'high', summary: 'auto' })
    expect((await capture({ level: 'off' }, true)).reasoning).toEqual({ effort: 'none', summary: 'auto' })
  })

  it('官方 Responses 跟随默认：不发 reasoning', async () => {
    expect((await capture(undefined)).reasoning).toBeUndefined()
  })

  it('官方 Responses 配置档位：reasoning:{effort}', async () => {
    expect((await capture({ level: 'low' })).reasoning).toEqual({ effort: 'low' })
    expect((await capture({ custom: 'max' })).reasoning).toEqual({ effort: 'max' })
  })
})
