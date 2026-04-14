export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'Stop'

export interface HookDefinition {
  readonly event: HookEvent
  readonly matcher?: string
  readonly if?: string
  readonly type: 'command' | 'prompt'
  readonly command?: string
  readonly prompt?: string
  readonly timeout?: number
}

export interface HookInput {
  readonly event: HookEvent
  readonly toolName?: string
  readonly filePaths?: ReadonlyArray<string>
  readonly toolInput?: Record<string, unknown>
  readonly workingDirectory?: string
}

export interface HookResult {
  readonly action: 'continue' | 'block'
  readonly message?: string
  readonly modifiedInput?: Record<string, unknown>
}

export interface FormattedDiagnostic {
  readonly filePath: string
  readonly line: number
  readonly column: number
  readonly severity: 'error' | 'warning' | 'info' | 'hint'
  readonly message: string
  readonly source: string
}

export interface LspManagerLike {
  notifyFileChanged(filePath: string, content: string): void
  getDiagnostics(filePath: string): Promise<ReadonlyArray<FormattedDiagnostic>>
}

export interface InternalHandlerContext {
  readonly workingDirectory: string
  readonly lspManager?: LspManagerLike
}

export type InternalHandler = (
  input: HookInput,
  context: InternalHandlerContext,
) => Promise<HookResult>
