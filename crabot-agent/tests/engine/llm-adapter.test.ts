import { describe, it, expect, vi } from 'vitest'
import {
  normalizeMessagesForAnthropic,
  normalizeMessagesForOpenAI,
  toOpenAITool,
  readSSELines,
  AnthropicAdapter,
  OpenAIAdapter,
  createAdapter,
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

  it('should normalize tool result with images for Anthropic', () => {
    const msg: EngineMessage = {
      id: 'test-id',
      role: 'user',
      toolResults: [{
        tool_use_id: 'tu_1',
        content: 'Screenshot captured',
        images: [{ media_type: 'image/png', data: 'abc123' }],
        is_error: false,
      }],
      timestamp: Date.now(),
    } as EngineMessage

    const result = normalizeMessagesForAnthropic([msg])

    expect(result).toHaveLength(1)
    expect(result[0].role).toBe('user')
    const toolResult = (result[0] as { content: Array<Record<string, unknown>> }).content[0]
    expect(toolResult.type).toBe('tool_result')
    expect(toolResult.tool_use_id).toBe('tu_1')
    expect(toolResult.is_error).toBe(false)
    const content = toolResult.content as Array<Record<string, unknown>>
    expect(content).toHaveLength(2)
    expect(content[0]).toEqual({ type: 'text', text: 'Screenshot captured' })
    expect(content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'abc123' },
    })
  })

  it('should normalize tool result with images but no text content', () => {
    const msg: EngineMessage = {
      id: 'test-id',
      role: 'user',
      toolResults: [{
        tool_use_id: 'tu_1',
        content: '',
        images: [{ media_type: 'image/png', data: 'xyz789' }],
        is_error: false,
      }],
      timestamp: Date.now(),
    } as EngineMessage

    const result = normalizeMessagesForAnthropic([msg])
    const toolResult = (result[0] as { content: Array<Record<string, unknown>> }).content[0]
    const content = toolResult.content as Array<Record<string, unknown>>
    // Empty string content should be omitted
    expect(content).toHaveLength(1)
    expect(content[0].type).toBe('image')
  })

  it('should normalize tool result without images as plain text (unchanged)', () => {
    const msg = createToolResultMessage('tu_1', 'Just text', false)
    const result = normalizeMessagesForAnthropic([msg])

    expect(result[0].role).toBe('user')
    const toolResult = (result[0] as { content: Array<Record<string, unknown>> }).content[0]
    // No content array — just string content
    expect(toolResult.content).toBe('Just text')
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

// --- OpenAI Adapter Tests ---

describe('normalizeMessagesForOpenAI', () => {
  it('should convert a text user message', () => {
    const msg = createUserMessage('hello world')
    const result = normalizeMessagesForOpenAI([msg])

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      role: 'user',
      content: 'hello world',
    })
  })

  it('should convert an assistant message with tool_use to tool_calls format', () => {
    const msg = createAssistantMessage(
      [
        { type: 'text', text: 'Let me search.' },
        { type: 'tool_use', id: 'tc_1', name: 'search', input: { q: 'test' } },
      ],
      'tool_use'
    )
    const result = normalizeMessagesForOpenAI([msg])

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      role: 'assistant',
      content: 'Let me search.',
      tool_calls: [
        {
          id: 'tc_1',
          type: 'function',
          function: {
            name: 'search',
            arguments: '{"q":"test"}',
          },
        },
      ],
    })
  })

  it('should convert an assistant text-only message without tool_calls', () => {
    const msg = createAssistantMessage(
      [{ type: 'text', text: 'The answer is 42.' }],
      'end_turn'
    )
    const result = normalizeMessagesForOpenAI([msg])

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      role: 'assistant',
      content: 'The answer is 42.',
    })
  })

  it('should convert a tool result to OpenAI tool message', () => {
    const msg = createToolResultMessage('tc_1', 'Found 5 results', false)
    const result = normalizeMessagesForOpenAI([msg])

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      role: 'tool',
      tool_call_id: 'tc_1',
      content: 'Found 5 results',
    })
  })

  it('should split multiple tool results into separate tool messages', () => {
    const msg: EngineMessage = {
      id: 'test-id',
      role: 'user',
      toolResults: [
        { tool_use_id: 'tc_1', content: 'result1', is_error: false },
        { tool_use_id: 'tc_2', content: 'result2', is_error: true },
      ],
      timestamp: Date.now(),
    } as EngineMessage

    const result = normalizeMessagesForOpenAI([msg])

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ role: 'tool', tool_call_id: 'tc_1', content: 'result1' })
    expect(result[1]).toEqual({ role: 'tool', tool_call_id: 'tc_2', content: 'result2' })
  })

  it('should convert image block to image_url format with data URI', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Look at this' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'abc123' },
      },
    ]
    const msg = createUserMessage(blocks)
    const result = normalizeMessagesForOpenAI([msg])

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Look at this' },
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,abc123' },
        },
      ],
    })
  })

  it('should convert URL-type image block using the URL directly', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'image',
        source: { type: 'url', media_type: 'image/jpeg', data: 'https://example.com/img.jpg' },
      },
    ]
    const msg = createUserMessage(blocks)
    const result = normalizeMessagesForOpenAI([msg])

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: { url: 'https://example.com/img.jpg' },
        },
      ],
    })
  })

  it('should preserve multi-turn conversation order', () => {
    const messages: EngineMessage[] = [
      createUserMessage('What is 2+2?'),
      createAssistantMessage(
        [
          { type: 'text', text: 'Let me calculate.' },
          { type: 'tool_use', id: 'tc_calc', name: 'calc', input: { expr: '2+2' } },
        ],
        'tool_use'
      ),
      createToolResultMessage('tc_calc', '4', false),
      createAssistantMessage(
        [{ type: 'text', text: 'The answer is 4.' }],
        'end_turn'
      ),
    ]

    const result = normalizeMessagesForOpenAI(messages)

    expect(result).toHaveLength(4)
    expect(result[0]).toEqual({ role: 'user', content: 'What is 2+2?' })
    expect(result[1].role).toBe('assistant')
    expect(result[2]).toEqual({ role: 'tool', tool_call_id: 'tc_calc', content: '4' })
    expect(result[3]).toEqual({ role: 'assistant', content: 'The answer is 4.' })
  })
})

