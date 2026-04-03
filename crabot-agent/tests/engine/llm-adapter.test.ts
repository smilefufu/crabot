import { describe, it, expect, vi } from 'vitest'
import {
  normalizeMessagesForAnthropic,
  AnthropicAdapter,
  type LLMAdapterConfig,
} from '../../src/engine/llm-adapter'
import {
  createUserMessage,
  createAssistantMessage,
  createToolResultMessage,
  type EngineMessage,
  type ToolDefinition,
  type ContentBlock,
} from '../../src/engine/types'

describe('normalizeMessagesForAnthropic', () => {
  it('should convert a text user message', () => {
    const msg = createUserMessage('hello world')
    const result = normalizeMessagesForAnthropic([msg])

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      role: 'user',
      content: 'hello world',
    })
  })

  it('should convert a user message with content blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Look at this' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'abc123' },
      },
    ]
    const msg = createUserMessage(blocks)
    const result = normalizeMessagesForAnthropic([msg])

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Look at this' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'abc123' },
        },
      ],
    })
  })

  it('should convert an assistant message', () => {
    const msg = createAssistantMessage(
      [
        { type: 'text', text: 'Let me help.' },
        { type: 'tool_use', id: 'tu_1', name: 'search', input: { q: 'test' } },
      ],
      'tool_use'
    )
    const result = normalizeMessagesForAnthropic([msg])

    expect(result).toHaveLength(1)
    expect(result[0].role).toBe('assistant')
    expect(result[0].content).toEqual([
      { type: 'text', text: 'Let me help.' },
      { type: 'tool_use', id: 'tu_1', name: 'search', input: { q: 'test' } },
    ])
  })

  it('should convert a tool result message', () => {
    const msg = createToolResultMessage('tu_1', 'Found 5 results', false)
    const result = normalizeMessagesForAnthropic([msg])

    expect(result).toHaveLength(1)
    expect(result[0].role).toBe('user')
    expect(result[0].content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'tu_1',
        content: 'Found 5 results',
        is_error: false,
      },
    ])
  })

  it('should convert a tool result message with is_error true', () => {
    const msg = createToolResultMessage('tu_2', 'Timeout', true)
    const result = normalizeMessagesForAnthropic([msg])

    expect(result).toHaveLength(1)
    expect(result[0].content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'tu_2',
        content: 'Timeout',
        is_error: true,
      },
    ])
  })

  it('should handle multi-turn conversation order', () => {
    const messages: EngineMessage[] = [
      createUserMessage('What is 2+2?'),
      createAssistantMessage(
        [
          { type: 'text', text: 'Let me calculate.' },
          { type: 'tool_use', id: 'tu_calc', name: 'calc', input: { expr: '2+2' } },
        ],
        'tool_use'
      ),
      createToolResultMessage('tu_calc', '4', false),
      createAssistantMessage(
        [{ type: 'text', text: 'The answer is 4.' }],
        'end_turn'
      ),
    ]

    const result = normalizeMessagesForAnthropic(messages)

    expect(result).toHaveLength(4)
    expect(result[0].role).toBe('user')
    expect(result[0].content).toBe('What is 2+2?')
    expect(result[1].role).toBe('assistant')
    expect(result[2].role).toBe('user')
    expect(result[3].role).toBe('assistant')
    expect(result[3].content).toEqual([{ type: 'text', text: 'The answer is 4.' }])
  })

  it('should handle tool result message with multiple results', () => {
    const msg: EngineMessage = {
      id: 'test-id',
      role: 'user',
      toolResults: [
        { tool_use_id: 'tu_1', content: 'result1', is_error: false },
        { tool_use_id: 'tu_2', content: 'result2', is_error: true },
      ],
      timestamp: Date.now(),
    } as EngineMessage

    const result = normalizeMessagesForAnthropic([msg])

    expect(result).toHaveLength(1)
    expect(result[0].role).toBe('user')
    expect(result[0].content).toEqual([
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'result1', is_error: false },
      { type: 'tool_result', tool_use_id: 'tu_2', content: 'result2', is_error: true },
    ])
  })
})

describe('AnthropicAdapter', () => {
  describe('constructor', () => {
    it('should create an adapter with the given config', () => {
      const config: LLMAdapterConfig = {
        endpoint: 'http://localhost:4000',
        apikey: 'test-key',
      }

      const adapter = new AnthropicAdapter(config)
      expect(adapter).toBeDefined()
    })
  })

  describe('toAnthropicTool', () => {
    it('should convert a ToolDefinition to Anthropic tool format', () => {
      const tool: ToolDefinition = {
        name: 'search',
        description: 'Search the web',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
          },
          required: ['query'],
        },
        isReadOnly: true,
        call: async () => ({ output: '', isError: false }),
      }

      const result = AnthropicAdapter.toAnthropicTool(tool)

      expect(result).toEqual({
        name: 'search',
        description: 'Search the web',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
          },
          required: ['query'],
        },
      })
    })

    it('should not include call or isReadOnly in the output', () => {
      const tool: ToolDefinition = {
        name: 'noop',
        description: 'Does nothing',
        inputSchema: { type: 'object' },
        isReadOnly: false,
        call: async () => ({ output: '', isError: false }),
      }

      const result = AnthropicAdapter.toAnthropicTool(tool)

      expect(result).not.toHaveProperty('call')
      expect(result).not.toHaveProperty('isReadOnly')
      expect(result).not.toHaveProperty('inputSchema')
    })
  })

  describe('updateConfig', () => {
    it('should accept partial config updates', () => {
      const adapter = new AnthropicAdapter({
        endpoint: 'http://localhost:4000',
        apikey: 'old-key',
      })

      // Should not throw
      adapter.updateConfig({ apikey: 'new-key' })
      expect(adapter).toBeDefined()
    })

    it('should accept endpoint-only updates', () => {
      const adapter = new AnthropicAdapter({
        endpoint: 'http://localhost:4000',
        apikey: 'test-key',
      })

      adapter.updateConfig({ endpoint: 'http://localhost:5000' })
      expect(adapter).toBeDefined()
    })
  })
})
