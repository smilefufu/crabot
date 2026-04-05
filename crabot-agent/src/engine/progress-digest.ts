import type { EngineTurnEvent, EngineMessage } from './types'
import { createUserMessage } from './types'
import type { LLMAdapter } from './llm-adapter'
import { callNonStreaming } from './llm-adapter'

// --- Tool Classification ---

/** Tools that get detailed summaries (name + brief description of what they did) */
const DETAILED_TOOLS = new Set([
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill',
])

/** Regex matching internal/trivial Bash commands that should be ignored */
const INTERNAL_BASH_RE = /^\s*(ls|cat|head|tail|echo|pwd|which|type|env|set|export|cd|mkdir|rm|cp|mv|chmod|chown|stat|file|wc|sort|uniq|diff|patch|touch|true|false|exit|sleep|date|uname|whoami|id|groups|hostname|printenv|test|:\s*$)/

/** Tool name prefixes/patterns that should only be counted (not detailed) */
const SILENT_TOOL_CATEGORIES: ReadonlyArray<RegExp> = [
  /^computer_use/,
  /^computer-use/,
  /^send_message/,
  /^send-message/,
  /^memory_/,
  /^memory-/,
]

// --- Interfaces ---

export interface ProgressDigestConfig {
  /** Flush interval in milliseconds (default: 3 minutes) */
  readonly flushIntervalMs: number
  /** Model ID to use for digest generation (lightweight model) */
  readonly digestModel: string
  /** Max tokens for digest response */
  readonly maxTokens: number
  /** If true, use extract mode (no LLM call, just extract first sentences) */
  readonly extractMode: boolean
}

export interface ProgressDigestDeps {
  readonly adapter: LLMAdapter
  /** Chat history at start of task (for context) */
  readonly chatHistory: ReadonlyArray<EngineMessage>
  /** Callback to emit digest message to the caller */
  readonly onDigest: (message: string) => void
}

// --- Buffer ---

interface BufferedTurn {
  readonly turnNumber: number
  readonly assistantText: string
  readonly toolCalls: ReadonlyArray<{
    readonly name: string
    readonly input: Record<string, unknown>
    readonly output: string
    readonly isError: boolean
  }>
}

export type DigestBuffer = ReadonlyArray<BufferedTurn>

// --- System Prompt ---

export const DIGEST_SYSTEM_PROMPT = `You are a concise progress reporter for an AI agent task.
Given a sequence of agent turns with tool calls and results, produce a brief 2-4 sentence summary of what was accomplished.
Focus on concrete actions and findings, not process. Use past tense. Be specific about file names, commands run, and results found.
Do NOT include next steps or recommendations. Do NOT say "the agent". Use "I" as subject.`

// --- ProgressDigest Class ---

export class ProgressDigest {
  private readonly config: ProgressDigestConfig
  private readonly deps: ProgressDigestDeps
  private buffer: DigestBuffer = []
  private timer: NodeJS.Timeout | null = null
  private flushing = false
  private disposed = false

  constructor(config: ProgressDigestConfig, deps: ProgressDigestDeps) {
    this.config = config
    this.deps = deps
    this.scheduleFlush()
  }

  /** Synchronously ingest a turn event into the buffer. Never blocks. */
  ingest(event: EngineTurnEvent): void {
    if (this.disposed) return

    const buffered: BufferedTurn = {
      turnNumber: event.turnNumber,
      assistantText: event.assistantText,
      toolCalls: event.toolCalls.map((tc) => ({
        name: tc.name,
        input: tc.input,
        output: tc.output,
        isError: tc.isError,
      })),
    }

    this.buffer = [...this.buffer, buffered]

    // Immediate flush on ask_human or errors
    const hasAskHuman = event.toolCalls.some((tc) => tc.name === 'ask_human')
    const hasErrors = event.toolCalls.some((tc) => tc.isError)

    if (hasAskHuman || hasErrors) {
      void this.doFlush()
    }
  }

  /** Force an immediate flush (fire-and-forget). */
  flushNow(): void {
    void this.doFlush()
  }

  /** Cancel the timer and discard the buffer. Call when engine ends. */
  dispose(): void {
    this.disposed = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.buffer = []
  }

  private scheduleFlush(): void {
    if (this.disposed) return
    this.timer = setTimeout(() => {
      void this.doFlush()
    }, this.config.flushIntervalMs)
  }

  private async doFlush(): Promise<void> {
    if (this.flushing || this.disposed) return
    if (this.buffer.length === 0) {
      if (!this.disposed) this.scheduleFlush()
      return
    }

    this.flushing = true
    const snapshot = this.buffer
    this.buffer = []

    // Cancel current timer; reschedule after flush
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }

