import {
  type EngineMessage,
  type EngineUserMessage,
  type EngineAssistantMessage,
  type EngineToolResultMessage,
  type ContentBlock,
  createUserMessage,
} from './types'

export interface ContextManagerOptions {
  readonly maxContextTokens: number
  readonly compactThreshold?: number    // 0-1, default 0.8
  readonly keepRecentMessages?: number  // default 6
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

export class ContextManager {
  private readonly maxContextTokens: number
  private readonly compactThreshold: number
  private readonly keepRecentMessages: number
  private cumulativeUsage: CumulativeUsage

  constructor(options: ContextManagerOptions) {
    this.maxContextTokens = options.maxContextTokens
    this.compactThreshold = options.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD
    this.keepRecentMessages = options.keepRecentMessages ?? DEFAULT_KEEP_RECENT
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

    const splitIndex = messages.length - this.keepRecentMessages
    const oldMessages = messages.slice(0, splitIndex)
    const recentMessages = messages.slice(splitIndex)

    const summaryText = this.buildSummary(oldMessages)
    const summaryMessage = createUserMessage(summaryText)

    return [summaryMessage, ...recentMessages]
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
