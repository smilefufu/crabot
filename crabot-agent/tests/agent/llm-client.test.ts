import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LlmClient } from '../../src/agent/llm-client.js'
import type { ModelConnectionInfo } from '../../src/types.js'
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
    it('应该使用 anthropic format 初始化客户端', () => {
      const config: ModelConnectionInfo = {
        model_id: 'claude-3-5-sonnet-20241022',
        provider: 'anthropic',
        format: 'anthropic',
        api_key: 'test-key'
      }

      const client = new LlmClient(config)
      expect(client).toBeDefined()
    })

    it('应该抛出错误如果 format 不是 anthropic', () => {
      const config: ModelConnectionInfo = {
        model_id: 'gpt-4',
        provider: 'openai',
        format: 'openai' as any,
        api_key: 'test-key'
      }

      expect(() => new LlmClient(config)).toThrow('Only anthropic format is supported')
    })
  })

  describe('chat', () => {
    it('应该成功调用 Anthropic API', async () => {
      const config: ModelConnectionInfo = {
        model_id: 'claude-3-5-sonnet-20241022',
        provider: 'anthropic',
        format: 'anthropic',
        api_key: 'test-key'
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

      const client = new LlmClient(config)
      const result = await client.chat({
        system: 'You are helpful',
        messages: [{ role: 'user', content: 'Hi' }]
      })

      expect(result).toEqual(mockResponse)
      expect(mockCreate).toHaveBeenCalledWith({
        model: 'claude-3-5-sonnet-20241022',
        system: 'You are helpful',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 4096
      })
    })

    it('应该传递 tools 参数', async () => {
      const config: ModelConnectionInfo = {
        model_id: 'claude-3-5-sonnet-20241022',
        provider: 'anthropic',
        format: 'anthropic',
        api_key: 'test-key'
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

      const client = new LlmClient(config)
      const tools: Anthropic.Tool[] = [{
        name: 'test_tool',
        description: 'A test tool',
        input_schema: { type: 'object', properties: {} }
      }]

      await client.chat({
        system: 'You are helpful',
        messages: [{ role: 'user', content: 'Hi' }],
        tools
      })

      expect(mockCreate).toHaveBeenCalledWith({
        model: 'claude-3-5-sonnet-20241022',
        system: 'You are helpful',
        messages: [{ role: 'user', content: 'Hi' }],
        tools,
        max_tokens: 4096
      })
    })

    it('应该使用自定义 maxTokens', async () => {
      const config: ModelConnectionInfo = {
        model_id: 'claude-3-5-sonnet-20241022',
        provider: 'anthropic',
        format: 'anthropic',
        api_key: 'test-key',
        max_tokens: 8192
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

      const client = new LlmClient(config)
      await client.chat({
        system: 'You are helpful',
        messages: [{ role: 'user', content: 'Hi' }],
        maxTokens: 2048
      })

      expect(mockCreate).toHaveBeenCalledWith({
        model: 'claude-3-5-sonnet-20241022',
        system: 'You are helpful',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 2048
      })
    })

    it('应该捕获 API 错误并抛出带 AGENT_LLM_ERROR code 的错误', async () => {
      const config: ModelConnectionInfo = {
        model_id: 'claude-3-5-sonnet-20241022',
        provider: 'anthropic',
        format: 'anthropic',
        api_key: 'test-key'
      }

      mockCreate.mockRejectedValue(new Error('API rate limit exceeded'))

      const client = new LlmClient(config)

      await expect(
        client.chat({
          system: 'You are helpful',
          messages: [{ role: 'user', content: 'Hi' }]
        })
      ).rejects.toThrow('LLM API call failed: API rate limit exceeded')
    })
  })
})