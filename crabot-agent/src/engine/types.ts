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
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number }
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
  | { readonly type: 'message_end'; readonly stopReason: string | null; readonly usage?: { readonly inputTokens: number; readonly outputTokens: number } }
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
}

/** 既可传静态值也可传 callback（每轮 resolve） */
export type Resolvable<T> = T | (() => T)

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
      readonly source: 'pre-stream' | 'mid-stream' | 'complete'
      readonly error: string         // 触发 retry 的 error message（截断 200）
    }

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
  /**
   * 在 context-manager compaction 完成后回调，返回最终注入到 messages 的数组。
   * 用于在 compaction 边界注入 per-task 状态（如 worker 的 todo active list），
   * 注入到 user msg 而非 system prompt 以保护 prompt cache。
   * 不传时不做任何处理。
   */
  readonly onAfterCompaction?: (messages: ReadonlyArray<EngineMessage>) => ReadonlyArray<EngineMessage>
}

export interface HumanMessageQueueLike {
  readonly drainPending: () => Array<string | ContentBlock[]>
  readonly hasPending: boolean
  readonly hasBarrier: boolean
  readonly waitBarrier: (signal?: AbortSignal) => Promise<void>
  readonly clearBarrier: () => void
}

export interface EngineResult {
  readonly outcome: 'completed' | 'failed' | 'max_turns' | 'aborted'
  readonly finalText: string
  readonly totalTurns: number
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number }
  readonly error?: string
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
  usage?: { inputTokens: number; outputTokens: number }
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
