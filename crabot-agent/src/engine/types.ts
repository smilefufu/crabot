import { randomUUID } from 'crypto'
import type { LLMAdapter, LLMThinkingConfig } from './llm-adapter-types.js'

// --- Content Blocks ---

export interface TextBlock {
  readonly type: 'text'
  readonly text: string
}

export interface ImageBlock {
  readonly type: 'image'
  readonly source: {
    readonly type: 'base64' | 'url'
    readonly media_type: string
    readonly data: string
  }
}

export interface ToolUseBlock {
  readonly type: 'tool_use'
  readonly id: string
  readonly name: string
  readonly input: Record<string, unknown>
}

export interface ToolResultBlock {
  readonly type: 'tool_result'
  readonly tool_use_id: string
  readonly content: string
  readonly is_error: boolean
}

/**
 * Raw reasoning block for OpenAI Responses API (Codex backend).
 * Stores the full reasoning item JSON so it can be replayed back in subsequent turns.
 * Other adapters ignore this block type.
 */
export interface RawReasoningBlock {
  readonly type: 'raw_reasoning'
  readonly data: Record<string, unknown>
}

export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock | RawReasoningBlock

// --- Token Usage ---

/**
 * LLM 调用的 token 用量。adapter 透传，trace 持久化时聚合到 AgentTrace.total_usage。
 * cache 字段对齐 Anthropic prompt caching；OpenAI cached_tokens 归到 cacheReadTokens。
 */
export interface LLMTokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheCreationTokens?: number
  readonly cacheReadTokens?: number
}

// --- Messages ---

export interface EngineUserMessage {
  readonly id: string
  readonly role: 'user'
  readonly content: string | ContentBlock[]
  readonly timestamp: number
}

export interface EngineAssistantMessage {
  readonly id: string
  readonly role: 'assistant'
  readonly content: ContentBlock[]
  readonly stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | null
  readonly timestamp: number
  readonly usage?: LLMTokenUsage
}

export interface EngineToolResultMessage {
  readonly id: string
  readonly role: 'user'
  readonly toolResults: ReadonlyArray<{
    readonly tool_use_id: string
    readonly content: string
    readonly images?: ReadonlyArray<{ readonly media_type: string; readonly data: string }>
    readonly is_error: boolean
  }>
  readonly timestamp: number
}

export type EngineMessage = EngineUserMessage | EngineAssistantMessage | EngineToolResultMessage

// --- Tool Permission ---

export type ToolPermissionLevel = 'safe' | 'normal' | 'dangerous'

export type ToolCategory =
  | 'memory'
  | 'messaging'
  | 'task'
  | 'mcp_skill'
  | 'file_io'
  | 'browser'
  | 'shell'
  | 'remote_exec'
  | 'desktop'

export type PermissionMode =
  | 'bypass'       // All tools allowed (for trusted contexts like admin chat)
  | 'allowList'    // Only listed tools allowed
  | 'denyList'     // All except listed tools allowed

export interface ToolPermissionConfig {
  readonly mode: PermissionMode
  /** Tool names for allowList/denyList */
  readonly toolNames?: ReadonlyArray<string>
  /** Optional callback for dynamic permission decisions */
  readonly checkPermission?: (toolName: string, input: Record<string, unknown>) => Promise<PermissionDecision>
}

export type PermissionDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string }

// --- Tool Definition ---

export interface ToolCallContext {
  readonly abortSignal?: AbortSignal
  readonly onProgress?: (message: string) => void
  /** IANA 时区名（如 "Asia/Shanghai"），用于 tool_result 时间戳渲染 */
  readonly timezone?: string
  /** Injected only while a builtin Worker invokes delegate_task. */
  readonly worker_subagent?: {
    readonly worker_id: string
    readonly parent_trace_id?: string
  }
  /**
   * 外部输入 pending 探针（spec 2026-08-29-worker-input-turn-boundary-delivery）：
   * 长等待工具（Output block=true 的 poll loop）每次睡醒后查询——源队列有排队输入时
   * 提前返回，让输入在紧接着的 turn 边界被注入。非消费性查询。未接线时为 undefined。
   */
  readonly hasPendingExternalInput?: () => boolean
}

