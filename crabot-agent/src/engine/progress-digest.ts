import type { LLMAdapter } from './llm-adapter'
import type { EngineTurnEvent } from './types'

// --- Tool Classification ---

/** 高价值工具：列出具体操作 */
const DETAILED_TOOLS = new Set([
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill',
])

/** Bash 内部命令，完全忽略 */
const INTERNAL_BASH_RE = /^(ls|file|cat|head|tail|wc|echo|sleep|pwd|cd|which|type|test|stat|du|df|find|xargs|sort|uniq|tr|cut|awk|sed)\b/

/** 静默计数的工具前缀 → 分类名 */
const SILENT_TOOL_CATEGORIES: ReadonlyArray<{ readonly prefix: string; readonly label: string }> = [
  { prefix: 'mcp__computer-use__', label: '浏览器操作' },
  { prefix: 'mcp__crab-messaging__', label: '消息操作' },
  { prefix: 'mcp__crab-memory__', label: '记忆操作' },
]

// --- Config & Deps ---

export interface ProgressDigestConfig {
  /** 摘要间隔毫秒（默认 120000） */
  readonly intervalMs: number
  /** 摘要模式 */
  readonly mode: 'llm' | 'extract'
  /** 是否为 master 私聊（决定是否脱敏） */
  readonly isMasterPrivate: boolean
}

export interface ProgressDigestDeps {
  /** 发送消息给用户 */
  readonly sendToUser: (text: string) => Promise<void>
  /** 获取近期对话记录 */
  readonly getChatHistory: (limit: number) => Promise<string[]>
  /** digest 模型的 LLM adapter（仅 llm 模式需要） */
  readonly digestAdapter?: LLMAdapter
  /** digest 模型 ID */
  readonly digestModelId?: string
}

// --- Buffer Types ---

interface ToolSummary {
  readonly name: string
  readonly detail: string
}

interface DigestBuffer {
  /** LLM 思考文本片段 */
  readonly texts: readonly string[]
  /** 详细工具操作 */
  readonly detailedTools: readonly ToolSummary[]
  /** 静默工具计数 */
  readonly silentCounts: Readonly<Record<string, number>>
  /** 已摄入的 turn 数 */
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

  constructor(config: ProgressDigestConfig, deps: ProgressDigestDeps) {
    this.config = config
    this.deps = deps
    this.buffer = createEmptyBuffer()
    this.startTimer()
  }

  /** 接收 turn 事件，纯同步写入缓冲区 */
  ingest(event: EngineTurnEvent): void {
    if (this.disposed) return

    // 收集思考文本
    const trimmed = event.assistantText.trim()
    if (trimmed.length > 0) {
      this.buffer = { ...this.buffer, texts: [...this.buffer.texts, trimmed] }
    }

    // 分类工具调用
    let { detailedTools, silentCounts } = this.buffer
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
    this.buffer = { ...this.buffer, detailedTools, silentCounts, turnCount: this.buffer.turnCount + 1 }

    // 即时告警检测
    for (const tc of event.toolCalls) {
      if (tc.name === 'mcp__crabot-worker__ask_human' || tc.isError) {
        this.flushNow()
        return
      }
    }
  }

  /** 立即触发 flush（用于即时告警），异步不阻塞 */
  flushNow(): void {
    if (this.disposed) return
    this.doFlush().catch(() => {})
  }

  /** Engine 结束时调用：取消定时器，丢弃缓冲区 */
  dispose(): void {
    this.disposed = true
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.buffer = createEmptyBuffer()
  }

  // --- Private Methods ---

  private startTimer(): void {
    this.timer = setInterval(() => {
      this.doFlush().catch(() => {})
    }, this.config.intervalMs)
  }

  private async doFlush(): Promise<void> {
    if (isBufferEmpty(this.buffer)) return

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
      // LLM 失败时回退到 extract 模式
      try {
        const fallback = generateExtractDigest(snapshot)
        if (fallback.length > 0) {
          await this.deps.sendToUser(fallback)
          this.digestCount++
        }
      } catch {
        // Fire-and-forget: swallow errors silently
      }
    }
  }

  private async generateLlmDigest(snapshot: DigestBuffer): Promise<string> {
    const { digestAdapter, digestModelId } = this.deps
    if (!digestAdapter || !digestModelId) {
      return generateExtractDigest(snapshot)
    }

    // Fetch chat history for context
    const historyLimit = this.digestCount + 10
    let chatHistory: string[] = []
    try {
      chatHistory = await this.deps.getChatHistory(historyLimit)
    } catch {
      // Continue without history
    }

    const toolSection = formatToolSection(snapshot)

    const userMessage = [
      chatHistory.length > 0 ? `## 近期对话记录\n${chatHistory.join('\n')}` : '',
      '## 本轮执行记录',
      snapshot.texts.length > 0 ? `### 思考文本\n${snapshot.texts.join('\n---\n')}` : '',
      toolSection.length > 0 ? `### 操作记录\n${toolSection}` : '',
    ].filter(s => s.length > 0).join('\n\n')

    const { callNonStreaming } = await import('./llm-adapter.js')
    const { createUserMessage } = await import('./types.js')

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

    // Append tool details below LLM summary
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

function classifyTool(
  toolName: string,
  input: Record<string, unknown>,
): { type: 'detailed'; detail: string } | { type: 'silent'; category: string } | { type: 'ignore' } {
  // Check silent categories first
  for (const cat of SILENT_TOOL_CATEGORIES) {
    if (toolName.startsWith(cat.prefix)) {
      return { type: 'silent', category: cat.label }
    }
  }

  // Check detailed tools
  if (DETAILED_TOOLS.has(toolName)) {
    // Special case: ignore trivial Bash commands
    if (toolName === 'Bash') {
      const cmd = ((input.command as string) ?? '').trim()
      if (INTERNAL_BASH_RE.test(cmd)) return { type: 'ignore' }
    }
    return { type: 'detailed', detail: toolName }
  }

  // Unknown tools → silent with tool name as category
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
      // 脱敏：绝对路径替换为 basename
      const sanitized = cmd.replace(/(?:\/[\w.-]+)+/g, (match) => {
        const segments = match.split('/')
        return segments[segments.length - 1]
      })
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
  if (typeof filePath !== 'string') return '文件'
  const segments = filePath.split('/')
  return segments[segments.length - 1] || '文件'
}

function generateExtractDigest(snapshot: DigestBuffer): string {
  const parts: string[] = []

  // 取每段文本的第一句话
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

  // Detailed tools: dedupe consecutive identical entries
  if (snapshot.detailedTools.length > 0) {
    lines.push(...dedupeDetails(snapshot.detailedTools))
  }

  // Silent counts
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
