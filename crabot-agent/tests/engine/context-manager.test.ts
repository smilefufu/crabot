import { describe, it, expect } from 'vitest'
import {
  createUserMessage,
  createAssistantMessage,
  createToolResultMessage,
  type EngineMessage,
  type ContentBlock,
} from '../../src/engine/types'
import { ContextManager } from '../../src/engine/context-manager'

function makeTextMessages(count: number, charsEach: number): EngineMessage[] {
  const messages: EngineMessage[] = []
  const text = 'a'.repeat(charsEach)
  for (let i = 0; i < count; i++) {
    if (i % 2 === 0) {
      messages.push(createUserMessage(text))
    } else {
      messages.push(createAssistantMessage([{ type: 'text', text }], 'end_turn'))
    }
  }
  return messages
}

describe('ContextManager', () => {
  describe('estimateMessageTokens', () => {
    it('should return a reasonable estimate for text messages', () => {
      // ~4 chars per token + 4 overhead
      const msg = createUserMessage('Hello, world!') // 13 chars => ~3.25 + 4 = ~7
      const cm = new ContextManager({ maxContextTokens: 10000 })
      const tokens = cm.estimateMessageTokens(msg)

      expect(tokens).toBeGreaterThanOrEqual(5)
      expect(tokens).toBeLessThanOrEqual(15)
    })

    it('should estimate tool_use blocks including name and JSON input length', () => {
      const toolUseBlock: ContentBlock = {
        type: 'tool_use',
        id: 'tu_123',
        name: 'search_documents',
        input: { query: 'find something important', limit: 10 },
      }
      const msg = createAssistantMessage([toolUseBlock], 'tool_use')
      const cm = new ContextManager({ maxContextTokens: 10000 })
      const tokens = cm.estimateMessageTokens(msg)

      // tool name (17 chars) + JSON of input + overhead
      // Should be substantially more than just overhead
      expect(tokens).toBeGreaterThan(10)
    })

    it('should estimate image blocks as ~1000 tokens', () => {
      const msg = createUserMessage([
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'iVBORw0KGgo=',
          },
        },
      ])
      const cm = new ContextManager({ maxContextTokens: 10000 })
      const tokens = cm.estimateMessageTokens(msg)

      // Should include ~1000 for the image + overhead
      expect(tokens).toBeGreaterThanOrEqual(1000)
      expect(tokens).toBeLessThanOrEqual(1100)
    })

    it('should estimate tool result messages', () => {
      const msg = createToolResultMessage('tu_123', 'Found 5 results with details', false)
      const cm = new ContextManager({ maxContextTokens: 10000 })
      const tokens = cm.estimateMessageTokens(msg)

      expect(tokens).toBeGreaterThan(4) // overhead at minimum
    })
  })

  describe('estimateTotalTokens', () => {
    it('should sum tokens across all messages', () => {
      const cm = new ContextManager({ maxContextTokens: 10000 })
      const messages = [
        createUserMessage('Hello'),
        createAssistantMessage([{ type: 'text', text: 'Hi there' }], 'end_turn'),
      ]

      const total = cm.estimateTotalTokens(messages)
      const individual = messages.reduce(
        (sum, msg) => sum + cm.estimateMessageTokens(msg),
        0
      )

      expect(total).toBe(individual)
    })
  })

  describe('shouldCompact', () => {
    it('should return false when token usage is under threshold', () => {
      const cm = new ContextManager({ maxContextTokens: 100000 })
      // Small messages, well under 80% of 100k
      const messages = [
        createUserMessage('Hi'),
        createAssistantMessage([{ type: 'text', text: 'Hello' }], 'end_turn'),
      ]

      expect(cm.shouldCompact(messages)).toBe(false)
    })

    it('should return true when token usage reaches threshold', () => {
      // Use a small maxContextTokens so we can easily exceed 80%
      const cm = new ContextManager({ maxContextTokens: 100, compactThreshold: 0.8 })
      // Each message: 400 chars / 4 = 100 tokens + 4 overhead = 104 tokens
      // 2 messages = ~208 tokens > 80 (80% of 100)
      const messages = makeTextMessages(2, 400)

      expect(cm.shouldCompact(messages)).toBe(true)
    })

    it('should respect custom compactThreshold', () => {
      const cm = new ContextManager({ maxContextTokens: 200, compactThreshold: 0.5 })
      // 1 message with 400 chars => ~104 tokens > 100 (50% of 200)
      const messages = [createUserMessage('a'.repeat(400))]

      expect(cm.shouldCompact(messages)).toBe(true)
    })
  })

  describe('compactMessages', () => {
    it('should preserve recent messages and summarize old ones', () => {
      const cm = new ContextManager({
        maxContextTokens: 10000,
        keepRecentMessages: 2,
      })

      const messages: EngineMessage[] = [
        createUserMessage('First question'),
        createAssistantMessage([{ type: 'text', text: 'First answer' }], 'end_turn'),
        createUserMessage('Second question'),
        createAssistantMessage([{ type: 'text', text: 'Second answer' }], 'end_turn'),
        createUserMessage('Third question'),
        createAssistantMessage([{ type: 'text', text: 'Third answer' }], 'end_turn'),
      ]

      const compacted = cm.compactMessages(messages)

      // Should have: 1 summary message + 2 recent messages = 3
      expect(compacted).toHaveLength(3)

      // First message should be the summary (user role)
      expect(compacted[0].role).toBe('user')
      const summaryContent = compacted[0] as { content: string | ContentBlock[] }
      if (typeof summaryContent.content === 'string') {
        expect(summaryContent.content).toContain('[Summary')
      } else {
        // If content blocks, first block should contain summary
        const textBlock = summaryContent.content.find((b) => b.type === 'text')
        expect(textBlock).toBeDefined()
      }

      // Last 2 messages should be preserved exactly
      expect(compacted[1]).toBe(messages[4])
      expect(compacted[2]).toBe(messages[5])
    })

    it('should return messages as-is when count is at or below keepRecentMessages', () => {
      const cm = new ContextManager({
        maxContextTokens: 10000,
        keepRecentMessages: 6,
      })

      const messages: EngineMessage[] = [
        createUserMessage('Hello'),
        createAssistantMessage([{ type: 'text', text: 'Hi' }], 'end_turn'),
      ]

      const compacted = cm.compactMessages(messages)

      expect(compacted).toHaveLength(2)
      expect(compacted[0]).toBe(messages[0])
      expect(compacted[1]).toBe(messages[1])
    })
  })

  describe('updateFromUsage / getCumulativeUsage', () => {
    it('should track cumulative usage across multiple updates', () => {
      const cm = new ContextManager({ maxContextTokens: 10000 })

      expect(cm.getCumulativeUsage()).toEqual({ inputTokens: 0, outputTokens: 0 })

      cm.updateFromUsage({ inputTokens: 100, outputTokens: 50 })
      expect(cm.getCumulativeUsage()).toEqual({ inputTokens: 100, outputTokens: 50 })

      cm.updateFromUsage({ inputTokens: 200, outputTokens: 75 })
      expect(cm.getCumulativeUsage()).toEqual({ inputTokens: 300, outputTokens: 125 })

      cm.updateFromUsage({ inputTokens: 50, outputTokens: 25 })
      expect(cm.getCumulativeUsage()).toEqual({ inputTokens: 350, outputTokens: 150 })
    })
  })
})
