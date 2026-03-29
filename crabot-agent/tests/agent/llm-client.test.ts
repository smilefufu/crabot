import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LLMClient } from '../../src/agent/llm-client.js'
import type { LLMClientConfig } from '../../src/agent/llm-client.js'
import Anthropic from '@anthropic-ai/sdk'

// Mock Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => {
  const MockAnthropic = vi.fn()
  MockAnthropic.prototype.messages = {
    create: vi.fn()
  }
  return { default: MockAnthropic }
})

describe('LlmClient', () => {
  let mockCreate: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    mockCreate = vi.mocked(Anthropic.prototype.messages.create)
  })

  describe('constructor', () => {
    it('应该初始化客户端', () => {
      const config: LLMClientConfig = {
        endpoint: 'http://localhost:4000',
        apikey: 'test-key',
        model: 'claude-3-5-sonnet-20241022',
      }

      const client = new LLMClient(config)
      expect(client).toBeDefined()
    })
  })

  describe('callMessages', () => {
    it('应该成功调用 Anthropic API', async () => {
      const config: LLMClientConfig = {
        endpoint: 'http://localhost:4000',
        apikey: 'test-key',
        model: 'claude-3-5-sonnet-20241022',
      }

      const mockResponse: Anthropic.Message = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello!' }],
        model: 'claude-3-5-sonnet-20241022',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 }
      }

      mockCreate.mockResolvedValue(mockResponse)

      const client = new LLMClient(config)
      const result = await client.callMessages({
        system: 'You are helpful',
        messages: [{ role: 'user', content: 'Hi' }]
      })

      expect(result.content).toEqual(mockResponse.content)
      expect(result.stopReason).toBe('end_turn')
      expect(mockCreate).toHaveBeenCalledWith({
        model: 'claude-3-5-sonnet-20241022',
        system: 'You are helpful',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 16384
      })
    })

    it('应该传递 tools 参数', async () => {
      const config: LLMClientConfig = {
        endpoint: 'http://localhost:4000',
        apikey: 'test-key',
        model: 'claude-3-5-sonnet-20241022',
      }

      const mockResponse: Anthropic.Message = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Using tool' }],
        model: 'claude-3-5-sonnet-20241022',
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 }
      }

      mockCreate.mockResolvedValue(mockResponse)

      const client = new LLMClient(config)
      const tools: Anthropic.Tool[] = [{
        name: 'test_tool',
        description: 'A test tool',
        input_schema: { type: 'object', properties: {} }
      }]

      await client.callMessages({
        system: 'You are helpful',
        messages: [{ role: 'user', content: 'Hi' }],
        tools
      })

      expect(mockCreate).toHaveBeenCalledWith({
        model: 'claude-3-5-sonnet-20241022',
        system: 'You are helpful',
        messages: [{ role: 'user', content: 'Hi' }],
        tools,
        max_tokens: 16384
      })
    })

    it('应该使用自定义 maxTokens', async () => {
      const config: LLMClientConfig = {
        endpoint: 'http://localhost:4000',
        apikey: 'test-key',
        model: 'claude-3-5-sonnet-20241022',
        maxTokens: 8192
      }

      const mockResponse: Anthropic.Message = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello!' }],
        model: 'claude-3-5-sonnet-20241022',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 }
      }

      mockCreate.mockResolvedValue(mockResponse)

      const client = new LLMClient(config)
      await client.callMessages({
        system: 'You are helpful',
        messages: [{ role: 'user', content: 'Hi' }],
      })

      expect(mockCreate).toHaveBeenCalledWith({
        model: 'claude-3-5-sonnet-20241022',
        system: 'You are helpful',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 8192
      })
    })

    it('应该捕获 API 错误并抛出', async () => {
      const config: LLMClientConfig = {
        endpoint: 'http://localhost:4000',
        apikey: 'test-key',
        model: 'claude-3-5-sonnet-20241022',
      }

      mockCreate.mockRejectedValue(new Error('API rate limit exceeded'))

      const client = new LLMClient(config)

      await expect(
        client.callMessages({
          system: 'You are helpful',
          messages: [{ role: 'user', content: 'Hi' }]
        })
      ).rejects.toThrow('API rate limit exceeded')
    })
  })
})