import { describe, it, expect } from 'vitest'
import {
  createUserMessage,
  createAssistantMessage,
  createToolResultMessage,
  type TextBlock,
  type ImageBlock,
  type ToolUseBlock,
  type ToolResultBlock,
  type ContentBlock,
  type EngineUserMessage,
  type EngineAssistantMessage,
  type EngineToolResultMessage,
  type EngineMessage,
  type ToolDefinition,
  type ToolCallContext,
  type ToolCallResult,
  type StreamChunk,
  type EngineOptions,
  type EngineTurnEvent,
  type EngineResult,
} from '../../src/engine/types'

describe('Engine Types', () => {
  describe('createUserMessage', () => {
    it('should create a user message with a text string', () => {
      const msg = createUserMessage('hello world')

      expect(msg.role).toBe('user')
      expect(msg.content).toBe('hello world')
      expect(msg.id).toBeDefined()
      expect(typeof msg.id).toBe('string')
      expect(msg.id.length).toBeGreaterThan(0)
      expect(msg.timestamp).toBeDefined()
      expect(typeof msg.timestamp).toBe('number')
      expect(msg.timestamp).toBeLessThanOrEqual(Date.now())
    })

    it('should create a user message with multimodal content blocks', () => {
      const blocks: ContentBlock[] = [
        { type: 'text', text: 'Look at this image' },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'iVBORw0KGgo=',
          },
        },
      ]

      const msg = createUserMessage(blocks)

      expect(msg.role).toBe('user')
      expect(Array.isArray(msg.content)).toBe(true)
      expect(msg.content).toHaveLength(2)

      const content = msg.content as ContentBlock[]
      expect(content[0].type).toBe('text')
      expect(content[1].type).toBe('image')
    })

    it('should generate unique ids for each message', () => {
      const msg1 = createUserMessage('first')
      const msg2 = createUserMessage('second')

      expect(msg1.id).not.toBe(msg2.id)
    })
  })

  describe('createAssistantMessage', () => {
    it('should create an assistant message with text and tool_use blocks', () => {
      const content: ContentBlock[] = [
        { type: 'text', text: 'Let me search for that.' },
        {
          type: 'tool_use',
          id: 'tu_123',
          name: 'search',
          input: { query: 'crabot docs' },
        },
      ]

      const msg = createAssistantMessage(content, 'tool_use')

      expect(msg.role).toBe('assistant')
      expect(msg.content).toHaveLength(2)
      expect(msg.content[0].type).toBe('text')
      expect(msg.content[1].type).toBe('tool_use')
      expect(msg.stopReason).toBe('tool_use')
      expect(msg.id).toBeDefined()
      expect(msg.timestamp).toBeDefined()
    })

    it('should create an assistant message with end_turn stop reason', () => {
      const content: ContentBlock[] = [
        { type: 'text', text: 'Here is the answer.' },
      ]

      const msg = createAssistantMessage(content, 'end_turn')

      expect(msg.stopReason).toBe('end_turn')
    })

    it('should create an assistant message with usage info', () => {
      const content: ContentBlock[] = [
        { type: 'text', text: 'Response' },
      ]
      const usage = { inputTokens: 100, outputTokens: 50 }

      const msg = createAssistantMessage(content, 'end_turn', usage)

      expect(msg.usage).toEqual({ inputTokens: 100, outputTokens: 50 })
    })

    it('should create an assistant message with null stop reason', () => {
      const content: ContentBlock[] = [
        { type: 'text', text: 'Partial response' },
      ]

      const msg = createAssistantMessage(content, null)

      expect(msg.stopReason).toBeNull()
    })
  })

  describe('createToolResultMessage', () => {
    it('should create a tool result message for a successful result', () => {
      const msg = createToolResultMessage('tu_123', 'Search found 5 results', false)

      expect(msg.role).toBe('user')
      expect(msg.toolResults).toHaveLength(1)
      expect(msg.toolResults[0]).toEqual({
        tool_use_id: 'tu_123',
        content: 'Search found 5 results',
        is_error: false,
      })
      expect(msg.id).toBeDefined()
      expect(msg.timestamp).toBeDefined()
    })

    it('should create a tool result message for an error result', () => {
      const msg = createToolResultMessage('tu_456', 'Connection timeout', true)

      expect(msg.toolResults[0]).toEqual({
        tool_use_id: 'tu_456',
        content: 'Connection timeout',
        is_error: true,
      })
    })

    it('should generate unique ids', () => {
      const msg1 = createToolResultMessage('tu_1', 'result1', false)
      const msg2 = createToolResultMessage('tu_2', 'result2', false)

      expect(msg1.id).not.toBe(msg2.id)
    })
  })

  describe('Type compatibility checks', () => {
    it('EngineMessage union should accept all message types', () => {
      const userMsg: EngineMessage = createUserMessage('hello')
      const assistantMsg: EngineMessage = createAssistantMessage(
        [{ type: 'text', text: 'hi' }],
        'end_turn'
      )
      const toolResultMsg: EngineMessage = createToolResultMessage('tu_1', 'ok', false)

      expect(userMsg.role).toBe('user')
      expect(assistantMsg.role).toBe('assistant')
      expect(toolResultMsg.role).toBe('user')
    })
  })
})