export interface ToolCallResult {
  readonly output: string
  readonly images?: ReadonlyArray<{ readonly media_type: string; readonly data: string }>
  readonly isError: boolean
}

export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly isReadOnly: boolean
  readonly permissionLevel?: ToolPermissionLevel
  readonly category?: ToolCategory
  /**
   * 仅 turn 0 可调用。在 turn ≥ 1 调用此工具时，引擎不真正执行 `call`，
   * 而是返回 error 类工具结果（"Tool 'X' is only callable on turn 0..."），
   * 让 LLM 看到拒绝信号并自行调整。
   *
   * 用于 turn 0 triage 决策工具（如未来可能新增的 turn 0 早退判定）。
   */
  readonly turnZeroOnly?: boolean
  /**
   * 调用后引擎立刻退出 loop，把工具调用信息（name + input）写入 EngineResult.exitToolCall。
   * 引擎不调用 `call` 函数（exit 工具本身无需执行），但会为本轮所有 tool_use
   * push 合成 tool_result，确保 finalMessages / checkpoint 可被 LLM API 重放。
   *
   * 用于"调完就走"的早退工具（如 submit_audit_result）。
   */
  readonly exitsLoop?: boolean
  readonly call: (input: Record<string, unknown>, context: ToolCallContext) => Promise<ToolCallResult>
}

// --- Stream Chunks ---

export type StreamChunk =
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'tool_use_start'; readonly id: string; readonly name: string }
  | { readonly type: 'tool_use_delta'; readonly id: string; readonly inputJson: string }
  | { readonly type: 'tool_use_end'; readonly id: string }
  | { readonly type: 'raw_reasoning'; readonly data: Record<string, unknown> }
  | { readonly type: 'message_start'; readonly messageId: string }
  | { readonly type: 'message_end'; readonly stopReason: string | null; readonly usage?: LLMTokenUsage }
  | { readonly type: 'error'; readonly error: string }

// --- Engine Options & Result ---

export interface EngineTurnEvent {
  readonly turnNumber: number
  readonly assistantText: string
  readonly toolCalls: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly input: Record<string, unknown>
    readonly output: string
    readonly isError: boolean
    /** Per-tool wall-clock duration (ms) */
    readonly durationMs?: number
    /** Per-tool wall-clock start time (ms epoch) */
    readonly startedAtMs?: number
  }>
  readonly stopReason: EngineAssistantMessage['stopReason']
  /** LLM API call wall-clock time this turn (ms) */
  readonly llmCallMs?: number
  /** LLM API call start (ms epoch) */
  readonly llmStartedAtMs?: number
  /**
   * 当前轮是否由"沉默 end_turn 追问"机制触发（1-indexed）。
   * 未触发时 undefined。turnNumber 仍按全局 LLM 调用次数递增；该字段
   * 单独标识"这一轮 user msg 是 engine 注入的强制汇报追问"。
   */
  readonly forcedSummaryAttempt?: number
  /** 本轮 LLM 调用的 token 用量；adapter 透传，无则缺省 */
  readonly usage?: LLMTokenUsage
  /** 本轮 LLM 流式消费诊断（首 chunk 延迟 / chunk 数 / 重试次数）；无则缺省 */
  readonly diagnostics?: LLMCallDiagnostics
}

/** 流式消费诊断（仅成功路径填充），供 trace/span 观测 */
export interface LLMCallDiagnostics {
  /** 成功前重试了几次（0 = 一次成功） */
  readonly retries: number
  /** 本次成功 attempt 的首 chunk 延迟（ms）；流未出 chunk 即结束时为 undefined */
  readonly firstChunkMs?: number
  /** 本次成功 attempt 收到的 chunk 数 */
  readonly chunkCount: number
}

/** 既可传静态值也可传 callback（每轮 resolve） */
export type Resolvable<T> = T | (() => T)

