import {
  type EngineMessage,
  type EngineUserMessage,
  type EngineAssistantMessage,
  type EngineToolResultMessage,
  type ContentBlock,
  type ToolDefinition,
  createUserMessage,
} from './types'
import { callNonStreaming, type LLMAdapter } from './llm-adapter'

export interface ContextManagerOptions {
  readonly maxContextTokens: number
  readonly compactThreshold?: number    // 0-1, default 0.8
  readonly keepRecentMessages?: number  // default 6
  readonly compactSystemPrompt?: string
}

/**
 * shouldCompact 的触发上下文。spec: 2026-07-21-agent-token-efficiency-design.md 改动 3。
 *
 * 主路径：caller 每轮从 response.usage 算出全量 prompt 大小
 * （inputTokens + cacheReadTokens + cacheCreationTokens）并传入；
 * 其后新增的消息按 chars/4 估算增量累加。
 * usage 缺失（provider 不上报）时不传 lastObservedContextTokens，
 * 回退纯估算路径，但计入 system prompt 长度和 tools schema 估算。
 */
export interface ShouldCompactContext {
  /** 上一轮 LLM 响应 usage 推算出的全量 prompt token 数 */
  readonly lastObservedContextTokens?: number
  /** 记录 lastObservedContextTokens 时的 messages 长度；其后新增消息按估算增量计入 */
  readonly messageCountAtObservation?: number
  /** 当前 system prompt 文本（usage 缺失的估算路径下计入） */
  readonly systemPrompt?: string
  /** 当前工具定义（usage 缺失的估算路径下计入 schema 估算） */
  readonly tools?: ReadonlyArray<ToolDefinition>
}

interface CumulativeUsage {
  readonly inputTokens: number
  readonly outputTokens: number
}

/**
 * 上下文压缩失败（摘要 LLM 调用失败 / 摘要为空 / 找不到合法切点）。
 *
 * 压缩失败**不再**静默回退到纯文本折叠——那条回退对 tool_result 正文一字不减，
 * 等于"假压缩"：上层看到压缩成功、下一轮仍超阈值，于是每轮再烧一次注定失败的摘要调用。
 * 调用方（query-loop）据此走与"主 LLM 调用失败"同一条 failed 路径。
 *
 * 注意：abort 不包在这里——AbortError 原样穿透，让调用方以 aborted 收尾。
 */
export class CompactionFailedError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'CompactionFailedError'
    if (cause !== undefined) {
      ;(this as Error & { cause?: unknown }).cause = cause
    }
  }
}

export const DEFAULT_COMPACT_THRESHOLD = 0.8
const DEFAULT_KEEP_RECENT = 6
const CHARS_PER_TOKEN = 4
const MESSAGE_OVERHEAD_TOKENS = 4
const IMAGE_TOKENS = 1000

/**
 * 摘要输入里单条 tool_result 的字符上限。
 * 依据：pi 的 `TOOL_RESULT_MAX_CHARS = 2000`（coding-agent/src/core/compaction/utils.ts:89）。
 * 摘要要的是"这条命令跑成/跑挂了、关键结论是什么"，不是逐字节日志；
 * 2000 字符（≈500 token）足够覆盖一条命令的头尾结论，又不会让单条 Bash 输出吃掉整个预算。
 */
const SUMMARY_TOOL_RESULT_MAX_CHARS = 2000

/**
 * 摘要输入的总预算比例（相对 maxContextTokens）。
 * 依据：摘要调用与主循环共用同一个上下文窗口，而它恰恰发生在上下文已过 80% 阈值时——
 * 逐条截断不设总量上限时，待折叠段的条数仍然无界（几百条 × 2000 字符照样超窗）。
 * 取窗口的一半：留出 compact system prompt（约 1k token）与摘要输出空间，
 * 且不引入新的可配置项（保留条数/触发阈值/prompt 内容一律不动）。
 */
const SUMMARY_INPUT_BUDGET_RATIO = 0.5

/** findSafeSplitIndex 的哨兵：整段没有任何合法切点（recent 段必然以孤儿 tool_result 打头）。 */
const NO_SAFE_SPLIT = -1

