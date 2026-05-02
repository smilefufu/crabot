import { describe, it, expect } from 'vitest'
import { callNonStreaming, type LLMAdapter, type LLMStreamParams } from '../../src/engine/llm-adapter'
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
    expect(retries[0].source).toBe('mid-stream')
    expect(retries[0].error).toBe('socket dropped')
  }, 30_000)
})
