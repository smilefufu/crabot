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
})
