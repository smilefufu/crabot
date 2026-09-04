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

export interface CompactionState {
  readonly protectedHead: ReadonlyArray<EngineMessage>
  readonly previousSummary?: string
  readonly history: ReadonlyArray<EngineMessage>
  readonly protectedTail: ReadonlyArray<EngineMessage>
}

export interface CompactionBatchApplication {
  readonly state: CompactionState
  readonly messages: ReadonlyArray<EngineMessage>
  readonly batchNumber: number
  readonly consumedMessages: number
  readonly totalConsumedMessages: number
}

export interface CompactionProfile {
  readonly kind: 'builtin' | 'manager'
  readonly preferredKeepRecent: number
  readonly mainRequestFixedTokens: number
  readonly summarySystemPrompt: string
  readonly summaryMessagePrefix: string
  readonly onBatchApplied?: (batch: CompactionBatchApplication) => void | Promise<void>
}

export type CompactionTarget =
  | { readonly kind: 'preserve_recent' }
  | {
      readonly kind: 'fit_hard_cap'
      readonly hardCapTokens: number
      /** Provider 已明确报满窗口时，即使本地估算偏低也至少压缩一批。 */
      readonly force?: boolean
    }

export interface IncrementalCompactionResult {
  readonly state: CompactionState
  readonly messages: ReadonlyArray<EngineMessage>
  readonly batchesApplied: number
  readonly consumedMessages: number
  readonly failedReason?: string
  readonly aborted?: boolean
  readonly cause?: unknown
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
  readonly batchesApplied: number
  readonly consumedMessages: number

