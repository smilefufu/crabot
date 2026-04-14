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

export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock

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

export type ToolCategory = 'memory' | 'messaging' | 'task' | 'mcp_skill' | 'file_io' | 'browser' | 'shell' | 'remote_exec'

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
  | { readonly type: 'message_start'; readonly messageId: string }
  | { readonly type: 'message_end'; readonly stopReason: string | null; readonly usage?: { readonly inputTokens: number; readonly outputTokens: number } }
  | { readonly type: 'error'; readonly error: string }

// --- Engine Options & Result ---

export interface EngineTurnEvent {
  readonly turnNumber: number
  readonly assistantText: string
  readonly toolCalls: ReadonlyArray<{ readonly id: string; readonly name: string; readonly input: Record<string, unknown>; readonly output: string; readonly isError: boolean }>
  readonly stopReason: EngineAssistantMessage['stopReason']
  /** Total wall-clock time spent executing tools this turn (ms) */
  readonly toolExecutionMs?: number
}

export interface EngineOptions {
  readonly systemPrompt: string
  readonly tools: ReadonlyArray<ToolDefinition>
  readonly model: string
  readonly maxTurns?: number
  readonly maxTokens?: number
  readonly abortSignal?: AbortSignal
  readonly onTurn?: (event: EngineTurnEvent) => void
  readonly onTextDelta?: (text: string) => void
  readonly permissionConfig?: ToolPermissionConfig
  readonly supportsVision?: boolean
  readonly humanMessageQueue?: HumanMessageQueueLike
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
