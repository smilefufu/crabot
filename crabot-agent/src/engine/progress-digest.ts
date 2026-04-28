import { basename } from 'path'
import type { LLMAdapter } from './llm-adapter'
import { callNonStreaming } from './llm-adapter'
import type { EngineTurnEvent } from './types'
import { createUserMessage } from './types'

// --- Tool Classification ---

const DETAILED_TOOLS = new Set([
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill',
])

const INTERNAL_BASH_RE = /^(ls|file|cat|head|tail|wc|echo|sleep|pwd|cd|which|type|test|stat|du|df|find|xargs|sort|uniq|tr|cut|awk|sed)\b/

const SILENT_TOOL_CATEGORIES: ReadonlyArray<{ readonly prefix: string; readonly label: string }> = [
  { prefix: 'mcp__computer-use__', label: '浏览器操作' },
  { prefix: 'mcp__crab-messaging__', label: '消息操作' },
  { prefix: 'mcp__crab-memory__', label: '记忆操作' },
]

// --- Config & Deps ---

export interface ProgressDigestConfig {
  readonly intervalMs: number
  readonly mode: 'llm' | 'extract'
  readonly isMasterPrivate: boolean
}

export interface ProgressDigestDeps {
  readonly sendToUser: (text: string) => Promise<void>
  readonly getChatHistory: (limit: number) => Promise<string[]>
  readonly digestAdapter?: LLMAdapter
  readonly digestModelId?: string
}

// --- Buffer Types ---

interface ToolSummary {
  readonly name: string
  readonly detail: string
}

interface DigestBuffer {
  readonly texts: readonly string[]
  readonly detailedTools: readonly ToolSummary[]
  readonly silentCounts: Readonly<Record<string, number>>
  readonly turnCount: number
}

// --- Class ---

const DIGEST_SYSTEM_PROMPT = `你是一个任务执行助手。根据以下执行记录，用1-2句话向用户汇报：你做了什么，现在正在做什么。
严格基于提供的执行记录事实作答，不要推测、编造或虚构任何未发生的操作或结果。
如果执行记录不足以判断某件事的结果，就说"正在进行"而不是编造一个结果。
保持语言简洁自然，像同事汇报工作进度一样。不要使用 markdown 格式。`

export class ProgressDigest {
  private readonly config: ProgressDigestConfig
  private readonly deps: ProgressDigestDeps
  private buffer: DigestBuffer
  private timer: ReturnType<typeof setInterval> | null = null
  private digestCount = 0
  private disposed = false
  private flushing = false

  constructor(config: ProgressDigestConfig, deps: ProgressDigestDeps) {
    this.config = config
    this.deps = deps
    this.buffer = createEmptyBuffer()
    this.startTimer()
  }

  ingest(event: EngineTurnEvent): void {
    if (this.disposed) return

    const trimmed = event.assistantText.trim()
    const newTexts = trimmed.length > 0
      ? [...this.buffer.texts, trimmed]
      : this.buffer.texts

    let detailedTools = this.buffer.detailedTools
    let silentCounts = this.buffer.silentCounts
    for (const tc of event.toolCalls) {
      const classification = classifyTool(tc.name, tc.input)
      if (classification.type === 'detailed') {
        const detail = summarizeDetailedTool(tc.name, tc.input, this.config.isMasterPrivate)
        if (detail !== null) {
          detailedTools = [...detailedTools, { name: tc.name, detail }]
        }
      } else if (classification.type === 'silent') {
        silentCounts = { ...silentCounts, [classification.category]: (silentCounts[classification.category] ?? 0) + 1 }
      }
    }
    this.buffer = { texts: newTexts, detailedTools, silentCounts, turnCount: this.buffer.turnCount + 1 }

    // Immediate flush only on ask_human (interactive — user must see the question now).
    // Tool execution errors are part of the LLM's normal self-correction loop and should
    // respect the configured digest interval; flushing on every isError bypasses the
    // user-configured cadence (e.g. 1800s) and produces minute-by-minute digests.
    if (event.toolCalls.some(tc => tc.name === 'mcp__crabot-worker__ask_human')) {
      this.flushNow()
    }
  }

  flushNow(): void {
    if (this.disposed) return
    this.doFlush().catch(() => {})
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.buffer = createEmptyBuffer()
  }

  private startTimer(): void {
    this.timer = setInterval(() => {
      this.doFlush().catch(() => {})
    }, this.config.intervalMs)
  }

  private async doFlush(): Promise<void> {
    if (this.flushing || isBufferEmpty(this.buffer)) return
    this.flushing = true

    const snapshot = this.buffer
    this.buffer = createEmptyBuffer()

    try {
      const message = this.config.mode === 'llm'
        ? await this.generateLlmDigest(snapshot)
        : generateExtractDigest(snapshot)

      if (message.length > 0) {
        await this.deps.sendToUser(message)
        this.digestCount++
      }
    } catch {
      try {
        const fallback = generateExtractDigest(snapshot)
        if (fallback.length > 0) {
          await this.deps.sendToUser(fallback)
          this.digestCount++
        }
      } catch {
        // swallow
      }
    } finally {
      this.flushing = false
    }
  }

