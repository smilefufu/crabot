import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runAgentLoop } from '../../src/agent/agent-loop.js'
import { LlmClient } from '../../src/agent/llm-client.js'
import type { AgentLoopOptions } from '../../src/types.js'
import type Anthropic from '@anthropic-ai/sdk'

vi.mock('../../src/agent/llm-client.js')

describe('runAgentLoop', () => {
  let mockLlm: LlmClient
  let mockChat: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockChat = vi.fn()
    mockLlm = {
      chat: mockChat
    } as unknown as LlmClient
  })

  it('应该在 end_turn 时直接返回', async () => {
    const mockResponse: Anthropic.Message = {
      id: 'msg_123',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello, how can I help?' }],
      model: 'claude-3-5-sonnet-20241022',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 }
    }

    mockChat.mockResolvedValue(mockResponse)

    const options: AgentLoopOptions = {
      systemPrompt: 'You are helpful',
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [],
      maxIterations: 10,
      onToolCall: vi.fn()
    }

    const result = await runAgentLoop(mockLlm, options)

    expect(result.finalText).toBe('Hello, how can I help?')
    expect(result.toolCallCount).toBe(0)
    expect(result.aborted).toBe(false)
    expect(mockChat).toHaveBeenCalledTimes(1)
  })

  it('应该处理 tool_use 并继续迭代', async () => {
    const response1: Anthropic.Message = {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me check that' },
        {
          type: 'tool_use',
          id: 'tool_1',
          name: 'get_weather',
          input: { city: 'Beijing' }
        }
      ],
      model: 'claude-3-5-sonnet-20241022',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 }
    }

    const response2: Anthropic.Message = {
      id: 'msg_2',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'The weather is sunny' }],
      model: 'claude-3-5-sonnet-20241022',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 30, output_tokens: 10 }
    }

    mockChat.mockResolvedValueOnce(response1).mockResolvedValueOnce(response2)

    const onToolCall = vi.fn().mockResolvedValue({ temperature: 25, condition: 'sunny' })

    const options: AgentLoopOptions = {
      systemPrompt: 'You are helpful',
      messages: [{ role: 'user', content: 'What is the weather?' }],
      tools: [
        {
          name: 'get_weather',
          description: 'Get weather',
          input_schema: { type: 'object', properties: {} }
        }
      ],
      maxIterations: 10,
      onToolCall
    }

    const result = await runAgentLoop(mockLlm, options)

    expect(result.finalText).toBe('The weather is sunny')
    expect(result.toolCallCount).toBe(1)
    expect(result.aborted).toBe(false)
    expect(mockChat).toHaveBeenCalledTimes(2)
    expect(onToolCall).toHaveBeenCalledWith('get_weather', { city: 'Beijing' })
  })

  it('应该在达到 maxIterations 时停止', async () => {
    const mockResponse: Anthropic.Message = {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'tool_1',
          name: 'infinite_tool',
          input: {}
        }
      ],
      model: 'claude-3-5-sonnet-20241022',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 }
    }

    mockChat.mockResolvedValue(mockResponse)

    const options: AgentLoopOptions = {
      systemPrompt: 'You are helpful',
      messages: [{ role: 'user', content: 'Start' }],
      tools: [
        {
          name: 'infinite_tool',
          description: 'Infinite tool',
          input_schema: { type: 'object', properties: {} }
        }
      ],
      maxIterations: 3,
      onToolCall: vi.fn().mockResolvedValue({ ok: true })
    }

    const result = await runAgentLoop(mockLlm, options)

    expect(result.toolCallCount).toBe(3)
    expect(mockChat).toHaveBeenCalledTimes(3)
  })

  it('应该支持 AbortSignal 取消', async () => {
    const mockResponse: Anthropic.Message = {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'tool_1',
          name: 'slow_tool',
          input: {}
        }
      ],
      model: 'claude-3-5-sonnet-20241022',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 }
    }

    mockChat.mockResolvedValue(mockResponse)

    const signal = { aborted: false }
    const onToolCall = vi.fn().mockImplementation(async () => {
      signal.aborted = true
      return { ok: true }
    })

    const options: AgentLoopOptions = {
      systemPrompt: 'You are helpful',
      messages: [{ role: 'user', content: 'Start' }],
      tools: [
        {
          name: 'slow_tool',
          description: 'Slow tool',
          input_schema: { type: 'object', properties: {} }
        }
      ],
      maxIterations: 10,
      onToolCall,
      signal
    }

    const result = await runAgentLoop(mockLlm, options)

    expect(result.aborted).toBe(true)
    expect(result.toolCallCount).toBe(1)
  })

  it('应该提取多个 text blocks 的文本', async () => {
    const mockResponse: Anthropic.Message = {
      id: 'msg_123',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: 'First part. ' },
        { type: 'text', text: 'Second part.' }
      ],
      model: 'claude-3-5-sonnet-20241022',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 }
    }

    mockChat.mockResolvedValue(mockResponse)

    const options: AgentLoopOptions = {
      systemPrompt: 'You are helpful',
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [],
      maxIterations: 10,
      onToolCall: vi.fn()
    }

    const result = await runAgentLoop(mockLlm, options)

    expect(result.finalText).toBe('First part. Second part.')
  })

  it('应该处理多个 tool_use 在同一响应中', async () => {
    const response1: Anthropic.Message = {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'tool_1',
          name: 'tool_a',
          input: { param: 'a' }
        },
        {
          type: 'tool_use',
          id: 'tool_2',
          name: 'tool_b',
          input: { param: 'b' }
        }
      ],
      model: 'claude-3-5-sonnet-20241022',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 }
    }

    const response2: Anthropic.Message = {
      id: 'msg_2',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Done' }],
      model: 'claude-3-5-sonnet-20241022',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 30, output_tokens: 10 }
    }

    mockChat.mockResolvedValueOnce(response1).mockResolvedValueOnce(response2)

    const onToolCall = vi.fn().mockResolvedValue({ ok: true })

    const options: AgentLoopOptions = {
      systemPrompt: 'You are helpful',
      messages: [{ role: 'user', content: 'Run tools' }],
      tools: [
        {
          name: 'tool_a',
          description: 'Tool A',
          input_schema: { type: 'object', properties: {} }
        },
        {
          name: 'tool_b',
          description: 'Tool B',
          input_schema: { type: 'object', properties: {} }
        }
      ],
      maxIterations: 10,
      onToolCall
    }

    const result = await runAgentLoop(mockLlm, options)

    expect(result.finalText).toBe('Done')
    expect(result.toolCallCount).toBe(2)
    expect(onToolCall).toHaveBeenCalledTimes(2)
    expect(onToolCall).toHaveBeenCalledWith('tool_a', { param: 'a' })
    expect(onToolCall).toHaveBeenCalledWith('tool_b', { param: 'b' })
  })
})