/**
 * 主 loop 对话状态的外部只读 holder（progress digest 等 observer 用）。
 * engine 每轮刷新 `current`；每次 LLM 调用前同步快照该轮实际使用的
 * systemPrompt / tools —— fork 调用逐字节复用这两者，保证与主 loop 最近
 * 一次请求的 prompt cache 前缀完全一致（不依赖 builder 回调的确定性，
 * 也不受 admin push config 热更新 system prompt / tools 的时序影响）。
 */
export interface EngineMessagesRef {
  current: ReadonlyArray<EngineMessage>
  systemPrompt?: string
  tools?: ReadonlyArray<ToolDefinition>
}

/**
 * 实时进度事件（细粒度）。
 *
 * 与 `EngineTurnEvent` 的区别：onTurn 是事后回调（工具执行完才触发，所有 span
 * 一次性写入），而 `LiveProgressEvent` 在 LLM 返回 / 工具开始 / 工具结束三个时
 * 间点都会发送，让外部观察者能感知"飞行中"状态。
 */
export type LiveProgressEvent =
  | {
      readonly type: 'turn_assistant'
      readonly turn: number
      readonly text: string
    }
  | {
      readonly type: 'tools_start'
      readonly tools: ReadonlyArray<{ readonly name: string; readonly input_summary: string }>
    }
  | {
      readonly type: 'tools_end'
      readonly results: ReadonlyArray<{
        readonly name: string
        readonly input_summary: string
        readonly is_error: boolean
      }>
    }
  | {
      /** LLM 调用重试触发；用于 admin web 显示"正在重试"状态 */
      readonly type: 'llm_retry'
      readonly turn: number          // 当前正在尝试的 turn 编号
      readonly attempt: number       // 第几次失败 (1-indexed)
      readonly maxAttempts: number   // 总配额
      readonly source: 'stream'
      readonly error: string         // 触发 retry 的 error message（截断 200）
    }

/**
 * endTurnGate 的决策结果（见 EngineOptions.endTurnGate 注释）。
 */
export type EndTurnGateResult =
  | string
  | { readonly kind: 'fail'; readonly reason: string }
  | null

