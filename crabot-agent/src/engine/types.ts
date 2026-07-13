import { randomUUID } from 'crypto'

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
      /** LLM 调用 mid-stream / pre-stream / complete 路径 retry 触发；用于 admin web 显示"正在重试"状态 */
      readonly type: 'llm_retry'
      readonly turn: number          // 当前正在尝试的 turn 编号
      readonly attempt: number       // 第几次失败 (1-indexed)
      readonly maxAttempts: number   // 总配额
      readonly source: 'pre-stream' | 'mid-stream'
      readonly error: string         // 触发 retry 的 error message（截断 200）
    }

/**
 * endTurnGate 的决策结果（见 EngineOptions.endTurnGate 注释）。
 * spec: 2026-06-10-audit-anchor-human-request-design.md §4.7
 */
export type EndTurnGateResult =
  | string
  | { readonly kind: 'wait' }
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
  readonly hookRegistry?: import('../hooks/hook-registry').HookRegistry
  readonly lspManager?: import('../hooks/types').LspManagerLike
  /** IANA 时区名（如 "Asia/Shanghai"），用于 tool_result 时间戳渲染 */
  readonly timezone?: string
  /** 当前消息发起人是否 master——CLI permission gate hook 的 master 短路依据 */
  readonly senderIsMaster?: boolean
  /** 发起人 effective permissions（friend ∪ session 并集）——CLI permission gate hook 用 */
  readonly resolvedPermissions?: import('../types.js').ResolvedPermissions
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
   * 引擎层主动向 loop 注入 user message 时触发（trace 可见性钩子）。
   *
   * 当前 4 类注入：
   * - `supplement` —— humanMessageQueue 实时纠偏注入
   * - `forced_summary` —— silent end_turn 兜底要求模型重说
   * - `stop_hook` —— Stop hook block 后注入的引导文本
   * - `audit_pending_intercept` —— audit 跑中 LLM 直接 end_turn 兜底拦截（Task 13）
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
   * - 返回 { kind: 'wait' } → audit 已异步派出；engine 直接挂起等 humanQueue push
   *   （audit 结果 / 用户 supplement），不注入文本、不烧 LLM 轮次。
   *   spec 2026-06-10-audit-anchor-human-request §4.7
   * - 返回 { kind: 'fail' } → gate 判定无法安全收口，engine 以 failed 结束
   * - 返回 null → 正常退出
   * 不传时直接退出。
   */
  readonly endTurnGate?: () => Promise<EndTurnGateResult>
  /**
   * Goal mode 缓冲消息 flush 钩子。Engine 在以下时机调：
   * - stop_reason='tool_use' 续 turn 之前（agent 还在干活，上一轮缓冲的 info 是"过程信息"）
   * - endTurnGate 返回 null 后 buildResult 之前（audit pass / 无 audit / 同步路径完成）
   * - drain 路径识别到 audit_result.pass=true 时（异步 audit pass 路径）
   * 实现：caller 遍历 taskState.outboundBuffer 调 channel.sendMessage，清空 buffer。
   * 非 goal mode / 空 buffer 场景为 no-op；不传时 engine 跳过 flush。
   * 返回 { sentCount, failures }：sentCount=真正送达条数（engine 据此清除 pending-delivery 追踪），
   * failures=失败明细（engine 据此注入给 worker、收尾时不静默标完成）。
   * spec: 2026-06-07-goal-audit-async-buffered-info-design.md Task 8 / §4.5
   */
  readonly flushOutboundBuffer?: () => Promise<{
    readonly sentCount: number
    readonly failures: ReadonlyArray<{ readonly summary: string; readonly error: string }>
  }>
  /**
   * 丢弃 outboundBuffer 中尚未发出的消息。drain 路径识别到 audit_result.pass=false
   * 或 audit_aborted marker 时调——audit 不通过 / 被废，缓冲的"完工汇报"不应该再发。
   * 实现通常是 `taskState.outboundBuffer.length = 0`。
   * 不传时 engine 跳过丢弃（caller 自己处理 buffer 生命周期）。
   * spec: 2026-06-07-goal-audit-async-buffered-info-design.md §4.5 / §4.7
   */
  readonly dropOutboundBuffer?: () => void
  /**
   * 清 taskState.activeAuditId。drain 路径处理完 audit_result / audit_aborted marker 之后调，
   * 让 task 回到 "无活跃 audit" 态——后续 wait_for_signal 调用不再因 hasActiveAudit 而通过预检。
   * 不传时 engine 跳过（caller 自己管 activeAuditId 生命周期）。
   * spec: 2026-06-07-goal-audit-async-buffered-info-design.md §4.5 / §4.7
   */
  readonly clearActiveAuditId?: () => void
  /**
   * 检查当前是否有 active audit subagent 在跑（Task 13 兜底用）。
   * 用于 audit 跑中 LLM 直接 end_turn 兜底拦截路径：drain 处理完 marker 后，若仍有活跃 audit
   * + LLM 想 end_turn，engine 注入"你不能直接 end_turn" 拦截续 loop（最多 3 次后 abort）。
   * 不传时 engine 跳过兜底拦截（caller 自己负责 audit 生命周期）。
   * spec: 2026-06-07-goal-audit-async-buffered-info-design.md §4.6
   */
  readonly hasActiveAudit?: () => boolean
  /**
   * abort active audit。Task 13 兜底拦截耗尽 3 次后调，强制把当前 audit 标废 + 推 audit_aborted
   * marker 让 worker 看到提示后正常 end_turn。
   * 注：set_task_goal 改 goal 触发的 abort 走 agent-handler 内 abortAudit closure 直接调，不走此回调。
   * 不传时 engine 跳过 abort（兜底拦截耗尽仍会 fall through 让 end_turn 通过）。
   * spec: 2026-06-07-goal-audit-async-buffered-info-design.md §4.6 / §4.7
   */
  readonly abortActiveAudit?: (reason: string) => void
  /**
   * 上下文压缩开始时触发（trace 可见性钩子）。
   * compaction 内部跑一次 LLM call 做摘要，可能耗时几秒——不接 trace 就是黑洞。
   */
  readonly onCompactionStart?: () => void
  /**
   * 上下文压缩完成时触发。`info` 含压缩前后消息数与耗时。
   */
  readonly onCompactionEnd?: (info: { readonly beforeCount: number; readonly afterCount: number; readonly durationMs: number }) => void
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
}

export interface HumanMessageQueueLike {
  readonly drainPending: () => Array<string | ContentBlock[]>
  readonly hasPending: boolean
  readonly hasBarrier: boolean
  /** endTurnGate 'wait' 路径用：engine 自行布防 barrier 再 waitBarrier（spec 2026-06-10 §4.7） */
  readonly setBarrier: (timeoutMs: number) => void
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
   * - `forced_summary`：silent end_turn 兜底要求模型重说
   * - `stop_hook`：Stop hook block 后注入的引导文本
   * - `audit_pending_intercept`：audit 跑中 LLM 直接 end_turn 兜底拦截（Task 13）
   * - `assistant_text_end_turn`：非空 assistant text + end_turn 走错通道纠偏提醒
   */
  readonly type: 'supplement' | 'forced_summary' | 'stop_hook' | 'audit_pending_intercept' | 'assistant_text_end_turn'
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