    try {
      let digest: string

      if (this.config.extractMode) {
        digest = this.generateExtractDigest(snapshot)
      } else {
        digest = await this.generateLlmDigest(snapshot)
      }

      if (digest.trim().length > 0) {
        this.deps.onDigest(digest)
      }
    } catch (error) {
      // Fallback to extract mode on LLM failure
      try {
        const fallback = this.generateExtractDigest(snapshot)
        if (fallback.trim().length > 0) {
          this.deps.onDigest(fallback)
        }
      } catch {
        // Silently discard if even fallback fails
      }
    } finally {
      this.flushing = false
      if (!this.disposed) {
        this.scheduleFlush()
      }
    }
  }

  private async generateLlmDigest(turns: DigestBuffer): Promise<string> {
    const executionRecord = this.formatTurnsAsRecord(turns)
    const historyContext = this.deps.chatHistory
      .slice(-4) // Last 4 messages for context
      .map((m) => {
        if (m.role === 'user' && 'content' in m) {
          const content = typeof m.content === 'string' ? m.content : '[media]'
          return `User: ${content}`
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')

    const userContent = [
      historyContext ? `Recent conversation:\n${historyContext}\n` : '',
      `Execution record:\n${executionRecord}`,
      '\nPlease summarize what was accomplished in these turns.',
    ]
      .filter(Boolean)
      .join('\n')

    const response = await callNonStreaming(this.deps.adapter, {
      messages: [createUserMessage(userContent)],
      systemPrompt: DIGEST_SYSTEM_PROMPT,
      tools: [],
      model: this.config.digestModel,
      maxTokens: this.config.maxTokens,
    })

    const textBlock = response.content.find((b) => b.type === 'text')
    return textBlock && textBlock.type === 'text' ? textBlock.text.trim() : ''
  }

  private generateExtractDigest(turns: DigestBuffer): string {
    const sentences: string[] = []

    for (const turn of turns) {
      if (turn.assistantText.trim().length > 0) {
        const firstSentence = extractFirstSentence(turn.assistantText)
        if (firstSentence) {
          sentences.push(firstSentence)
        }
      }
    }

    return this.dedupeDetails(sentences).join(' ')
  }

  private formatTurnsAsRecord(turns: DigestBuffer): string {
    const sections: string[] = []

    for (const turn of turns) {
      const parts: string[] = [`Turn ${turn.turnNumber}:`]

      if (turn.assistantText.trim().length > 0) {
        parts.push(`  Thought: ${turn.assistantText.slice(0, 200)}`)
      }

      const toolSection = this.formatToolSection(turn.toolCalls)
      if (toolSection) {
        parts.push(toolSection)
      }

      sections.push(parts.join('\n'))
    }

    return sections.join('\n\n')
  }

  private formatToolSection(
    toolCalls: ReadonlyArray<{ name: string; input: Record<string, unknown>; output: string; isError: boolean }>,
  ): string {
    if (toolCalls.length === 0) return ''

    const detailed: string[] = []
    const silentCounts = new Map<string, number>()

    for (const tc of toolCalls) {
      const classification = this.classifyTool(tc.name, tc.input)

      if (classification === 'ignore') continue

      if (classification === 'silent') {
        const count = silentCounts.get(tc.name) ?? 0
        silentCounts.set(tc.name, count + 1)
        continue
      }

      // detailed
      const summary = this.summarizeDetailedTool(tc)
      if (summary) {
        detailed.push(`    - ${summary}`)
      }
    }

    const lines: string[] = []

    if (detailed.length > 0) {
      lines.push('  Tools:')
      lines.push(...detailed)
    }

    if (silentCounts.size > 0) {
      const counts = Array.from(silentCounts.entries())
        .map(([name, count]) => `${name}×${count}`)
        .join(', ')
      lines.push(`  Also: ${counts}`)
    }

    return lines.join('\n')
  }

  private dedupeDetails(items: string[]): string[] {
    const seen = new Set<string>()
    return items.filter((item) => {
      const normalized = item.toLowerCase().trim()
      if (seen.has(normalized)) return false
      seen.add(normalized)
      return true
    })
  }

  private classifyTool(
    name: string,
    input: Record<string, unknown>,
  ): 'detailed' | 'silent' | 'ignore' {
    // Check silent categories first
    if (SILENT_TOOL_CATEGORIES.some((re) => re.test(name))) {
      return 'silent'
    }

    if (DETAILED_TOOLS.has(name)) {
      // Special case: ignore trivial Bash commands
      if (name === 'Bash') {
        const cmd = String(input['command'] ?? input['cmd'] ?? '')
        if (INTERNAL_BASH_RE.test(cmd)) {
          return 'ignore'
        }
      }
      return 'detailed'
    }

    // Unknown tools: treat as silent
    return 'silent'
  }

  private summarizeDetailedTool(tc: {
    name: string
    input: Record<string, unknown>
    output: string
    isError: boolean
  }): string {
    const prefix = tc.isError ? '[ERROR] ' : ''

    switch (tc.name) {
      case 'Bash': {
        const cmd = String(tc.input['command'] ?? tc.input['cmd'] ?? '').slice(0, 80)
        const outputSnippet = tc.output.slice(0, 100).replace(/\n/g, ' ')
        return `${prefix}Bash: \`${cmd}\` → ${outputSnippet}`
      }
      case 'Read': {
        const path = String(tc.input['file_path'] ?? tc.input['path'] ?? '')
        return `${prefix}Read: ${path}`
      }
      case 'Write': {
        const path = String(tc.input['file_path'] ?? tc.input['path'] ?? '')
        return `${prefix}Write: ${path}`
      }
      case 'Edit': {
        const path = String(tc.input['file_path'] ?? tc.input['path'] ?? '')
        return `${prefix}Edit: ${path}`
      }
      case 'Glob': {
        const pattern = String(tc.input['pattern'] ?? '')
        return `${prefix}Glob: ${pattern}`
      }
      case 'Grep': {
        const pattern = String(tc.input['pattern'] ?? '')
        return `${prefix}Grep: ${pattern}`
      }
      case 'Skill': {
        const skill = String(tc.input['skill'] ?? tc.input['name'] ?? '')
        return `${prefix}Skill: ${skill}`
      }
      default: {
        const summary = JSON.stringify(tc.input).slice(0, 60)
        return `${prefix}${tc.name}: ${summary}`
      }
    }
  }
}

// --- Helpers ---

function extractFirstSentence(text: string): string {
  const trimmed = text.trim()
  const match = trimmed.match(/^[^.!?]+[.!?]/)
  return match ? match[0].trim() : trimmed.split('\n')[0].trim()
}