export interface EngineOptions {
  readonly systemPrompt: Resolvable<string>
  readonly tools: Resolvable<ReadonlyArray<ToolDefinition>>
  readonly model: string
  readonly maxTurns?: number
  readonly maxTokens?: number
  readonly abortSignal?: AbortSignal
  readonly onTurn?: (event: EngineTurnEvent) => void
  /** 实时进度回调（fires LLM 返回 / 工具开始 / 工具结束三处）—— 见 LiveProgressEvent */
  readonly onLiveProgress?: (event: LiveProgressEvent) => void
  readonly permissionConfig?: ToolPermissionConfig
  readonly supportsVision?: boolean
  readonly humanMessageQueue?: HumanMessageQueueLike
  /**
   * turn 边界外部输入源（spec 2026-08-29-worker-input-turn-boundary-delivery）。
   *
   * 每轮「工具执行完成后、下一轮 LLM 调用前」调用一次，返回待注入的外部输入文本；
   * 取出即从源队列移除（由 caller 负责其 FIFO / 优先级 / receipt 结算）。返回的每条
   * 文本作为 user message 注入当前 burst（worker inbox 的 manager 投递由此在 turn
   * 边界可见，不再等 burst 结束）。
   *
   * 仅在仍有剩余 turn 时调用（最后一轮注入无人消费）；回调抛错时 engine 跳过本轮
   * 注入（输入保留在源队列，下一轮重试），不影响 burst。不传时行为与现状一致。
   */
  readonly drainExternalInputs?: () => ReadonlyArray<string> | Promise<ReadonlyArray<string>>
  /**
   * 外部输入 pending 探针（与 drainExternalInputs 同源，非消费性）：engine 经
   * ToolCallContext.hasPendingExternalInput 透传给长等待工具（Output block），让它在
   * 源队列有排队输入时提前返回。不传时工具行为与现状一致。
   */
  readonly hasPendingExternalInputs?: () => boolean
  readonly hookRegistry?: import('../hooks/hook-registry').HookRegistry
  readonly lspManager?: import('../hooks/types').LspManagerLike
  /** IANA 时区名（如 "Asia/Shanghai"），用于 tool_result 时间戳渲染 */
  readonly timezone?: string
  /** 当前消息发起人是否 master——CLI permission gate hook 的 master 短路依据 */
  readonly senderIsMaster?: boolean
  /** 发起人 effective permissions（friend ∪ session 并集）——CLI permission gate hook 用（静态兜底） */
  readonly resolvedPermissions?: import('../types.js').ResolvedPermissions
  /**
   * 任务权限活值 getter（存在时 hook 优先读它）。由 worker loop 注入 taskState 持有者，
   * supplement/resume 刷新后下一轮 hook 即生效（spec: 2026-07-20-task-permission-hot-refresh-design.md）。
   */
  readonly getResolvedPermissions?: () => import('../types.js').ResolvedPermissions | undefined
  /** 内容审核器——CLI permission gate 在 schedule add 时调用 */
  readonly contentReviewer?: import('../hooks/types.js').ContentReviewer
  /** 当前会话场景，用于拒绝指引文案区分群/私聊 */
  readonly sessionType?: 'private' | 'group'
  /**
   * 在 context-manager compaction 完成后回调，返回最终注入到 messages 的数组。
   * 用于在 compaction 边界注入 per-task 状态（如 worker 的 todo active list），
   * 注入到 user msg 而非 system prompt 以保护 prompt cache。
   * 不传时不做任何处理。
   */
  readonly onAfterCompaction?: (messages: ReadonlyArray<EngineMessage>) => ReadonlyArray<EngineMessage>
  /**
   * 外部只读访问当前 messages 数组的 holder。engine 在每个 turn 完成时浅拷贝赋值
   * `current`。用于 progress digest 等需要从主 loop 上下文 fork 出来做摘要但不能
   * 修改主 loop 的观察者。
   *
   * 不传时 engine 不更新；ref 对象由 caller 维护生命周期。`current` 字段可写但
   * 写入的数组本身是 ReadonlyArray —— 外部只读，不应原地修改。
   */
  readonly messagesRef?: EngineMessagesRef
  /**
   * LLM 重试期间配置热切换（spec 2026-08-30-llm-retry-config-hotreload）。
   *
   * configChangedSignal 在「运行时配置 revision 已前进」时 abort；callNonStreaming 的
   * 重试 sleep 被它提前唤醒后调用 onConfigChanged，用返回的新 adapter/model 继续
   * 下一次 attempt（attempt 配额不因此消耗）。仅在重试 sleep 阶段生效：已经开始向
   * 下游交付 chunk 的调用不中断。不传时行为与现状一致（重试始终用调用时的 adapter）。
   */
  readonly configChangedSignal?: AbortSignal
  readonly onConfigChanged?: () => Promise<{ adapter?: LLMAdapter; model?: string } | void>
  /** 已组装本轮 messages、即将调用 Provider 前的内部准入观察点。 */
  readonly onBeforeLlmCall?: () => void | Promise<void>
  /**
   * 引擎层主动向 loop 注入 user message 时触发（trace 可见性钩子）。
   *
   * 当前 5 类注入：
   * - `supplement` —— humanMessageQueue 实时纠偏注入
   * - `external_input` —— drainExternalInputs 在 turn 边界消费的外部输入（worker inbox）
   * - `forced_summary` —— silent end_turn 兜底要求模型重说
   * - `stop_hook` —— Stop hook block 后注入的引导文本
   * - `assistant_text_end_turn` —— 非空 assistant text + end_turn 走错通道纠偏提醒
   *
   * caller 可把它接到 traceCallback / 日志 / metric——engine 自身不做任何 trace 写入。
   */
  readonly onSystemInjection?: (event: SystemInjectionEvent) => void
  /**
   * 非空 assistant text + end_turn 的收尾处理钩子。unified worker 用它区分：
   * - assistant text 走错通道且当前 epoch 未送达 → caller 可自动交付并返回 complete
   * - 当前 epoch 已送达但仍输出 assistant text → caller 可注入一次纠偏提醒
   *
   * 不传时 engine 保持原行为：assistant text 作为 finalText 返回，不做任何交付假设。
   */
  readonly assistantTextEndTurnHandler?: (event: {
    readonly assistantText: string
    readonly turnNumber: number
  }) => Promise<
    | { readonly kind: 'complete' }
    | { readonly kind: 'inject'; readonly text: string }
  >
  /**
   * 抑制 forced_summary 注入的判定回调。返回 true → engine 跳过 silent end_turn 的
   * forced_summary 兜底机制，直接接受 silent end_turn 作为正常完成态。
   *
   * 设计动机：老 worker 路径下 finalText 是交付，silent end_turn 是异常→需要 forced_summary
   * 兜底。新 unified loop 下交付走 send_message 工具，silent end_turn 是设计预期。caller
   * caller 传 `() => sentInfoMessage || hasGoal || isScheduled` 来表达当前上下文下 silent end_turn 是预期行为。
   *
   * 不传时维持现有行为：始终启用 forced_summary。
   */
  readonly suppressForcedSummary?: () => boolean
  /**
   * end_turn 前的异步决策钩子。engine 在自然退出前调用（suppressForcedSummary=true 的 silent
   * end_turn 路径，以及有文字/forced_summary 耗尽的路径）。
   * - 返回 string → 注入为 user message 继续 loop（NO_DELIVERY 提示等）
   * - 返回 { kind: 'fail' } → gate 判定无法安全收口，engine 以 failed 结束
   * - 返回 null → 正常退出
   * 不传时直接退出。
   */
  readonly endTurnGate?: () => Promise<EndTurnGateResult>
  /**
   * 上下文压缩开始时触发（trace 可见性钩子）。
   * compaction 内部跑一次 LLM call 做摘要，可能耗时几秒——不接 trace 就是黑洞。
   */
  readonly onCompactionStart?: () => void
  /**
   * 上下文压缩结束时触发（成功与失败都触发，失败路径也要关掉 trace span）。
   * `info` 含压缩前后消息数与耗时；`failedReason` 存在表示这次**没压成**
   * （messages 保持原样，afterCount === beforeCount）——不得当成压缩成功汇报。
   * 值为 'aborted' 时表示任务被中止，非压缩本身故障。
   */
  readonly onCompactionEnd?: (info: {
    readonly beforeCount: number
    readonly afterCount: number
    readonly durationMs: number
    readonly failedReason?: string
  }) => void
  /**
   * 禁用所有 compaction 触发路径（既不自动压缩，也不在 max_tokens 静默响应时压缩重试）。
   *
   * 设计动机：subagent 应当是"短命 + 有界 + 独立"的，靠 maxTurns 控制资源消耗，
   * 不让其跑到需要压缩的规模。一旦 subagent 内部 compact，会出现：
   * 1) 父 agent 无感知（trace 黑洞）；
   * 2) 嵌套 LLM call（compaction 摘要也要 LLM），行为不可预测；
   * 3) 返回给父的 finalText 基于压缩后的视角，丢失原始决策依据。
   *
   * 该标志默认 false（主 worker handler 行为不变）；forkEngine 显式传 true。
   * 若 subagent 不幸跑到 max_tokens，直接以 outcome='completed' 空 finalText 退出，
   * 由父 agent 根据 totalTurns + 空 output 判断是否拆任务 / 上调 budget。
   */
  readonly disableCompaction?: boolean

