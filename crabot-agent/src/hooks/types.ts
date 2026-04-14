export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'Stop'

export interface HookDefinition {
  readonly event: HookEvent
  readonly matcher?: string
  readonly if?: string
  readonly type: 'command' | 'prompt'
  readonly command?: string
  readonly prompt?: string
}

export interface HookInput {
  readonly event: HookEvent
  readonly toolName?: string
  readonly filePaths?: ReadonlyArray<string>
}

export interface HookResult {
  readonly hookDef: HookDefinition
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}