const DEFAULT_COMPACT_SYSTEM_PROMPT = `你正在为一个长任务压缩上下文。你的目标不是复述聊天记录，而是保留后续继续执行任务所必需的、当前有效的上下文状态。

请输出结构化摘要，只输出摘要本身，不要写开场白或解释。摘要必须区分“当前仍有效的信息”和“已经被用户纠正、作废、替换的信息”。

请按以下结构输出；如果某一节没有内容，可以省略该节：

[任务连续性状态]

任务意图与范围:
- 用户当前请求的工作内容、范围、优先级，以及用户后来确认的范围变化。
- 这里只描述对话中已经出现的任务意图，不要把它当作系统 goal 状态。
- 如果对话中出现了系统 goal 的创建、更新或完成结果，只能按原文事实记录其状态；不要自行推断、改写或替代系统 goal。

当前方案:
- 当前采用的方案、实现方向、分析路径或执行顺序。
- 已被用户批准的设计、计划或取舍。
- 如果当前方案仍只是建议或待确认，必须明确标注“待确认”。

用户决定与纠偏:
- 用户明确批准、拒绝、纠正、撤回或改变的内容。
- 如果用户指出之前的假设、结果、口径或实现方向有误，必须写清楚新的有效说法。
- 冲突时，以用户最后明确纠正或确认的内容为准。

约束:
- 必须遵守的硬性要求、禁止事项、兼容性要求、风格要求、预算/时间限制、安全/隐私限制。
- 对后续回复方式有影响的要求，例如必须先给证据、降低断言强度、不要展示某类内容。
- 只记录对后续行为有实际影响的约束。

定义与术语:
- 本任务中特定名称、指标、文件、组件、策略、选项、编号或标签的含义。
- 容易混淆的概念之间的区别。
- 不要把普通名词解释写成术语，除非它在本任务中有特殊含义。

产物与证据:
- 重要文件、命令、测试结果、实验结果、数据输出、链接、决策依据或已验证事实。
- 必须包含足够细节，避免后续误引用、重复验证或把失败结果当成功结果。
- 工具调用只保留对后续有影响的结果，不要记录无关细节。

已作废或被替换的信息:
- 之前出现过但现在不能再作为当前事实使用的结论、指标、方案、假设、产物或数据。
- 必须明确标注“已作废/被替换/禁止继续使用”的原因或替代说法。
- 不要省略“已经作废但后续容易误用”的信息。

未解决问题与风险:
- 仍未确认的问题、已知风险、阻塞点、不确定性或需要继续验证的地方。
- 不要把尚未证明的内容写成结论。
- 如果摘要内容与系统中已有的结构化状态（例如 goal、todo、权限、任务来源）可能冲突，摘要只能记录对话事实，不得声称覆盖这些结构化状态；冲突或不确定时，写入本节。

下一步:
- 后续应该立即执行的具体步骤。
- 如果任务正在进行中，写清楚从哪里继续、先检查什么、不要重复做什么。
- 不要把已经完成、取消或被用户否定的事项写成下一步。

压缩规则:
- 优先保留用户纠偏、用户决定、硬约束、作废信息、验证证据和下一步。
- 不要按时间线流水账复述对话。
- 不要把旧结论和新纠偏混在一起；冲突时，以用户最后明确纠正或确认的内容为准。
- 不要省略“已经作废但后续容易误用”的信息。
- 不要编造原对话中没有的信息；不确定就写成未解决问题或风险。
- 保持简洁，但不能为了简洁丢掉会改变后续行为的信息。`

