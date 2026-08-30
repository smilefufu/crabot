import { describe, it, expect, vi } from 'vitest'
import { callNonStreaming, type LLMAdapter, type LLMStreamParams } from '../../src/engine/llm-adapter'
import { HttpResponseError, OVERLOADED_WITHOUT_RETRY_AFTER_MAX_RETRIES } from '../../src/engine/retry-utils'
import type { StreamChunk } from '../../src/engine/types'

function makeMockAdapter(chunks: StreamChunk[]): LLMAdapter {
  return {
    async *stream(_params: LLMStreamParams): AsyncGenerator<StreamChunk> {
      for (const chunk of chunks) {
        yield chunk
      }
    },
    updateConfig() {},
  }
}

const defaultParams: LLMStreamParams = {
  messages: [],
  systemPrompt: 'test',
  tools: [],
  model: 'test-model',
}

describe('callNonStreaming', () => {
  it('should collect text from streaming response', async () => {
    const adapter = makeMockAdapter([
      { type: 'message_start', messageId: 'msg_1' },
      { type: 'text_delta', text: 'Hello' },
      { type: 'text_delta', text: ' world' },
      { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } },
    ])

    const result = await callNonStreaming(adapter, defaultParams)

    expect(result.content).toEqual([{ type: 'text', text: 'Hello world' }])
    expect(result.stopReason).toBe('end_turn')
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
  })

  it('should collect tool_use blocks', async () => {
    const adapter = makeMockAdapter([
      { type: 'message_start', messageId: 'msg_1' },
      { type: 'tool_use_start', id: 'tu_1', name: 'reply' },
      { type: 'tool_use_delta', id: 'tu_1', inputJson: '{"text":' },
      { type: 'tool_use_delta', id: 'tu_1', inputJson: '"Hi"}' },
      { type: 'tool_use_end', id: 'tu_1' },
      { type: 'message_end', stopReason: 'tool_use' },
    ])

    const result = await callNonStreaming(adapter, defaultParams)

    expect(result.stopReason).toBe('tool_use')
    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('tool_use')
    if (result.content[0].type === 'tool_use') {
      expect(result.content[0].name).toBe('reply')
      expect(result.content[0].input).toEqual({ text: 'Hi' })
    }
  })

  it('should collect both text and tool_use blocks', async () => {
    const adapter = makeMockAdapter([
      { type: 'message_start', messageId: 'msg_1' },
      { type: 'text_delta', text: 'Let me think...' },
      { type: 'tool_use_start', id: 'tu_1', name: 'query_tasks' },
      { type: 'tool_use_delta', id: 'tu_1', inputJson: '{}' },
      { type: 'tool_use_end', id: 'tu_1' },
      { type: 'message_end', stopReason: 'tool_use' },
    ])

    const result = await callNonStreaming(adapter, defaultParams)

    expect(result.content).toHaveLength(2)
    expect(result.content[0].type).toBe('text')
    expect(result.content[1].type).toBe('tool_use')
  })

  it('should throw on error chunk', async () => {
    const adapter = makeMockAdapter([
      { type: 'error', error: 'API rate limit exceeded' },
    ])

    await expect(callNonStreaming(adapter, defaultParams)).rejects.toThrow('API rate limit exceeded')
  })

  it('should handle empty response (no text, no tools)', async () => {
    const adapter = makeMockAdapter([
      { type: 'message_start', messageId: 'msg_1' },
      { type: 'message_end', stopReason: 'end_turn' },
    ])

    const result = await callNonStreaming(adapter, defaultParams)

    expect(result.content).toEqual([])
    expect(result.stopReason).toBe('end_turn')
  })

  it('should handle response without usage info', async () => {
    const adapter = makeMockAdapter([
      { type: 'message_start', messageId: 'msg_1' },
      { type: 'text_delta', text: 'OK' },
      { type: 'message_end', stopReason: 'end_turn' },
    ])

    const result = await callNonStreaming(adapter, defaultParams)

    expect(result.usage).toBeUndefined()
  })

  it('retries the whole stream when mid-stream throws a retryable error', async () => {
    let attempt = 0
    const adapter: LLMAdapter = {
      async *stream(): AsyncGenerator<StreamChunk> {
        attempt++
        yield { type: 'message_start', messageId: 'msg' }
        yield { type: 'text_delta', text: 'partial' }
        if (attempt === 1) {
          // 模拟 mid-stream socket drop（material 已 yield，streamWithRetry 救不了）
          // ETIMEDOUT 是 retryable code
          const e = new Error('socket dropped') as Error & { code?: string }
          e.code = 'ETIMEDOUT'
          throw e
        }
        // 第二次 attempt：完整发完
        yield { type: 'text_delta', text: ' rest' }
        yield { type: 'message_end', stopReason: 'end_turn' }
      },
      updateConfig() {},
    }

    const result = await callNonStreaming(adapter, {
      ...defaultParams,
      signal: new AbortController().signal,
    })

    expect(attempt).toBe(2)
    expect(result.content).toEqual([{ type: 'text', text: 'partial rest' }])
    expect(result.stopReason).toBe('end_turn')
  }, 30_000)

  it('does not retry non-retryable errors mid-stream', async () => {
    let attempt = 0
    const adapter: LLMAdapter = {
      async *stream(): AsyncGenerator<StreamChunk> {
        attempt++
        yield { type: 'message_start', messageId: 'msg' }
        throw new Error('400 bad request: invalid params')
      },
      updateConfig() {},
    }
    await expect(callNonStreaming(adapter, defaultParams)).rejects.toThrow('400 bad request')
    expect(attempt).toBe(1)
  })

  it('invokes onRetry callback on mid-stream retry', async () => {
    let attempt = 0
    const adapter: LLMAdapter = {
      async *stream(): AsyncGenerator<StreamChunk> {
        attempt++
        yield { type: 'message_start', messageId: 'msg' }
        yield { type: 'text_delta', text: 'partial' }
        if (attempt === 1) {
          const e = new Error('socket dropped') as Error & { code?: string }
          e.code = 'ETIMEDOUT'
          throw e
        }
        yield { type: 'text_delta', text: ' rest' }
        yield { type: 'message_end', stopReason: 'end_turn' }
      },
      updateConfig() {},
    }

    const retries: Array<{ attempt: number; source: string; error: string }> = []
    await callNonStreaming(adapter, {
      ...defaultParams,
      signal: new AbortController().signal,
      onRetry: (e) => {
        retries.push({ attempt: e.attempt, source: e.source, error: e.error.message })
      },
    })

    expect(retries).toHaveLength(1)
    expect(retries[0].attempt).toBe(1)
    // 重试层扁平化后 source 统一为 'stream'（由 callNonStreaming 单层处理）
    expect(retries[0].source).toBe('stream')
    expect(retries[0].error).toBe('socket dropped')
  }, 30_000)

  it('still retries when the first stream attempt runs longer than the old retry window', async () => {
    vi.useFakeTimers()
    try {
      let attempt = 0
      const adapter: LLMAdapter = {
        async *stream(): AsyncGenerator<StreamChunk> {
          attempt++
          yield { type: 'message_start', messageId: 'msg' }
          yield { type: 'text_delta', text: 'partial' }
          if (attempt === 1) {
            vi.setSystemTime(Date.now() + 301_000)
            const e = new TypeError('terminated') as TypeError & { cause?: Error }
            e.cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })
            throw e
          }
          yield { type: 'text_delta', text: ' recovered' }
          yield { type: 'message_end', stopReason: 'end_turn' }
        },
        updateConfig() {},
      }

      const resultPromise = callNonStreaming(adapter, {
        ...defaultParams,
        onRetry: () => undefined,
      })
      await vi.advanceTimersByTimeAsync(1_000)
      const result = await resultPromise

      expect(attempt).toBe(2)
      expect(result.content).toEqual([{ type: 'text', text: 'partial recovered' }])
      expect(result.diagnostics?.retries).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('caps total attempts at DEFAULT_MAX_RETRIES + 1 (single retry layer)', async () => {
    vi.useFakeTimers()
    try {
      let attempt = 0
      const adapter: LLMAdapter = {
        async *stream(): AsyncGenerator<StreamChunk> {
          attempt++
          yield { type: 'message_start', messageId: 'msg' }
          const e = new Error('socket dropped') as Error & { code?: string }
          e.code = 'ETIMEDOUT'
          throw e
        },
        updateConfig() {},
      }

      // 退避 1+2+4+8+8 = 23s 后耗尽 DEFAULT_MAX_RETRIES
      const expectation = expect(callNonStreaming(adapter, defaultParams)).rejects.toThrow(/次尝试/)
      await vi.advanceTimersByTimeAsync(24_000)
      await expectation
      expect(attempt).toBe(6)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails fast on quota-class 429 without any retry', async () => {
    let attempt = 0
    const adapter: LLMAdapter = {
      async *stream(): AsyncGenerator<StreamChunk> {
        attempt++
        yield { type: 'message_start', messageId: 'msg' }
        throw new HttpResponseError(429, JSON.stringify({ error: { code: 'insufficient_quota' } }), 'test')
      },
      updateConfig() {},
    }

    await expect(callNonStreaming(adapter, defaultParams)).rejects.toThrow(/insufficient_quota/)
    expect(attempt).toBe(1)
  })

  it('limits generic 429 (no Retry-After) to 3 retries before giving up', async () => {
    vi.useFakeTimers()
    try {
      let attempt = 0
      const adapter: LLMAdapter = {
        async *stream(): AsyncGenerator<StreamChunk> {
          attempt++
          yield { type: 'message_start', messageId: 'msg' }
          throw new HttpResponseError(429, 'Too Many Requests', 'test')
        },
        updateConfig() {},
      }

      const expectation = expect(callNonStreaming(adapter, defaultParams)).rejects.toThrow(/次尝试/)
      await vi.advanceTimersByTimeAsync(10_000)
      await expectation
      expect(attempt).toBe(OVERLOADED_WITHOUT_RETRY_AFTER_MAX_RETRIES + 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('honors Retry-After delay on 429 retries', async () => {
    vi.useFakeTimers()
    try {
      let attempt = 0
      const delays: number[] = []
      const adapter: LLMAdapter = {
        async *stream(): AsyncGenerator<StreamChunk> {
          attempt++
          yield { type: 'message_start', messageId: 'msg' }
          if (attempt === 1) {
            throw new HttpResponseError(429, 'rate limited', 'test', 7_000)
          }
          yield { type: 'text_delta', text: 'ok' }
          yield { type: 'message_end', stopReason: 'end_turn' }
        },
        updateConfig() {},
      }

      const resultPromise = callNonStreaming(adapter, {
        ...defaultParams,
        onRetry: (e) => delays.push(e.delayMs),
      })
      // Retry-After=7000ms：7s 内不应发起第二次 attempt
      await vi.advanceTimersByTimeAsync(6_999)
      expect(attempt).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      const result = await resultPromise
      expect(attempt).toBe(2)
      expect(delays).toEqual([7_000])
      expect(result.content).toEqual([{ type: 'text', text: 'ok' }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('wakes retry sleep early on config change and switches adapter/model for the next attempt', async () => {
    vi.useFakeTimers()
    try {
      const configChanged = new AbortController()
      let attempt = 0
      const modelsSeen: string[] = []
      // adapterA 只会失败；成功路径必须真的经过被换上的 adapterB，
      // 断言「adapter 被替换」而不只是 model 透传。
      const adapterA: LLMAdapter = {
        async *stream(params: LLMStreamParams): AsyncGenerator<StreamChunk> {
          attempt++
          modelsSeen.push(params.model)
          yield { type: 'message_start', messageId: 'msg' }
          throw new HttpResponseError(429, 'rate limited', 'test', 60_000)
        },
        updateConfig() {},
      }
      const adapterB: LLMAdapter = {
        async *stream(params: LLMStreamParams): AsyncGenerator<StreamChunk> {
          attempt++
          modelsSeen.push(params.model)
          yield { type: 'message_start', messageId: 'msg' }
          yield { type: 'text_delta', text: 'from-' + params.model }
          yield { type: 'message_end', stopReason: 'end_turn' }
        },
        updateConfig() {},
      }

      const resultPromise = callNonStreaming(adapterA, {
        ...defaultParams,
        model: 'old-model',
        configChangedSignal: configChanged.signal,
        onConfigChanged: async () => ({ adapter: adapterB, model: 'new-model' }),
      })

      // 第一次 attempt 失败后进入 60s Retry-After sleep；1s 时配置落地 → 提前唤醒
      await vi.advanceTimersByTimeAsync(1_000)
      configChanged.abort()
      const result = await resultPromise

      expect(attempt).toBe(2)
      expect(modelsSeen).toEqual(['old-model', 'new-model'])
      expect(result.content).toEqual([{ type: 'text', text: 'from-new-model' }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('consumes a generation change that landed outside the sleep window, then resumes normal backoff (stale-signal regression)', async () => {
    vi.useFakeTimers()
    try {
      // 场景（review 风险 2）：configChangedSignal 在上一轮已被 abort（一次性信号），
      // 且变更代数在 attempt 之间前进。要求：①立即换新配置且跳过一次 sleep；
      // ②之后的退避恢复正常——Retry-After 指定的等待不被归零。
      const configChanged = new AbortController()
      let generation = 1
      let attempt = 0
      const modelsSeen: string[] = []
      const adapterA: LLMAdapter = {
        async *stream(params: LLMStreamParams): AsyncGenerator<StreamChunk> {
          attempt++
          modelsSeen.push(params.model)
          yield { type: 'message_start', messageId: 'msg' }
          throw new HttpResponseError(429, 'rate limited', 'test', 5_000)
        },
        updateConfig() {},
      }
      const adapterB: LLMAdapter = {
        async *stream(params: LLMStreamParams): AsyncGenerator<StreamChunk> {
          attempt++
          modelsSeen.push(params.model)
          yield { type: 'message_start', messageId: 'msg' }
          if (attempt === 2) {
            // 换到新 provider 后仍被限流（无 Retry-After → 通用 429 路径，1s 退避）
            throw new HttpResponseError(429, 'slow down', 'test')
          }
          yield { type: 'text_delta', text: 'from-' + params.model }
          yield { type: 'message_end', stopReason: 'end_turn' }
        },
        updateConfig() {},
      }

      const resultPromise = callNonStreaming(adapterA, {
        ...defaultParams,
        model: 'old-model',
        // 模拟同一次 run 中更早的变更已把信号耗掉
        configChangedSignal: configChanged.signal,
        configGeneration: () => generation,
        onConfigChanged: async () => ({ adapter: adapterB, model: 'new-model' }),
      })

      // attempt 1（adapterA）失败：generation 已前进 → 不 sleep，立即换 adapterB
      generation = 2
      await vi.advanceTimersByTimeAsync(0)
      expect(attempt).toBe(2)
      expect(modelsSeen).toEqual(['old-model', 'new-model'])

      // attempt 2（adapterB）失败（通用 429，attempt index 1 → 2s 退避）：信号已 aborted、
      // generation 未变，退避必须照常等待——2s 内不得发起第三次 attempt
      await vi.advanceTimersByTimeAsync(1_999)
      expect(attempt).toBe(2)
      await vi.advanceTimersByTimeAsync(1)
      const result = await resultPromise

      expect(attempt).toBe(3)
      expect(modelsSeen).toEqual(['old-model', 'new-model', 'new-model'])
      expect(result.content).toEqual([{ type: 'text', text: 'from-new-model' }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up immediately when Retry-After exceeds RETRY_AFTER_MAX_MS', async () => {
    vi.useFakeTimers()
    try {
      let attempt = 0
      const adapter: LLMAdapter = {
        async *stream(): AsyncGenerator<StreamChunk> {
          attempt++
          yield { type: 'message_start', messageId: 'msg' }
          throw new HttpResponseError(429, 'come back in an hour', 'test', 3_600_000)
        },
        updateConfig() {},
      }

      const expectation = expect(callNonStreaming(adapter, defaultParams)).rejects.toThrow(/次尝试/)
      // 不推进任何时间：不得发起第二次 attempt
      await expectation
      expect(attempt).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
