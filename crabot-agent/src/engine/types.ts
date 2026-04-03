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
    readonly is_error: boolean
  }>
  readonly timestamp: number
}

export type EngineMessage = EngineUserMessage | EngineAssistantMessage | EngineToolResultMessage

// --- Tool Definition ---

export interface ToolCallContext {
  readonly abortSignal?: AbortSignal
  readonly onProgress?: (message: string) => void
}

export interface ToolCallResult {
  readonly output: string
  readonly isError: boolean
}

export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly isReadOnly: boolean
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
  readonly toolCalls: ReadonlyArray<{ readonly id: string; readonly name: string; readonly input: Record<string, unknown> }>
  readonly stopReason: EngineAssistantMessage['stopReason']
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
  readonly humanMessageQueue?: {
    readonly dequeue: () => Promise<string | ContentBlock[]>
  }
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
  isError: boolean
): EngineToolResultMessage {
  return {
    id: randomUUID(),
    role: 'user',
    toolResults: [{ tool_use_id: toolUseId, content, is_error: isError }],
    timestamp: Date.now(),
  }
}