  /**
   * 当前模型的 context window（token 数），来自 provider 模型配置的 context_window。
   * 缺失时 engine 回退到内置默认 200000。仅影响 compaction 触发阈值，不影响请求参数。
   */
  readonly contextWindowTokens?: number

  /**
   * 槽位思考强度（2026-08）；undefined = 跟随模型默认（请求中不出现任何思考参数）。
   * 来自 provider 槽位配置的 thinking_level/thinking_custom，随 LLMStreamParams 进 adapter。
   */
  readonly thinking?: LLMThinkingConfig
}

export interface HumanMessageQueueLike {
  readonly drainPending: () => Array<string | ContentBlock[]>
  readonly hasPending: boolean
  readonly hasBarrier: boolean
  /** 工具可在执行期间布防，等待人类补充或超时。 */
  readonly setBarrier: (timeoutMs: number, onTimeout?: () => void) => void
  readonly waitBarrier: (signal?: AbortSignal) => Promise<void>
  readonly clearBarrier: () => void
}

/**
 * 引擎主动注入 user message 时的事件描述。详见 EngineOptions.onSystemInjection。
 */
export interface SystemInjectionEvent {
  /**
   * 注入类型：
   * - `supplement`：humanMessageQueue 实时纠偏注入
   * - `external_input`：drainExternalInputs 在 turn 边界消费的外部输入（如 worker inbox 的 manager 投递）
   * - `forced_summary`：silent end_turn 兜底要求模型重说
   * - `stop_hook`：Stop hook block 后注入的引导文本
   * - `assistant_text_end_turn`：非空 assistant text + end_turn 走错通道纠偏提醒
   */
  readonly type: 'supplement' | 'external_input' | 'forced_summary' | 'stop_hook' | 'assistant_text_end_turn'
  /** 注入的文本内容（不含 ContentBlock[] 形态——supplement 的 ContentBlock 注入退化为 type 字符串描述） */
  readonly text: string
  /** 注入发生时的 turn 序号（与 EngineTurnEvent.turnNumber 同口径） */
  readonly turnNumber: number
  /** 注入时刻的墙钟（毫秒） */
  readonly injectedAtMs: number
}

