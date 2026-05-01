import {
  type EngineMessage,
  type EngineUserMessage,
  type EngineAssistantMessage,
  type EngineToolResultMessage,
  type ContentBlock,
  createUserMessage,
} from './types'
import { callNonStreaming, type LLMAdapter } from './llm-adapter'

export interface ContextManagerOptions {
  readonly maxContextTokens: number
  readonly compactThreshold?: number    // 0-1, default 0.8
  readonly keepRecentMessages?: number  // default 6
  readonly compactSystemPrompt?: string
}

interface CumulativeUsage {
  readonly inputTokens: number
  readonly outputTokens: number
}

const DEFAULT_COMPACT_THRESHOLD = 0.8
const DEFAULT_KEEP_RECENT = 6
const CHARS_PER_TOKEN = 4
const MESSAGE_OVERHEAD_TOKENS = 4
const IMAGE_TOKENS = 1000

const DEFAULT_COMPACT_SYSTEM_PROMPT = `You are summarizing a conversation for context preservation. Create a concise summary that captures:
- Key decisions and outcomes
- Important context that may be needed later
- Tool calls made and their results (briefly)
- Any unresolved questions or pending work

Be concise. Output only the summary, no preamble.`

export class ContextManager {
  private readonly maxContextTokens: number
  private readonly compactThreshold: number
  private readonly keepRecentMessages: number
  private readonly compactSystemPrompt: string
  private cumulativeUsage: CumulativeUsage

  constructor(options: ContextManagerOptions) {
    this.maxContextTokens = options.maxContextTokens
    this.compactThreshold = options.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD
    this.keepRecentMessages = options.keepRecentMessages ?? DEFAULT_KEEP_RECENT
    this.compactSystemPrompt = options.compactSystemPrompt ?? DEFAULT_COMPACT_SYSTEM_PROMPT
    this.cumulativeUsage = { inputTokens: 0, outputTokens: 0 }
  }

  estimateMessageTokens(msg: EngineMessage): number {
    let charCount = 0

    if (msg.role === 'assistant') {
      charCount += this.estimateContentBlocks(msg.content)
    } else if ('toolResults' in msg) {
      const toolMsg = msg as EngineToolResultMessage
      for (const result of toolMsg.toolResults) {
        charCount += result.content.length
      }
    } else {
      const userMsg = msg as EngineUserMessage
      if (typeof userMsg.content === 'string') {
        charCount += userMsg.content.length
      } else {
        charCount += this.estimateContentBlocks(userMsg.content)
      }
    }

    return Math.ceil(charCount / CHARS_PER_TOKEN) + MESSAGE_OVERHEAD_TOKENS
  }

  estimateTotalTokens(messages: ReadonlyArray<EngineMessage>): number {
    return messages.reduce(
      (sum, msg) => sum + this.estimateMessageTokens(msg),
      0
    )
  }

  shouldCompact(messages: ReadonlyArray<EngineMessage>): boolean {
    const estimated = this.estimateTotalTokens(messages)
    return estimated >= this.maxContextTokens * this.compactThreshold
  }

  compactMessages(messages: ReadonlyArray<EngineMessage>): ReadonlyArray<EngineMessage> {
    if (messages.length <= this.keepRecentMessages) {
      return [...messages]
    }

    const splitIndex = this.findSafeSplitIndex(messages)
    if (splitIndex <= 0) {
      return [...messages]
    }
    const oldMessages = messages.slice(0, splitIndex)
    const recentMessages = messages.slice(splitIndex)

    const summaryText = this.buildSummary(oldMessages)
    const summaryMessage = createUserMessage(summaryText)

    return [summaryMessage, ...recentMessages]
  }

  async compactWithLLM(
    messages: ReadonlyArray<EngineMessage>,
    adapter: LLMAdapter,
    model: string,
  ): Promise<ReadonlyArray<EngineMessage>> {
    if (messages.length <= this.keepRecentMessages) {
      return [...messages]
    }

    const splitIndex = this.findSafeSplitIndex(messages)
    if (splitIndex <= 0) {
      return [...messages]
    }
    const oldMessages = messages.slice(0, splitIndex)
    const recentMessages = messages.slice(splitIndex)

    try {
      const summaryPrompt = this.buildSummaryPrompt(oldMessages)
      const promptMessage = createUserMessage(summaryPrompt)

      const response = await callNonStreaming(adapter, {
        messages: [promptMessage],
        systemPrompt: this.compactSystemPrompt,
        tools: [],
        model,
      })

      const summaryText = response.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('')

      const summaryMessage = createUserMessage(
        `[Earlier conversation summary]\n${summaryText}`
      )

      return [summaryMessage, ...recentMessages]
    } catch {
      // Fall back to text-based compaction
      return this.compactMessages(messages)
    }
  }

