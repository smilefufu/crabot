import { describe, it, expect } from 'vitest'
import {
  createUserMessage,
  createAssistantMessage,
  createToolResultMessage,
  type EngineMessage,
  type ContentBlock,
  type StreamChunk,
} from '../../src/engine/types'
import { ContextManager, CompactionFailedError } from '../../src/engine/context-manager'
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

/** 摘要调用中途被取消：adapter 直接抛 AbortError（callNonStreaming 不重试、原样上抛）。 */
function mockAbortingAdapter(): LLMAdapter {
  return {
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new DOMException('Aborted', 'AbortError')
    },
    updateConfig() {},
  }
}

interface CapturedCall {
  messages: EngineMessage[]
  systemPrompt: string
  signal?: AbortSignal
}

function capturingAdapter(responseText: string): { adapter: LLMAdapter; captured: CapturedCall } {
  const captured: CapturedCall = { messages: [], systemPrompt: '' }
  const adapter: LLMAdapter = {
    async *stream(params) {
      captured.messages = [...params.messages]
      captured.systemPrompt = params.systemPrompt
      captured.signal = params.signal
      yield { type: 'message_start', messageId: 'msg_1' } as StreamChunk
      yield { type: 'text_delta', text: responseText } as StreamChunk
      yield { type: 'message_end', stopReason: 'end_turn' } as StreamChunk
    },
    updateConfig() {},
  }
  return { adapter, captured }
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

    // spec 2026-07-21 改动 3：真实 usage 触发
    it('should trigger on lastObservedContextTokens even when message estimate is small', () => {
      const cm = new ContextManager({ maxContextTokens: 1000, compactThreshold: 0.8 })
      // 消息本身估算远低于阈值，但上一轮 usage 观测已达 900 >= 800
      const messages = makeTextMessages(2, 20)

      expect(cm.shouldCompact(messages, {
        lastObservedContextTokens: 900,
        messageCountAtObservation: 2,
      })).toBe(true)
    })

    it('should not trigger when lastObservedContextTokens is under threshold', () => {
      const cm = new ContextManager({ maxContextTokens: 1000, compactThreshold: 0.8 })
      const messages = makeTextMessages(2, 20)

      expect(cm.shouldCompact(messages, {
        lastObservedContextTokens: 500,
        messageCountAtObservation: 2,
      })).toBe(false)
    })

    it('should add estimated delta of messages appended after the observation', () => {
      const cm = new ContextManager({ maxContextTokens: 1000, compactThreshold: 0.8 })
      // 观测时 2 条消息（700 tokens），其后新增 2 条大消息：
      // 每条 400 chars / 4 + 4 = 104，delta=208，700+208=908 >= 800 → 触发
      const messages = makeTextMessages(4, 400)

      expect(cm.shouldCompact(messages, {
        lastObservedContextTokens: 700,
        messageCountAtObservation: 2,
      })).toBe(true)

      // 同一观测值但只算前 2 条（无新增消息）→ 不触发
      expect(cm.shouldCompact(messages.slice(0, 2), {
        lastObservedContextTokens: 700,
        messageCountAtObservation: 2,
      })).toBe(false)
    })

    it('should fall back to estimation when observation is stale (messages shrunk)', () => {
      const cm = new ContextManager({ maxContextTokens: 1000, compactThreshold: 0.8 })
      // messageCountAtObservation > messages.length（compaction 后消息数回缩）→ 观测失效
      const messages = makeTextMessages(2, 20)

      expect(cm.shouldCompact(messages, {
        lastObservedContextTokens: 900,
        messageCountAtObservation: 10,
      })).toBe(false)
    })

    // spec 2026-07-21 改动 3：usage 缺失时估算计入 system prompt + tools schema
    it('should count system prompt length in the estimation fallback', () => {
      const cm = new ContextManager({ maxContextTokens: 1000, compactThreshold: 0.8 })
      const messages = makeTextMessages(2, 20)
      // 4000 chars / 4 = 1000 tokens >= 800 → 触发
      const systemPrompt = 's'.repeat(4000)

      expect(cm.shouldCompact(messages, { systemPrompt })).toBe(true)
      // 不传 systemPrompt → 纯消息估算远低于阈值
      expect(cm.shouldCompact(messages)).toBe(false)
    })

    it('should count tools schema in the estimation fallback', () => {
      const cm = new ContextManager({ maxContextTokens: 1000, compactThreshold: 0.8 })
      const messages = makeTextMessages(2, 20)
      const tools = [
        {
          name: 'big_tool',
          description: 'd'.repeat(3200),
          inputSchema: { type: 'object', properties: {} },
          isReadOnly: false,
        },
      ]
      // description 3200 chars / 4 ≈ 800 tokens >= 800 → 触发
      expect(cm.shouldCompact(messages, { tools })).toBe(true)
      expect(cm.shouldCompact(messages)).toBe(false)
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

      // Should have: 1 first user msg (immortal) + 1 summary + 2 recent = 4
      expect(compacted).toHaveLength(4)

      // First slot 是被钉住的首条 user message（含 task_origin 等）
      expect(compacted[0]).toBe(messages[0])

      // Second slot 才是摘要
      expect(compacted[1].role).toBe('user')
      const summaryContent = compacted[1] as { content: string | ContentBlock[] }
      if (typeof summaryContent.content === 'string') {
        expect(summaryContent.content).toContain('[Summary')
      } else {
        const textBlock = summaryContent.content.find((b) => b.type === 'text')
        expect(textBlock).toBeDefined()
      }

      // Last 2 messages should be preserved exactly
      expect(compacted[2]).toBe(messages[4])
      expect(compacted[3]).toBe(messages[5])
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

      // 1 first + 1 summary + 2 recent，且 recent 完整保留 tool_use → tool_result 配对
      expect(compacted).toHaveLength(4)
      expect(compacted[0]).toBe(messages[0]) // 首条 user message 钉住
      expect(compacted[2]).toBe(messages[3]) // assistant_with_tool_use
      expect(compacted[3]).toBe(messages[4]) // tool_result
    })

    it('should retreat split when default split lands on a tool_result', () => {
      // 构造让默认 split 直接落在 tool_result：
      // [Q0, Q1, assistant_tool_use, tool_result, user, assistant, tool_result]
      //                                ^splitIndex=3 (= 7 - 4) 落在 tool_result 上
      // findSafeSplitIndex 应回退 1 步到 2（assistant_tool_use），让两者一起进 recent
      const cm = new ContextManager({
        maxContextTokens: 10000,
        keepRecentMessages: 4,
      })

      const messages: EngineMessage[] = [
        createUserMessage('Q0'),
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

      // 回退后 splitIndex=2，首条钉住=Q0，oldMessages=[Q1]，recent=后 5 条，全部带配对
      expect(compacted).toHaveLength(7) // 1 first + 1 summary + 5 recent
      expect(compacted[0]).toBe(messages[0]) // 首条 user message 钉住
      expect(compacted[2]).toBe(messages[2]) // assistant_tool_use A
      expect(compacted[3]).toBe(messages[3]) // tool_result A
      expect(compacted[4]).toBe(messages[4])
      expect(compacted[5]).toBe(messages[5])
      expect(compacted[6]).toBe(messages[6])
      // 关键不变量：recent 第一条不是孤儿 tool_result
      expect('toolResults' in compacted[2]).toBe(false)
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

      // Should have: 1 first + 1 summary + 2 recent = 4
      expect(compacted).toHaveLength(4)

      // First slot 是被钉住的首条 user message
      expect(compacted[0]).toBe(messages[0])

      // Second slot 是 LLM 摘要
      expect(compacted[1].role).toBe('user')
      const summaryContent = (compacted[1] as { content: string | ContentBlock[] }).content
      expect(typeof summaryContent).toBe('string')
      expect(summaryContent).toContain('[Earlier conversation summary]')
      expect(summaryContent).toContain('The user asked two questions')

      // Last 2 messages should be preserved exactly
      expect(compacted[2]).toBe(messages[4])
      expect(compacted[3]).toBe(messages[5])
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

      // 1 first + 1 summary + 3 recent = 5
      expect(compacted).toHaveLength(5)
      expect(compacted[0]).toBe(messages[0])
      expect(compacted[2]).toBe(messages[2])
      expect(compacted[3]).toBe(messages[3])
      expect(compacted[4]).toBe(messages[4])
    })

    // 坑 1：摘要失败静默降级成"假压缩"。旧实现 catch 后回退 compactMessages，
    // 而后者对 tool_result 返回全量正文——上层看到"压缩成功"，token 却几乎没降。
    it('rejects with CompactionFailedError instead of a fake compaction when the summary LLM fails', async () => {
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

      await expect(cm.compactWithLLM(messages, adapter, 'test-model')).rejects.toBeInstanceOf(
        CompactionFailedError,
      )
      // 原始 messages 不被改写
      expect(messages).toHaveLength(4)
    })

    it('never returns a "compacted" result whose tokens did not actually drop (summary LLM failure)', async () => {
      // 复现坑 1 的可观测后果：worker 场景的 token 由 tool_result 正文主导，
      // 文本回退只丢掉 tool_use 入参/图片/消息开销，正文一字不减。
      const cm = new ContextManager({
        maxContextTokens: 100000,
        keepRecentMessages: 2,
      })

      const bashOutput = 'x'.repeat(40000)
      const messages: EngineMessage[] = [
        createUserMessage('任务来源：跑一遍测试'),
        createAssistantMessage(
          [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'pnpm test' } }],
          'tool_use',
        ),
        createToolResultMessage('tu_1', bashOutput, false),
        createAssistantMessage(
          [{ type: 'tool_use', id: 'tu_2', name: 'Bash', input: { command: 'pnpm test again' } }],
          'tool_use',
        ),
        createToolResultMessage('tu_2', bashOutput, false),
        createUserMessage('继续'),
        createAssistantMessage([{ type: 'text', text: '好的' }], 'end_turn'),
      ]
      const beforeTokens = cm.estimateTotalTokens(messages)

      const adapter = mockFailingAdapter('429 rate limited (retries exhausted)')
      const outcome = await cm
        .compactWithLLM(messages, adapter, 'test-model')
        .then((compacted) => ({ resolved: true as const, compacted }))
        .catch((error: unknown) => ({ resolved: false as const, error }))

      if (outcome.resolved) {
        // 若实现选择返回而不是抛错，那也必须是"真的压下来了"，不许假装成功
        expect(cm.estimateTotalTokens(outcome.compacted)).toBeLessThan(beforeTokens / 2)
      } else {
        expect(outcome.error).toBeInstanceOf(CompactionFailedError)
      }
    })

    it('rejects when the summary LLM returns empty text', async () => {
      // 空摘要 = 整段被折叠内容凭空消失，同样属于"假装压缩成功"
      const cm = new ContextManager({ maxContextTokens: 10000, keepRecentMessages: 2 })
      const messages: EngineMessage[] = [
        createUserMessage('First question'),
        createAssistantMessage([{ type: 'text', text: 'First answer' }], 'end_turn'),
        createUserMessage('Second question'),
        createAssistantMessage([{ type: 'text', text: 'Second answer' }], 'end_turn'),
      ]

      const adapter = mockAdapter('   ')
      await expect(cm.compactWithLLM(messages, adapter, 'test-model')).rejects.toBeInstanceOf(
        CompactionFailedError,
      )
    })

    // 坑 2：同一个 catch 吞掉 abort——中止途中还多改一次 messages
    it('propagates abort errors instead of swallowing them into a text fallback', async () => {
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

      const adapter = mockAbortingAdapter()
      const error = await cm
        .compactWithLLM(messages, adapter, 'test-model')
        .then(() => undefined, (e: unknown) => e)

      expect(error).toBeInstanceOf(Error)
      expect((error as Error).name).toBe('AbortError')
      // 不许被包装成压缩失败——调用方要能区分"中止"与"压缩挂了"
      expect(error).not.toBeInstanceOf(CompactionFailedError)
    })

    it('forwards the abort signal to the summarization call', async () => {
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

      const controller = new AbortController()
      const { adapter, captured } = capturingAdapter('摘要')
      await cm.compactWithLLM(messages, adapter, 'test-model', controller.signal)

      expect(captured.signal).toBe(controller.signal)
    })

    // 坑 3：摘要输入自己会超窗——待折叠段全量（含全量 tool_result）拼一条消息喂给摘要模型
    it('truncates each tool_result in the summary prompt', async () => {
      const cm = new ContextManager({
        maxContextTokens: 100000,
        keepRecentMessages: 2,
      })

      const huge = 'y'.repeat(50000)
      const messages: EngineMessage[] = [
        createUserMessage('任务'),
        createAssistantMessage(
          [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'cat big.log' } }],
          'tool_use',
        ),
        createToolResultMessage('tu_1', huge, false),
        createUserMessage('继续'),
        createAssistantMessage([{ type: 'text', text: '好的' }], 'end_turn'),
      ]

      const { adapter, captured } = capturingAdapter('摘要')
      await cm.compactWithLLM(messages, adapter, 'test-model')

      const prompt = (captured.messages[0] as { content: string }).content
      expect(prompt).toContain('已截断')
      expect(prompt.length).toBeLessThan(10000)
    })

    it('caps the total summary prompt by a budget derived from the context window', async () => {
      // maxContextTokens=1000 → 预算 1000 * 4 * 0.5 = 2000 字符。
      // 30 条 2000 字符的 tool_result（逐条截断后仍有 6 万字符）必须被整体裁到预算内。
      const cm = new ContextManager({
        maxContextTokens: 1000,
        keepRecentMessages: 2,
      })

      const messages: EngineMessage[] = [createUserMessage('任务')]
      for (let i = 0; i < 30; i++) {
        messages.push(
          createAssistantMessage(
            [{ type: 'tool_use', id: `tu_${i}`, name: 'Bash', input: { command: `run ${i}` } }],
            'tool_use',
          ),
        )
        messages.push(createToolResultMessage(`tu_${i}`, `result ${i} ${'z'.repeat(2000)}`, false))
      }
      messages.push(createUserMessage('继续'))
      messages.push(createAssistantMessage([{ type: 'text', text: '好的' }], 'end_turn'))

      const { adapter, captured } = capturingAdapter('摘要')
      await cm.compactWithLLM(messages, adapter, 'test-model')

      const prompt = (captured.messages[0] as { content: string }).content
      expect(prompt.length).toBeLessThan(3000)
      expect(prompt).toContain('已省略更早')
      // 保留的是最近的那一段（最旧的被丢）
      expect(prompt).toContain('result 29')
      expect(prompt).not.toContain('result 0 ')
    })

    // 坑 4：findSafeSplitIndex 的回退无界——外部来源（resume checkpoint / session 树回灌）
    // 出现连续 tool_result 时会一路退到 <=1，压缩静默变 no-op
    it('still compacts when the folded range is a run of consecutive tool_results', async () => {
      const cm = new ContextManager({
        maxContextTokens: 10000,
        keepRecentMessages: 3,
      })

      // index 1..8 全是 tool_result（外部回灌的病态形态），index 9 是普通 user message
      const messages: EngineMessage[] = [createUserMessage('任务来源')]
      for (let i = 1; i <= 8; i++) {
        messages.push(createToolResultMessage(`tu_${i}`, `result ${i}`, false))
      }
      messages.push(createUserMessage('最新一条'))

      const { adapter } = capturingAdapter('摘要')
      const compacted = await cm.compactWithLLM(messages, adapter, 'test-model')

      // 不许静默 no-op：首条钉住 + 摘要 + recent 段
      expect(compacted.length).toBeLessThan(messages.length)
      expect(compacted[0]).toBe(messages[0])
      // recent 段第一条不能是孤儿 tool_result（其 tool_use 已被折叠进摘要）
      const firstRecent = compacted[2]
      expect('toolResults' in firstRecent).toBe(false)
      expect(firstRecent).toBe(messages[9])
    })

    it('rejects when no safe split point exists at all', async () => {
      const cm = new ContextManager({
        maxContextTokens: 10000,
        keepRecentMessages: 3,
      })

      const messages: EngineMessage[] = [createUserMessage('任务来源')]
      for (let i = 1; i <= 9; i++) {
        messages.push(createToolResultMessage(`tu_${i}`, `result ${i}`, false))
      }

      const { adapter } = capturingAdapter('摘要')
      await expect(cm.compactWithLLM(messages, adapter, 'test-model')).rejects.toBeInstanceOf(
        CompactionFailedError,
      )
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

      const { adapter, captured } = capturingAdapter('Summary with tool usage.')
      const compacted = await cm.compactWithLLM(messages, adapter, 'test-model')

      // The summary prompt sent to LLM should mention tool calls
      expect(captured.messages).toHaveLength(1)
      const promptContent = (captured.messages[0] as { content: string | ContentBlock[] }).content
      expect(typeof promptContent).toBe('string')
      expect(promptContent as string).toContain('search_docs')

      expect(compacted).toHaveLength(4) // 1 first + 1 summary + 2 recent
      expect(compacted[0]).toBe(messages[0]) // 首条 user message 钉住
    })

    it('should use the default task-continuity compaction prompts', async () => {
      const cm = new ContextManager({
        maxContextTokens: 10000,
        keepRecentMessages: 2,
      })

      const messages: EngineMessage[] = [
        createUserMessage('用户后来纠正：旧指标作废，必须逐笔核对。'),
        createAssistantMessage([{ type: 'text', text: '收到，我会重新核对。' }], 'end_turn'),
        createUserMessage('继续'),
        createAssistantMessage([
          { type: 'tool_use', id: 'tu_1', name: 'run_audit', input: { strict: true } },
        ], 'tool_use'),
        createToolResultMessage('tu_1', '审计完成', false),
        createUserMessage('继续下一步'),
        createAssistantMessage([{ type: 'text', text: '继续处理。' }], 'end_turn'),
      ]

      const { adapter, captured } = capturingAdapter('摘要')
      await cm.compactWithLLM(messages, adapter, 'test-model')

      expect(captured.systemPrompt).toContain('[任务连续性状态]')
      expect(captured.systemPrompt).toContain('已作废或被替换的信息')
      expect(captured.systemPrompt).toContain('不要把旧结论和新纠偏混在一起')
      expect(captured.systemPrompt).toContain('不要把它当作系统 goal 状态')

      const promptContent = (captured.messages[0] as { content: string | ContentBlock[] }).content
      expect(typeof promptContent).toBe('string')
      expect(promptContent as string).toContain('以下是需要压缩的历史上下文')
      expect(promptContent as string).toContain('使用过的工具: run_audit')
      expect(promptContent as string).not.toContain('Summarize the following conversation')
    })

    it('should pin first user message (task_origin) across LLM compaction', async () => {
      // 回归：压缩丢首条 user message 的 channel_id 导致 worker 回复发错 channel。
      // 不变量：首条 user message 不进摘要 LLM 输入、原对象引用保留。
      const cm = new ContextManager({
        maxContextTokens: 10000,
        keepRecentMessages: 2,
      })

      const taskMessage = createUserMessage(
        '## 任务来源\n- Channel ID: wechat-棉花糖\n- Session ID: c34a33a8\n\n## 用户请求\n搭一下 deepseek 引擎'
      )
      const messages: EngineMessage[] = [
        taskMessage,
        createAssistantMessage([{ type: 'text', text: 'OK 开始干' }], 'end_turn'),
        createUserMessage('shell 输出 1'),
        createAssistantMessage([{ type: 'text', text: '继续' }], 'end_turn'),
        createUserMessage('shell 输出 2'),
        createAssistantMessage([{ type: 'text', text: '快好了' }], 'end_turn'),
      ]

      const { adapter, captured } = capturingAdapter('shell 跑了两轮。')
      const compacted = await cm.compactWithLLM(messages, adapter, 'test-model')

      expect(compacted[0]).toBe(taskMessage)
      const summaryPrompt = (captured.messages[0] as { content: string }).content
      expect(summaryPrompt).not.toContain('wechat-棉花糖')
      expect(summaryPrompt).not.toContain('任务来源')
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

      const { adapter, captured } = capturingAdapter('Brief summary.')
      await cm.compactWithLLM(messages, adapter, 'test-model')

      expect(captured.systemPrompt).toBe(customPrompt)
    })
  })
})