describe('toOpenAITool', () => {
  it('should convert ToolDefinition to OpenAI function tool format', () => {
    const tool: ToolDefinition = {
      name: 'Read',
      description: 'Read file',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
        },
        required: ['path'],
      },
      isReadOnly: true,
      call: async () => ({ output: '', isError: false }),
    }

    const result = toOpenAITool(tool)

    expect(result).toEqual({
      type: 'function',
      function: {
        name: 'Read',
        description: 'Read file',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path' },
          },
          required: ['path'],
        },
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

    const result = toOpenAITool(tool)

    expect(result).not.toHaveProperty('call')
    expect(result).not.toHaveProperty('isReadOnly')
    expect(result).not.toHaveProperty('inputSchema')
  })
})

describe('readSSELines', () => {
  function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    let index = 0
    return new ReadableStream({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(encoder.encode(chunks[index]))
          index++
        } else {
          controller.close()
        }
      },
    })
  }

  it('should parse SSE data lines', async () => {
    const stream = makeStream([
      'data: {"id":"1"}\n\ndata: {"id":"2"}\n\n',
    ])

    const lines: string[] = []
    for await (const line of readSSELines(stream)) {
      lines.push(line)
    }

    expect(lines).toEqual(['{"id":"1"}', '{"id":"2"}'])
  })

  it('should handle chunks split across boundaries', async () => {
    const stream = makeStream([
      'data: {"part',
      '":"one"}\n\ndata: {"part":"two"}\n\n',
    ])

    const lines: string[] = []
    for await (const line of readSSELines(stream)) {
      lines.push(line)
    }

    expect(lines).toEqual(['{"part":"one"}', '{"part":"two"}'])
  })

  it('should yield [DONE] line', async () => {
    const stream = makeStream([
      'data: {"id":"1"}\n\ndata: [DONE]\n\n',
    ])

    const lines: string[] = []
    for await (const line of readSSELines(stream)) {
      lines.push(line)
    }

    expect(lines).toEqual(['{"id":"1"}', '[DONE]'])
  })

  it('should skip empty lines and non-data lines', async () => {
    const stream = makeStream([
      ': comment\n\ndata: {"ok":true}\n\n',
    ])

    const lines: string[] = []
    for await (const line of readSSELines(stream)) {
      lines.push(line)
    }

    expect(lines).toEqual(['{"ok":true}'])
  })
})

describe('OpenAIAdapter', () => {
  describe('constructor', () => {
    it('should create an adapter with the given config', () => {
      const config: LLMAdapterConfig = {
        endpoint: 'http://localhost:4000',
        apikey: 'test-key',
      }

      const adapter = new OpenAIAdapter(config)
      expect(adapter).toBeDefined()
    })
  })

  describe('updateConfig', () => {
    it('should accept partial config updates', () => {
      const adapter = new OpenAIAdapter({
        endpoint: 'http://localhost:4000',
        apikey: 'old-key',
      })

      adapter.updateConfig({ apikey: 'new-key' })
      expect(adapter).toBeDefined()
    })

    it('should accept endpoint-only updates', () => {
      const adapter = new OpenAIAdapter({
        endpoint: 'http://localhost:4000',
        apikey: 'test-key',
      })

      adapter.updateConfig({ endpoint: 'http://localhost:5000' })
      expect(adapter).toBeDefined()
    })
  })
})

describe('createAdapter', () => {
  const baseConfig = {
    endpoint: 'http://localhost:4000',
    apikey: 'test-key',
  }

  it('should return AnthropicAdapter for format=anthropic', () => {
    const adapter = createAdapter({ ...baseConfig, format: 'anthropic' })
    expect(adapter).toBeInstanceOf(AnthropicAdapter)
  })

  it('should return OpenAIAdapter for format=openai', () => {
    const adapter = createAdapter({ ...baseConfig, format: 'openai' })
    expect(adapter).toBeInstanceOf(OpenAIAdapter)
  })

  it('should return OpenAIAdapter for format=gemini (via LiteLLM)', () => {
    const adapter = createAdapter({ ...baseConfig, format: 'gemini' })
    expect(adapter).toBeInstanceOf(OpenAIAdapter)
  })

  it('should throw for unsupported format', () => {
    expect(() => {
      createAdapter({ ...baseConfig, format: 'unknown' as 'anthropic' })
    }).toThrow('Unsupported LLM format')
  })
})