  updateFromUsage(usage: { readonly inputTokens: number; readonly outputTokens: number }): void {
    this.cumulativeUsage = {
      inputTokens: this.cumulativeUsage.inputTokens + usage.inputTokens,
      outputTokens: this.cumulativeUsage.outputTokens + usage.outputTokens,
    }
  }

  getCumulativeUsage(): CumulativeUsage {
    return this.cumulativeUsage
  }

  /**
   * 找到一个安全的 compaction 切割点：保证 recent 段第一条消息不是孤儿 tool_result
   * （其匹配的 tool_use 在被压缩段，会触发 LLM API 400）。
   *
   * 默认切点 = messages.length - keepRecentMessages。如果该位置是 tool_result，
   * 向前回退把对应的 assistant_with_tool_use 一起拉进 recent。assistant 与 tool_result
   * 严格相邻，所以最多回退一步即可。
   */
  private findSafeSplitIndex(messages: ReadonlyArray<EngineMessage>): number {
    let splitIndex = messages.length - this.keepRecentMessages
    while (splitIndex > 0 && this.isToolResultMessage(messages[splitIndex])) {
      splitIndex--
    }
    return splitIndex
  }

  private isToolResultMessage(msg: EngineMessage): boolean {
    return 'toolResults' in msg
  }

  private estimateContentBlocks(blocks: ReadonlyArray<ContentBlock>): number {
    let chars = 0
    for (const block of blocks) {
      switch (block.type) {
        case 'text':
          chars += block.text.length
          break
        case 'image':
          // Images are estimated as a fixed token count; convert back to chars
          // so the final /CHARS_PER_TOKEN math yields ~IMAGE_TOKENS
          chars += IMAGE_TOKENS * CHARS_PER_TOKEN
          break
        case 'tool_use':
          chars += block.name.length + JSON.stringify(block.input).length
          break
        case 'tool_result':
          chars += block.content.length
          break
      }
    }
    return chars
  }

  private buildSummary(messages: ReadonlyArray<EngineMessage>): string {
    const parts: string[] = []
    for (const msg of messages) {
      const role = msg.role === 'assistant' ? 'Assistant' : 'User'
      const text = this.extractText(msg)
      if (text) {
        parts.push(`${role}: ${text}`)
      }
    }

    const conversationSummary = parts.join('\n')
    return `[Summary of earlier conversation]\n${conversationSummary}`
  }

  private buildSummaryPrompt(messages: ReadonlyArray<EngineMessage>): string {
    const parts: string[] = []
    const toolNames = new Set<string>()

    for (const msg of messages) {
      if (msg.role === 'assistant') {
        const assistantMsg = msg as EngineAssistantMessage
        for (const block of assistantMsg.content) {
          if (block.type === 'tool_use') {
            toolNames.add(block.name)
          }
        }
      }

      const role = msg.role === 'assistant' ? 'Assistant' : 'User'
      const text = this.extractText(msg)
      if (text) {
        parts.push(`${role}: ${text}`)
      }
    }

    const lines: string[] = [
      'Summarize the following conversation:',
      '',
      ...parts,
    ]

    if (toolNames.size > 0) {
      lines.push('')
      lines.push(`Tools used: ${[...toolNames].join(', ')}`)
    }

    return lines.join('\n')
  }

  private extractText(msg: EngineMessage): string {
    if (msg.role === 'assistant') {
      const assistantMsg = msg as EngineAssistantMessage
      return assistantMsg.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join(' ')
    }

    if ('toolResults' in msg) {
      const toolMsg = msg as EngineToolResultMessage
      return toolMsg.toolResults.map((r) => r.content).join(' ')
    }

    const userMsg = msg as EngineUserMessage
    if (typeof userMsg.content === 'string') {
      return userMsg.content
    }

    return userMsg.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join(' ')
  }
}
