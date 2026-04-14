import type { LLMAdapter } from '../engine/llm-adapter'

// --- Hook Events ---

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'Stop'

// --- Hook Definition ---

export interface HookDefinition {
  /** Which event this hook listens to */
  readonly event: HookEvent
  /** Regex pattern to match tool names (e.g. "Write|Edit"). null = match all. Only for PreToolUse/PostToolUse. */
  readonly matcher?: string
  /** Condition expression for file extension filtering (e.g. "Write(*.ts)"). Only for PreToolUse/PostToolUse. */
  readonly if?: string
  /** Hook execution type */
  readonly type: 'command' | 'prompt'
  /** Shell command to execute, or __internal:<handler-name> for built-in handlers. Required for type='command'. */
  readonly command?: string
  /** Timeout in seconds. Default: 30 */
  readonly timeout?: number
  /** LLM prompt template. $INPUT is replaced with JSON input. Required for type='prompt'. */
  readonly prompt?: string
  /** Model to use for prompt hooks. Default: agent's fast slot. */
  readonly model?: string
}

// --- Hook Input (context passed to hooks) ---

export interface HookInput {
  readonly event: HookEvent
  readonly toolName?: string
  readonly toolInput?: Record<string, unknown>
  readonly toolOutput?: string
  readonly workingDirectory?: string
  readonly filePaths?: string[]
}

// --- Hook Result ---

export interface HookResult {
  readonly action: 'continue' | 'block'
  readonly message?: string
  readonly modifiedInput?: Record<string, unknown>
}

// --- Internal Handler ---

export type InternalHandler = (input: HookInput, context: InternalHandlerContext) => Promise<HookResult>

export interface InternalHandlerContext {
  readonly workingDirectory: string
  readonly lspManager?: LspManagerLike
}

/** Minimal interface for LSP manager dependency (avoids circular imports) */
export interface LspManagerLike {
  notifyFileChanged(filePath: string, content: string): void
  getDiagnostics(filePath: string): Promise<ReadonlyArray<FormattedDiagnostic>>
  isLanguageAvailable(lang: string): boolean
}

export interface FormattedDiagnostic {
  readonly filePath: string
  readonly line: number
  readonly column: number
  readonly severity: 'error' | 'warning' | 'info'
  readonly message: string
  readonly source: string
}

// --- Hook Executor Context ---

export interface HookExecutorContext {
  readonly adapter?: LLMAdapter
  readonly model?: string
  readonly workingDirectory: string
  readonly lspManager?: LspManagerLike
}
