import { describe, it, expect } from 'vitest'
import {
  createUserMessage,
  createAssistantMessage,
  createToolResultMessage,
  type EngineMessage,
  type ContentBlock,
  type StreamChunk,
} from '../../src/engine/types'
import { ContextManager } from '../../src/engine/context-manager'
import type { LLMAdapter } from '../../src/engine/llm-adapter'

function mockAdapter(responseText: string): LLMAdapter {
  return {
    async *stream() {
      yield { type: 'message_start', messageId: 'msg_1' } as StreamChunk
      yield { type: 'text_delta', text: responseText } as StreamChunk
      yield { type: 'message_end', stopReason: 'end_turn' } as StreamChunk
    },
    updateConfig() {},
  }
}

function mockFailingAdapter(errorMessage: string): LLMAdapter {
  return {
    async *stream() {
      yield { type: 'error', error: errorMessage } as StreamChunk
    },
    updateConfig() {},
  }
}

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

    it('should not split between assistant tool_use and its tool_result', () => {
      // 默认切点会落在 tool_result 上 → recent 首条会变成孤儿。
      // findSafeSplitIndex 回退 1 步，把 assistant_with_tool_use 一起带进 recent。
      const cm = new ContextManager({
        maxContextTokens: 10000,
        keepRecentMessages: 2,
      })

      const messages: EngineMessage[] = [
        createUserMessage('Question 1'),
        createAssistantMessage([{ type: 'text', text: 'Answer 1' }], 'end_turn'),
        createUserMessage('Question 2'),
        createAssistantMessage([
          { type: 'tool_use', id: 'tu_X', name: 'search', input: { q: 'foo' } },
        ], 'tool_use'),
        createToolResultMessage('tu_X', 'Found something', false),
      ]
      // 默认 splitIndex = 5 - 2 = 3 → messages[3] = assistant_with_tool_use（不是 tool_result）。
      // 但 messages[3] 后面紧跟 messages[4] = tool_result，所以这个 split 本身是安全的：
      // recent[0]=assistant_with_tool_use, recent[1]=tool_result，配对完整。
      const compacted = cm.compactMessages(messages)

      // 1 summary + 2 recent，且 recent 完整保留 tool_use → tool_result 配对
      expect(compacted).toHaveLength(3)
      expect(compacted[1]).toBe(messages[3]) // assistant_with_tool_use
      expect(compacted[2]).toBe(messages[4]) // tool_result
    })

    it('should retreat split when default split lands on a tool_result', () => {
      // 构造让默认 split 直接落在 tool_result：
      // [user, assistant_tool_use, tool_result, user, assistant, tool_result]
      //                                ^splitIndex=2 (= 6 - 4) 落在 tool_result 上
      // findSafeSplitIndex 应回退 1 步到 1（assistant_tool_use），让两者一起进 recent
      const cm = new ContextManager({
        maxContextTokens: 10000,
        keepRecentMessages: 4,
      })

      const messages: EngineMessage[] = [
        createUserMessage('Q1'),
        createAssistantMessage([
          { type: 'tool_use', id: 'tu_A', name: 'search', input: {} },
        ], 'tool_use'),
        createToolResultMessage('tu_A', 'A', false),
        createUserMessage('Q2'),
        createAssistantMessage([
          { type: 'tool_use', id: 'tu_B', name: 'search', input: {} },
        ], 'tool_use'),
        createToolResultMessage('tu_B', 'B', false),
      ]

      const compacted = cm.compactMessages(messages)

      // 回退后 splitIndex=1，oldMessages=[Q1]，recent=后 5 条，全部带配对
      expect(compacted).toHaveLength(6) // 1 summary + 5 recent
      expect(compacted[1]).toBe(messages[1]) // assistant_tool_use A
      expect(compacted[2]).toBe(messages[2]) // tool_result A
      expect(compacted[3]).toBe(messages[3])
      expect(compacted[4]).toBe(messages[4])
      expect(compacted[5]).toBe(messages[5])
      // 关键不变量：recent 第一条不是孤儿 tool_result
      expect('toolResults' in compacted[1]).toBe(false)
    })

    it('should return as-is when retreating split would leave nothing to summarize', () => {
      // 全部消息几乎都是 tool_result，回退到 0 → 没东西可压缩
      const cm = new ContextManager({
        maxContextTokens: 10000,
        keepRecentMessages: 1,
      })

      const messages: EngineMessage[] = [
        createAssistantMessage([
          { type: 'tool_use', id: 'tu_X', name: 'x', input: {} },
        ], 'tool_use'),
        createToolResultMessage('tu_X', 'r', false),
      ]
      // splitIndex 默认 = 1，messages[1] 是 tool_result → 回退到 0 → 不压缩
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

  describe('compactWithLLM', () => {
    it('should call LLM with summarization prompt and return summary + recent messages', async () => {
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

      const adapter = mockAdapter('The user asked two questions and received answers about topics.')
      const compacted = await cm.compactWithLLM(messages, adapter, 'test-model')

      // Should have: 1 summary message + 2 recent messages = 3
      expect(compacted).toHaveLength(3)

      // First message should be LLM-generated summary
      expect(compacted[0].role).toBe('user')
      const summaryContent = (compacted[0] as { content: string | ContentBlock[] }).content
      expect(typeof summaryContent).toBe('string')
      expect(summaryContent).toContain('[Earlier conversation summary]')
      expect(summaryContent).toContain('The user asked two questions')

      // Last 2 messages should be preserved exactly
      expect(compacted[1]).toBe(messages[4])
      expect(compacted[2]).toBe(messages[5])
    })

    it('should preserve recent messages unchanged', async () => {
      const cm = new ContextManager({
        maxContextTokens: 10000,
        keepRecentMessages: 3,
      })

      const messages: EngineMessage[] = [
        createUserMessage('Old message 1'),
        createAssistantMessage([{ type: 'text', text: 'Old response 1' }], 'end_turn'),
        createUserMessage('Recent 1'),
        createAssistantMessage([{ type: 'text', text: 'Recent response 1' }], 'end_turn'),
        createUserMessage('Recent 2'),
      ]

      const adapter = mockAdapter('Summary of old conversation.')
      const compacted = await cm.compactWithLLM(messages, adapter, 'test-model')

      // 1 summary + 3 recent = 4
      expect(compacted).toHaveLength(4)
      expect(compacted[1]).toBe(messages[2])
      expect(compacted[2]).toBe(messages[3])
      expect(compacted[3]).toBe(messages[4])
    })

    it('should fall back to text-based compact on LLM error', async () => {
      const cm = new ContextManager({
        maxContextTokens: 10000,
        keepRecentMessages: 2,
      })

      const messages: EngineMessage[] = [
        createUserMessage('First question'),
        createAssistantMessage([{ type: 'text', text: 'First answer' }], 'end_turn'),
        createUserMessage('Second question'),
        createAssistantMessage([{ type: 'text', text: 'Second answer' }], 'end_turn'),
      ]

      const adapter = mockFailingAdapter('LLM service unavailable')
      const compacted = await cm.compactWithLLM(messages, adapter, 'test-model')

      // Should still produce a valid result via text-based fallback
      expect(compacted).toHaveLength(3) // 1 summary + 2 recent
      expect(compacted[0].role).toBe('user')
      const summaryContent = (compacted[0] as { content: string | ContentBlock[] }).content
      expect(typeof summaryContent).toBe('string')
      // Text-based fallback uses [Summary of earlier conversation]
      expect(summaryContent).toContain('[Summary')
    })

    it('should not compact if messages count is at or below keepRecentMessages', async () => {
      const cm = new ContextManager({
        maxContextTokens: 10000,
        keepRecentMessages: 6,
      })

      const messages: EngineMessage[] = [
        createUserMessage('Hello'),
        createAssistantMessage([{ type: 'text', text: 'Hi' }], 'end_turn'),
      ]

      const adapter = mockAdapter('Should not be called')
      const compacted = await cm.compactWithLLM(messages, adapter, 'test-model')

      // Should return messages as-is, same as compactMessages
      expect(compacted).toHaveLength(2)
      expect(compacted[0]).toBe(messages[0])
      expect(compacted[1]).toBe(messages[1])
    })

    it('should include tool call info in the summary prompt', async () => {
      const cm = new ContextManager({
        maxContextTokens: 10000,
        keepRecentMessages: 2,
      })

      const messages: EngineMessage[] = [
        createUserMessage('Search for something'),
        createAssistantMessage([
          { type: 'text', text: 'I will search for that.' },
          { type: 'tool_use', id: 'tu_1', name: 'search_docs', input: { query: 'something' } },
        ], 'tool_use'),
        createToolResultMessage('tu_1', 'Found 5 results', false),
        createUserMessage('Recent question'),
        createAssistantMessage([{ type: 'text', text: 'Recent answer' }], 'end_turn'),
      ]

      let capturedMessages: EngineMessage[] = []
      const capturingAdapter: LLMAdapter = {
        async *stream(params) {
          capturedMessages = [...params.messages]
          yield { type: 'message_start', messageId: 'msg_1' } as StreamChunk
          yield { type: 'text_delta', text: 'Summary with tool usage.' } as StreamChunk
          yield { type: 'message_end', stopReason: 'end_turn' } as StreamChunk
        },
        updateConfig() {},
      }

      const compacted = await cm.compactWithLLM(messages, capturingAdapter, 'test-model')

      // The summary prompt sent to LLM should mention tool calls
      expect(capturedMessages).toHaveLength(1)
      const promptContent = (capturedMessages[0] as { content: string | ContentBlock[] }).content
      expect(typeof promptContent).toBe('string')
      expect(promptContent as string).toContain('search_docs')

      expect(compacted).toHaveLength(3) // 1 summary + 2 recent
    })

    it('should use custom compactSystemPrompt when provided', async () => {
      const customPrompt = 'You are a custom summarizer. Be very brief.'
      const cm = new ContextManager({
        maxContextTokens: 10000,
        keepRecentMessages: 2,
        compactSystemPrompt: customPrompt,
      })

      const messages: EngineMessage[] = [
        createUserMessage('First'),
        createAssistantMessage([{ type: 'text', text: 'Response' }], 'end_turn'),
        createUserMessage('Second'),
        createAssistantMessage([{ type: 'text', text: 'Response 2' }], 'end_turn'),
      ]

      let capturedSystemPrompt = ''
      const capturingAdapter: LLMAdapter = {
        async *stream(params) {
          capturedSystemPrompt = params.systemPrompt
          yield { type: 'message_start', messageId: 'msg_1' } as StreamChunk
          yield { type: 'text_delta', text: 'Brief summary.' } as StreamChunk
          yield { type: 'message_end', stopReason: 'end_turn' } as StreamChunk
        },
        updateConfig() {},
      }

      await cm.compactWithLLM(messages, capturingAdapter, 'test-model')

      expect(capturedSystemPrompt).toBe(customPrompt)
    })
  })
})