export interface EngineResult {
  readonly outcome: 'completed' | 'failed' | 'max_turns' | 'aborted'
  readonly finalText: string
  readonly totalTurns: number
  readonly usage: LLMTokenUsage
  readonly error?: string
  readonly finalMessages: ReadonlyArray<EngineMessage>
  /**
   * 早退工具（`exitsLoop=true` 的工具）被调用时填入工具 name + 原始 input。
   * 未触发早退时为 undefined。
   */
  readonly exitToolCall?: { readonly name: string; readonly input: Record<string, unknown> }
  /**
   * 本次 run 累计的 tool_use 块数（每 turn 处理后递增）。
   * 用于 skipReflection 判定"任务复杂度"——步数不够的简单任务跳过反思。
   * Spec: 2026-06-03-dispatcher-immediate-reply-and-overdue-removal-design.md §7.2.1
   */
  readonly tool_call_count: number
  /**
   * 本次 run 期间 worker 是否主动调过 store_memory 或 set_scene_profile。
   * 用于 skipReflection 判定——worker 已主动记了就不需要反思 LLM 兜底补记。
   */
  readonly wrote_memory_or_scene: boolean
}

// --- Factory Functions ---

export function createUserMessage(content: string | ContentBlock[]): EngineUserMessage {
  return {
    id: randomUUID(),
    role: 'user',
    content,
    timestamp: Date.now(),
  }
}

export function createAssistantMessage(
  content: ContentBlock[],
  stopReason: EngineAssistantMessage['stopReason'],
  usage?: LLMTokenUsage
): EngineAssistantMessage {
  return {
    id: randomUUID(),
    role: 'assistant',
    content,
    stopReason,
    timestamp: Date.now(),
    ...(usage !== undefined ? { usage } : {}),
  }
}

export function createToolResultMessage(
  toolUseId: string,
  content: string,
  isError: boolean,
  images?: ReadonlyArray<{ readonly media_type: string; readonly data: string }>,
): EngineToolResultMessage {
  return {
    id: randomUUID(),
    role: 'user',
    toolResults: [{
      tool_use_id: toolUseId,
      content,
      ...(images !== undefined ? { images } : {}),
      is_error: isError,
    }],
    timestamp: Date.now(),
  }
}

export function createBatchToolResultMessage(
  results: ReadonlyArray<{
    tool_use_id: string
    content: string
    images?: ReadonlyArray<{ readonly media_type: string; readonly data: string }>
    is_error: boolean
  }>
): EngineToolResultMessage {
  return {
    id: randomUUID(),
    role: 'user',
    toolResults: results,
    timestamp: Date.now(),
  }
}