  private async generateLlmDigest(snapshot: DigestBuffer): Promise<string> {
    const { digestAdapter, digestModelId } = this.deps
    if (!digestAdapter || !digestModelId) {
      return generateExtractDigest(snapshot)
    }

    let chatHistory: string[] = []
    try {
      chatHistory = await this.deps.getChatHistory(this.digestCount + 10)
    } catch {
      // continue without history
    }

    const toolSection = formatToolSection(snapshot)

    const userMessage = [
      chatHistory.length > 0 ? `## 近期对话记录\n${chatHistory.join('\n')}` : '',
      '## 本轮执行记录',
      snapshot.texts.length > 0 ? `### 思考文本\n${snapshot.texts.join('\n---\n')}` : '',
      toolSection.length > 0 ? `### 操作记录\n${toolSection}` : '',
    ].filter(s => s.length > 0).join('\n\n')

    const response = await callNonStreaming(digestAdapter, {
      messages: [createUserMessage(userMessage)],
      systemPrompt: DIGEST_SYSTEM_PROMPT,
      tools: [],
      model: digestModelId,
    })

    const llmText = response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join('')

    if (toolSection.length > 0) {
      return `${llmText}\n\n操作：\n${toolSection}`
    }
    return llmText
  }
}

// --- Pure Functions ---

function createEmptyBuffer(): DigestBuffer {
  return { texts: [], detailedTools: [], silentCounts: {}, turnCount: 0 }
}

function isBufferEmpty(buffer: DigestBuffer): boolean {
  return buffer.texts.length === 0
    && buffer.detailedTools.length === 0
    && Object.keys(buffer.silentCounts).length === 0
}

type ToolClassification =
  | { type: 'detailed' }
  | { type: 'silent'; category: string }
  | { type: 'ignore' }

function classifyTool(toolName: string, input: Record<string, unknown>): ToolClassification {
  for (const cat of SILENT_TOOL_CATEGORIES) {
    if (toolName.startsWith(cat.prefix)) {
      return { type: 'silent', category: cat.label }
    }
  }

  if (DETAILED_TOOLS.has(toolName)) {
    if (toolName === 'Bash') {
      const cmd = ((input.command as string) ?? '').trim()
      if (INTERNAL_BASH_RE.test(cmd)) return { type: 'ignore' }
    }
    return { type: 'detailed' }
  }

  return { type: 'silent', category: toolName }
}

function summarizeDetailedTool(
  toolName: string,
  input: Record<string, unknown>,
  isMasterPrivate: boolean,
): string | null {
  switch (toolName) {
    case 'Bash': {
      const cmd = ((input.command as string) ?? '').trim()
      if (INTERNAL_BASH_RE.test(cmd)) return null
      if (isMasterPrivate) return `> ${cmd.slice(0, 120)}`
      const sanitized = cmd.replace(/(?:\/[\w.-]+)+/g, (match) => basename(match))
      return `> ${sanitized.slice(0, 120)}`
    }
    case 'Read':
      return `读取 ${isMasterPrivate ? (input.file_path ?? '文件') : basenameOf(input.file_path)}`
    case 'Write':
      return `写入 ${isMasterPrivate ? (input.file_path ?? '文件') : basenameOf(input.file_path)}`
    case 'Edit':
      return `编辑 ${isMasterPrivate ? (input.file_path ?? '文件') : basenameOf(input.file_path)}`
    case 'Glob':
      return `搜索文件 ${input.pattern ?? ''}`
    case 'Grep':
      return `搜索 "${((input.pattern as string) ?? '').slice(0, 30)}"`
    case 'Skill':
      return '使用技能'
    default:
      return toolName
  }
}

function basenameOf(filePath: unknown): string {
  return typeof filePath === 'string' ? (basename(filePath) || '文件') : '文件'
}

function generateExtractDigest(snapshot: DigestBuffer): string {
  const parts: string[] = []

  if (snapshot.texts.length > 0) {
    const firstSentences = snapshot.texts
      .map(t => {
        const match = t.match(/^[^。！？\n.!?]+[。！？.!?]?/)
        return match ? match[0] : t.slice(0, 80)
      })
      .join('；')
    parts.push(firstSentences.slice(0, 150))
  }

  const toolSection = formatToolSection(snapshot)
  if (toolSection.length > 0) {
    parts.push(`\n操作：\n${toolSection}`)
  }

  return parts.join('\n')
}

function formatToolSection(snapshot: DigestBuffer): string {
  const lines: string[] = []

  if (snapshot.detailedTools.length > 0) {
    lines.push(...dedupeDetails(snapshot.detailedTools))
  }

  for (const [category, count] of Object.entries(snapshot.silentCounts)) {
    lines.push(`- ${category} ×${count}`)
  }

  return lines.join('\n')
}

function dedupeDetails(tools: readonly ToolSummary[]): string[] {
  if (tools.length === 0) return []
  const result: string[] = []
  let current = tools[0].detail
  let count = 1
  for (let i = 1; i < tools.length; i++) {
    if (tools[i].detail === current) {
      count++
    } else {
      result.push(count > 1 ? `- ${current} ×${count}` : `- ${current}`)
      current = tools[i].detail
      count = 1
    }
  }
  result.push(count > 1 ? `- ${current} ×${count}` : `- ${current}`)
  return result
}