  constructor(
    message: string,
    cause?: unknown,
    progress: { readonly batchesApplied: number; readonly consumedMessages: number } = {
      batchesApplied: 0,
      consumedMessages: 0,
    },
  ) {
    super(message)
    this.name = 'CompactionFailedError'
    this.batchesApplied = progress.batchesApplied
    this.consumedMessages = progress.consumedMessages
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

const SUMMARY_INPUT_BUDGET_RATIO = 0.8

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

const MANAGER_COMPACT_SYSTEM_PROMPT =
  '你是对话历史压缩助手,负责把对话折叠成简洁但保留关键信息的摘要,供后续对话轮次续接上下文。'

export const BUILTIN_SUMMARY_MESSAGE_PREFIX = '[Earlier conversation summary]\n'
export const MANAGER_SUMMARY_MESSAGE_PREFIX =
  '[以下是本次对话更早历史的滚动摘要,不是用户刚发的话]\n\n'

interface CompactionProfileOptions {
  readonly preferredKeepRecent?: number
  readonly mainRequestFixedTokens?: number
  readonly summarySystemPrompt?: string
  readonly onBatchApplied?: CompactionProfile['onBatchApplied']
}

export function createBuiltinCompactionProfile(
  options: CompactionProfileOptions = {},
): CompactionProfile {
  return {
    kind: 'builtin',
    preferredKeepRecent: options.preferredKeepRecent ?? DEFAULT_KEEP_RECENT,
    mainRequestFixedTokens: options.mainRequestFixedTokens ?? 0,
    summarySystemPrompt: options.summarySystemPrompt ?? DEFAULT_COMPACT_SYSTEM_PROMPT,
    summaryMessagePrefix: BUILTIN_SUMMARY_MESSAGE_PREFIX,
    ...(options.onBatchApplied ? { onBatchApplied: options.onBatchApplied } : {}),
  }
}

export function createManagerCompactionProfile(
  options: CompactionProfileOptions = {},
): CompactionProfile {
  return {
    kind: 'manager',
    preferredKeepRecent: options.preferredKeepRecent ?? 20,
    mainRequestFixedTokens: options.mainRequestFixedTokens ?? 0,
    summarySystemPrompt: options.summarySystemPrompt ?? MANAGER_COMPACT_SYSTEM_PROMPT,
    summaryMessagePrefix: MANAGER_SUMMARY_MESSAGE_PREFIX,
    ...(options.onBatchApplied ? { onBatchApplied: options.onBatchApplied } : {}),
  }
}

/** 超长文本按字符上限截断并标注原长度（摘要输入用）。 */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…[已截断，原长 ${text.length} 字符]`
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function isContextWindowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /(?:maximum\s+)?context.{0,24}(?:length|window|limit|too\s+(?:long|large)|exceed)|prompt.{0,24}too\s+(?:long|large)|too\s+many\s+tokens|token\s+limit.{0,16}(?:exceed|reach)/i.test(message)
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

  getHardCapTokens(): number {
    return Math.floor(this.maxContextTokens * this.compactThreshold)
  }

  /** system prompt + tools schema 的 chars/4 估算。 */
  estimateStaticPromptTokens(
    systemPrompt?: string,
    tools?: ReadonlyArray<ToolDefinition>,
  ): number {
    let chars = systemPrompt?.length ?? 0
    for (const tool of tools ?? []) {
      chars += tool.name.length + tool.description.length + JSON.stringify(tool.inputSchema).length
    }
    return Math.ceil(chars / CHARS_PER_TOKEN)
  }

  /** 兼容原 builtin 调用形态；实际工作全部委托给统一的增量压缩循环。 */
  async compactWithLLM(
    messages: ReadonlyArray<EngineMessage>,
    adapter: LLMAdapter,
    model: string,
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<EngineMessage>> {
    const result = await this.compactBuiltinMessages({
      messages,
      adapter,
      model,
      target: { kind: 'preserve_recent' },
      ...(signal ? { signal } : {}),
    })
    if (result.aborted) {
      throw result.cause ?? new DOMException('Aborted', 'AbortError')
    }
    if (result.failedReason !== undefined) {
      throw new CompactionFailedError(result.failedReason, result.cause, result)
    }
    return result.messages
  }

  async compactBuiltinMessages(args: {
    readonly messages: ReadonlyArray<EngineMessage>
    readonly adapter: LLMAdapter
    readonly model: string
    readonly target: CompactionTarget
    readonly mainRequestFixedTokens?: number
    readonly signal?: AbortSignal
    readonly onBatchApplied?: CompactionProfile['onBatchApplied']
  }): Promise<IncrementalCompactionResult> {
    const state = this.projectBuiltinState(args.messages)
    const result = await this.compactIncrementally({
      state,
      profile: createBuiltinCompactionProfile({
        preferredKeepRecent: this.keepRecentMessages,
        mainRequestFixedTokens: args.mainRequestFixedTokens,
        summarySystemPrompt: this.compactSystemPrompt,
        onBatchApplied: args.onBatchApplied,
      }),
      target: args.target,
      adapter: args.adapter,
      model: args.model,
      ...(args.signal ? { signal: args.signal } : {}),
    })
    return result.batchesApplied === 0
      ? { ...result, messages: [...args.messages] }
      : result
  }

  async compactIncrementally(args: {
    readonly state: CompactionState
    readonly profile: CompactionProfile
    readonly target: CompactionTarget
    readonly adapter: LLMAdapter
    readonly model: string
    readonly signal?: AbortSignal
  }): Promise<IncrementalCompactionResult> {
    const { profile, target, adapter, model, signal } = args
    let state = this.copyState(args.state)
    let messages = this.materializeCompactionState(state, profile)
    let batchesApplied = 0
    let consumedMessages = 0
    let forcedBatchPending = target.kind === 'fit_hard_cap' && target.force === true

    const finish = (
      extra: Pick<IncrementalCompactionResult, 'failedReason' | 'aborted' | 'cause'> = {},
    ): IncrementalCompactionResult => ({
      state,
      messages,
      batchesApplied,
      consumedMessages,
      ...extra,
    })

    while (true) {
      if (signal?.aborted) {
        return finish({ aborted: true, cause: new DOMException('Aborted', 'AbortError') })
      }
      if (target.kind === 'preserve_recent') {
        if (state.history.length <= profile.preferredKeepRecent) return finish()
      } else if (!forcedBatchPending && this.estimateCompactionStateTokens(state, profile) <= target.hardCapTokens) {
        return finish()
      }

      const maxBatchMessages = this.maxConsumablePrefix(state.history, profile.preferredKeepRecent)
      if (maxBatchMessages <= 0) {
        if (
          target.kind === 'preserve_recent'
          && state.history.length > 0
          && !this.isToolResultMessage(state.history[0])
        ) {
          return finish()
        }
        return finish({
          failedReason: target.kind === 'fit_hard_cap'
            && (state.history.length === 0 || !this.isToolResultMessage(state.history[0]))
            ? `主请求固定开销、受保护内容与最小安全消息组仍超过 hardCap ${target.hardCapTokens} token，历史压缩无法解决`
            : '找不到合法的压缩切点：必须保留至少一个安全消息组，且 remaining history 不能以孤儿 tool_result 开头',
        })
      }

      let candidateLimit = Math.floor(this.maxContextTokens * SUMMARY_INPUT_BUDGET_RATIO)
      let candidateMaxMessages = maxBatchMessages
      let retryReason: string | undefined

      while (true) {
        const candidate = this.selectLargestBatch(
          state,
          profile,
          candidateMaxMessages,
          candidateLimit,
        )
        if (!candidate) {
          return finish({
            failedReason: retryReason
              ? `${retryReason}；缩至最小安全消息组后仍无法继续`
              : `最小安全消息组的完整摘要请求仍超过输入上限 ${candidateLimit} token`,
          })
        }

        let response
        try {
          response = await callNonStreaming(adapter, {
            messages: [createUserMessage(candidate.prompt)],
            systemPrompt: profile.summarySystemPrompt,
            tools: [],
            model,
            ...(signal ? { signal } : {}),
          })
        } catch (error) {
          if (signal?.aborted || isAbortError(error)) {
            return finish({ aborted: true, cause: error })
          }
          if (!isContextWindowError(error)) {
            return finish({ failedReason: `摘要 LLM 调用失败: ${String(error)}`, cause: error })
          }
          retryReason = `摘要请求超过 Provider 上下文窗口: ${String(error)}`
          const shrunk = this.shrinkCandidate(state, profile, candidate)
          candidateLimit = shrunk.inputLimit
          candidateMaxMessages = shrunk.maxMessages
          continue
        }

        if (response.stopReason === 'max_tokens') {
          retryReason = '摘要 LLM 输出因 max_tokens 截断'
          const shrunk = this.shrinkCandidate(state, profile, candidate)
          candidateLimit = shrunk.inputLimit
          candidateMaxMessages = shrunk.maxMessages
          continue
        }

        const summary = response.content
          .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
          .map((block) => block.text)
          .join('')
        if (summary.trim().length === 0) {
          return finish({ failedReason: '摘要 LLM 返回空摘要' })
        }

        const nextState: CompactionState = {
          protectedHead: state.protectedHead,
          previousSummary: summary,
          history: state.history.slice(candidate.messageCount),
          protectedTail: state.protectedTail,
        }
        const beforeTokens = this.estimateCompactionStateTokens(state, profile)
        const afterTokens = this.estimateCompactionStateTokens(nextState, profile)
        if (afterTokens >= beforeTokens) {
          retryReason = `压缩后 token 未下降（before=${beforeTokens}, after=${afterTokens}）`
          const shrunk = this.shrinkCandidate(state, profile, candidate)
          candidateLimit = shrunk.inputLimit
          candidateMaxMessages = shrunk.maxMessages
          continue
        }

        const nextMessages = this.materializeCompactionState(nextState, profile)
        try {
          await profile.onBatchApplied?.({
            state: nextState,
            messages: nextMessages,
            batchNumber: batchesApplied + 1,
            consumedMessages: candidate.messageCount,
            totalConsumedMessages: consumedMessages + candidate.messageCount,
          })
        } catch (error) {
          if (signal?.aborted || isAbortError(error)) {
            return finish({ aborted: true, cause: error })
          }
          return finish({ failedReason: `压缩批次应用失败: ${String(error)}`, cause: error })
        }

        state = nextState
        messages = nextMessages
        batchesApplied++
        consumedMessages += candidate.messageCount
        forcedBatchPending = false
        break
      }
    }
  }

  estimateCompactionStateTokens(state: CompactionState, profile: CompactionProfile): number {
    return profile.mainRequestFixedTokens
      + this.estimateTotalTokens(this.materializeCompactionState(state, profile))
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

  private copyState(state: CompactionState): CompactionState {
    return {
      protectedHead: [...state.protectedHead],
      ...(state.previousSummary !== undefined ? { previousSummary: state.previousSummary } : {}),
      history: [...state.history],
      protectedTail: [...state.protectedTail],
    }
  }

  private projectBuiltinState(messages: ReadonlyArray<EngineMessage>): CompactionState {
    const protectedHead = messages.slice(0, 1)
    const possibleSummary = messages[1]
    if (
      possibleSummary?.role === 'user'
      && !('toolResults' in possibleSummary)
      && typeof possibleSummary.content === 'string'
      && possibleSummary.content.startsWith(BUILTIN_SUMMARY_MESSAGE_PREFIX)
    ) {
      return {
        protectedHead,
        previousSummary: possibleSummary.content.slice(BUILTIN_SUMMARY_MESSAGE_PREFIX.length),
        history: messages.slice(2),
        protectedTail: [],
      }
    }
    return { protectedHead, history: messages.slice(1), protectedTail: [] }
  }

  private materializeCompactionState(
    state: CompactionState,
    profile: CompactionProfile,
  ): ReadonlyArray<EngineMessage> {
    return [
      ...state.protectedHead,
      ...(state.previousSummary === undefined
        ? []
        : [createUserMessage(profile.summaryMessagePrefix + state.previousSummary)]),
      ...state.history,
      ...state.protectedTail,
    ]
  }

  private maxConsumablePrefix(
    history: ReadonlyArray<EngineMessage>,
    preferredKeepRecent: number,
  ): number {
    const preferred = history.length - preferredKeepRecent
    if (preferred > 0) {
      for (let split = preferred; split > 0; split--) {
        if (this.isSafeSplit(history, split)) return split
      }
      for (let split = preferred + 1; split < history.length; split++) {
        if (this.isSafeSplit(history, split)) return split
      }
      return NO_SAFE_SPLIT
    }

    // hardCap / Provider 强制恢复允许少保留于 preferred 数量，但至少留一个安全消息组。
    for (let split = history.length - 1; split > 0; split--) {
      if (this.isSafeSplit(history, split)) return split
    }
    return NO_SAFE_SPLIT
  }

  private isSafeSplit(history: ReadonlyArray<EngineMessage>, split: number): boolean {
    return split > 0
      && split < history.length
      && !this.isToolResultMessage(history[split])
  }

  private selectLargestBatch(
    state: CompactionState,
    profile: CompactionProfile,
    maxMessages: number,
    inputLimit: number,
  ): { readonly messageCount: number; readonly prompt: string; readonly inputTokens: number } | undefined {
    const safeCounts: number[] = []
    for (let count = 1; count <= maxMessages; count++) {
      if (this.isSafeSplit(state.history, count)) safeCounts.push(count)
    }
    let low = 0
    let high = safeCounts.length - 1
    let selected: { messageCount: number; prompt: string; inputTokens: number } | undefined
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const messageCount = safeCounts[middle]
      const prompt = this.buildSummaryPrompt(
        state.previousSummary,
        state.history.slice(0, messageCount),
        profile,
      )
      const inputTokens = this.estimateSummaryRequestTokens(prompt, profile)
      if (inputTokens <= inputLimit) {
        selected = { messageCount, prompt, inputTokens }
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    return selected
  }

  private shrinkCandidate(
    state: CompactionState,
    profile: CompactionProfile,
    candidate: { readonly messageCount: number; readonly inputTokens: number },
  ): { readonly maxMessages: number; readonly inputLimit: number } {
    const fixedTokens = this.estimateSummaryRequestTokens(
      this.buildSummaryPrompt(state.previousSummary, [], profile),
      profile,
    )
    return {
      maxMessages: candidate.messageCount - 1,
      inputLimit: fixedTokens + Math.max(1, Math.floor((candidate.inputTokens - fixedTokens) / 2)),
    }
  }

  private estimateSummaryRequestTokens(prompt: string, profile: CompactionProfile): number {
    return this.estimateStaticPromptTokens(profile.summarySystemPrompt, [])
      + this.estimateMessageTokens(createUserMessage(prompt))
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

  private buildSummaryPrompt(
    previousSummary: string | undefined,
    messages: ReadonlyArray<EngineMessage>,
    profile: CompactionProfile,
  ): string {
    if (profile.kind === 'manager') {
      const parts: string[] = []
      if (previousSummary !== undefined) parts.push(`此前摘要:\n${previousSummary}`)
      parts.push(`待折叠的新增对话:\n${messages.map((message) => this.renderManagerMessage(message)).join('\n\n')}`)
      parts.push('请把以上内容(含此前摘要,若有)合并为一段更新后的摘要,只输出摘要正文本身,不要加任何前后缀说明、时间戳或计数。')
      return parts.join('\n\n')
    }

    const parts: string[] = []
    const toolNames = new Set<string>()
    for (const message of messages) {
      if (message.role === 'assistant') {
        for (const block of message.content) {
          if (block.type === 'tool_use') toolNames.add(block.name)
        }
      }
      const role = message.role === 'assistant' ? 'Assistant' : 'User'
      const text = this.extractText(message, SUMMARY_TOOL_RESULT_MAX_CHARS)
      if (text) parts.push(`${role}: ${text}`)
    }

    const lines = ['以下是需要压缩的历史上下文。请生成后续继续执行任务所需的结构化摘要：']
    if (previousSummary !== undefined) {
      lines.push('', `此前摘要:\n${previousSummary}`)
    }
    lines.push('', ...parts)
    if (toolNames.size > 0) lines.push('', `使用过的工具: ${[...toolNames].join(', ')}`)
    return lines.join('\n')
  }

  private renderManagerMessage(message: EngineMessage): string {
    if (message.role === 'assistant') {
      return `assistant: ${this.extractText(message)}`
    }
    if ('toolResults' in message) {
      return message.toolResults
        .map((result) => `tool_result(${result.tool_use_id}): ${result.content}`)
        .join('\n')
    }
    return `user: ${this.extractText(message)}`
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