/** 超长文本按字符上限截断并标注原长度（摘要输入用）。 */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…[已截断，原长 ${text.length} 字符]`
}

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

  shouldCompact(messages: ReadonlyArray<EngineMessage>, context?: ShouldCompactContext): boolean {
    const threshold = this.maxContextTokens * this.compactThreshold
    const observed = context?.lastObservedContextTokens
    const countAtObservation = context?.messageCountAtObservation
    if (
      observed !== undefined &&
      countAtObservation !== undefined &&
      countAtObservation <= messages.length
    ) {
      // 真实 usage 路径：观测值已是当时的全量 prompt 大小（含 system prompt + tools +
      // 全部消息），只需补上其后新增消息的估算增量。
      const delta = this.estimateTotalTokens(messages.slice(countAtObservation))
      return observed + delta >= threshold
    }
    // 估算回退路径：usage 缺失，或观测已失效（compaction 后消息数回缩）。
    // 计入 system prompt 与 tools schema——此前漏算导致系统性低估。
    const staticTokens = this.estimateStaticPromptTokens(context?.systemPrompt, context?.tools)
    return staticTokens + this.estimateTotalTokens(messages) >= threshold
  }

  /** system prompt + tools schema 的 chars/4 估算（估算回退路径用） */
  private estimateStaticPromptTokens(
    systemPrompt?: string,
    tools?: ReadonlyArray<ToolDefinition>,
  ): number {
    let chars = systemPrompt?.length ?? 0
    for (const tool of tools ?? []) {
      chars += tool.name.length + tool.description.length + JSON.stringify(tool.inputSchema).length
    }
    return Math.ceil(chars / CHARS_PER_TOKEN)
  }

  compactMessages(messages: ReadonlyArray<EngineMessage>): ReadonlyArray<EngineMessage> {
    if (messages.length <= this.keepRecentMessages) {
      return [...messages]
    }

    const split = this.partitionForCompaction(messages)
    if (split.kind !== 'ok') {
      return [...messages]
    }

    const summaryText = this.buildSummary(split.oldMessages)
    const summaryMessage = createUserMessage(summaryText)

    return [split.firstMessage, summaryMessage, ...split.recentMessages]
  }

  /**
   * LLM 摘要压缩。失败**不再**静默回退到 compactMessages（那条回退对 tool_result
   * 正文一字不减，等于假压缩）：
   * - 摘要调用失败 / 摘要为空 / 无合法切点 → 抛 CompactionFailedError，由调用方决定收尾；
   * - abort → 原样抛出 AbortError（不包装、不吞掉），调用方以 aborted 收尾。
   *
   * @param signal 任务级取消信号，透传给摘要调用——否则中止后摘要仍会跑完重试链。
   */
  async compactWithLLM(
    messages: ReadonlyArray<EngineMessage>,
    adapter: LLMAdapter,
    model: string,
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<EngineMessage>> {
    if (messages.length <= this.keepRecentMessages) {
      return [...messages]
    }

    const split = this.partitionForCompaction(messages)
    if (split.kind === 'no-safe-split') {
      throw new CompactionFailedError(
        `找不到合法的压缩切点：消息序列中 [1, ${messages.length}) 全是 tool_result，` +
        '任何切点都会让 recent 段以孤儿 tool_result 打头',
      )
    }
    if (split.kind === 'nothing-to-compact') {
      return [...messages]
    }

    const summaryPrompt = this.buildSummaryPrompt(split.oldMessages)
    const promptMessage = createUserMessage(summaryPrompt)

    let response
    try {
      response = await callNonStreaming(adapter, {
        messages: [promptMessage],
        systemPrompt: this.compactSystemPrompt,
        tools: [],
        model,
        ...(signal !== undefined ? { signal } : {}),
      })
    } catch (error) {
      // abort 穿透：任务已在中止路上，不再改写上下文
      if (signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')) {
        throw error
      }
      throw new CompactionFailedError(`摘要 LLM 调用失败: ${String(error)}`, error)
    }

    const summaryText = response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('')

    if (summaryText.trim().length === 0) {
      // 空摘要 = 被折叠的一整段凭空消失，同样是"假装压缩成功"
      throw new CompactionFailedError('摘要 LLM 返回空摘要')
    }

    const summaryMessage = createUserMessage(
      `[Earlier conversation summary]\n${summaryText}`
    )

    return [split.firstMessage, summaryMessage, ...split.recentMessages]
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
   * 切出三段：首条 user message（钉住不压，含 task_origin 等任务级 immortal facts，
   * 被摘要 LLM 丢字段会导致回复发错 channel）、待压缩段、recent 段。
   *
   * - `nothing-to-compact`：首条之后没有更多 old 消息（对话本来就短），正常 no-op；
   * - `no-safe-split`：存在可折叠内容，但整段找不到合法切点——**故障**，不再静默 no-op。
   */
  private partitionForCompaction(messages: ReadonlyArray<EngineMessage>):
    | {
        kind: 'ok'
        firstMessage: EngineMessage
        oldMessages: ReadonlyArray<EngineMessage>
        recentMessages: ReadonlyArray<EngineMessage>
      }
    | { kind: 'nothing-to-compact' }
    | { kind: 'no-safe-split' } {
    const splitIndex = this.findSafeSplitIndex(messages)
    if (splitIndex === NO_SAFE_SPLIT) {
      return { kind: 'no-safe-split' }
    }
    if (splitIndex <= 1) {
      return { kind: 'nothing-to-compact' }
    }
    return {
      kind: 'ok',
      firstMessage: messages[0],
      oldMessages: messages.slice(1, splitIndex),
      recentMessages: messages.slice(splitIndex),
    }
  }

  /**
   * 找到一个安全的 compaction 切割点：保证 recent 段第一条消息不是孤儿 tool_result
   * （其匹配的 tool_use 在被压缩段，会触发 LLM API 400）。
   *
   * 默认切点 = messages.length - keepRecentMessages。如果该位置是 tool_result，
   * 向前回退把对应的 assistant_with_tool_use 一起拉进 recent。engine 自造消息时
   * assistant 与 tool_result 严格相邻，最多回退一步。
   *
   * 但 initialMessages 是外部来源（resume checkpoint / session 树回灌），可能出现
   * 连续 tool_result——旧实现会一路回退到 <=1，让压缩静默变 no-op。因此回退触底后
   * 改为**向后**找第一个非 tool_result 位置（recent 段变短，但配对安全）；
   * 整段都没有合法切点时返回 NO_SAFE_SPLIT，由调用方明确报错，不静默吞掉。
   */
  private findSafeSplitIndex(messages: ReadonlyArray<EngineMessage>): number {
    const defaultIndex = messages.length - this.keepRecentMessages
    if (defaultIndex <= 1) {
      // 对话本来就短：无可折叠内容，交由 partitionForCompaction 判 nothing-to-compact
      return defaultIndex
    }

    let splitIndex = defaultIndex
    while (splitIndex > 1 && this.isToolResultMessage(messages[splitIndex])) {
      splitIndex--
    }
    if (splitIndex > 1 && !this.isToolResultMessage(messages[splitIndex])) {
      return splitIndex
    }

    // 回退触底（连续 tool_result）：向后找第一个合法切点
    for (let forward = defaultIndex + 1; forward < messages.length; forward++) {
      if (!this.isToolResultMessage(messages[forward])) {
        return forward
      }
    }
    return NO_SAFE_SPLIT
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
      const text = this.extractText(msg, SUMMARY_TOOL_RESULT_MAX_CHARS)
      if (text) {
        parts.push(`${role}: ${text}`)
      }
    }

    const lines: string[] = [
      '以下是需要压缩的历史上下文。请生成后续继续执行任务所需的结构化摘要：',
      '',
      ...this.applySummaryInputBudget(parts),
    ]

    if (toolNames.size > 0) {
      lines.push('')
      lines.push(`使用过的工具: ${[...toolNames].join(', ')}`)
    }

    return lines.join('\n')
  }

  /**
   * 摘要输入的总量上界：逐条截断之后条数仍然无界，所以再按总字符预算从**最旧**开始丢弃。
   * 丢最旧是安全的——首条 user message（task_origin / 原始请求）本就被钉住不进摘要输入。
   */
  private applySummaryInputBudget(parts: ReadonlyArray<string>): ReadonlyArray<string> {
    const budgetChars = Math.floor(
      this.maxContextTokens * SUMMARY_INPUT_BUDGET_RATIO * CHARS_PER_TOKEN,
    )
    let used = 0
    let firstKept = parts.length
    for (let i = parts.length - 1; i >= 0; i--) {
      const cost = parts[i].length + 1  // +1: join 的换行
      if (used + cost > budgetChars) break
      used += cost
      firstKept = i
    }
    if (firstKept === 0) {
      return parts
    }
    if (firstKept === parts.length) {
      // 连最后一条都塞不下：保留它的头部，绝不把摘要输入清空
      firstKept = parts.length - 1
      return [
        `[已省略更早的 ${firstKept} 条消息：摘要输入超出 ${budgetChars} 字符预算]`,
        truncate(parts[firstKept], budgetChars),
      ]
    }
    return [
      `[已省略更早的 ${firstKept} 条消息：摘要输入超出 ${budgetChars} 字符预算]`,
      ...parts.slice(firstKept),
    ]
  }

  /**
   * @param maxToolResultChars 单条 tool_result 的字符上限（仅摘要输入路径传，
   *   纯文本折叠路径不传以保持原行为）
   */
  private extractText(msg: EngineMessage, maxToolResultChars?: number): string {
    if (msg.role === 'assistant') {
      const assistantMsg = msg as EngineAssistantMessage
      return assistantMsg.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join(' ')
    }

    if ('toolResults' in msg) {
      const toolMsg = msg as EngineToolResultMessage
      return toolMsg.toolResults
        .map((r) => (maxToolResultChars === undefined ? r.content : truncate(r.content, maxToolResultChars)))
        .join(' ')
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
