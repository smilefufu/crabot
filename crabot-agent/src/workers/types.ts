import type { ToolDefinition, LLMAdapter, EngineMessage } from '../engine/index.js'
import type { Resolvable } from '../engine/types.js'

export type WorkerImplId = 'builtin' | 'claude-code' | 'codex'
export type WorkerContractState = 'running' | 'idle' | 'exited'
export type IncarnationEndReason =
  | 'completed' | 'failed' | 'killed' | 'superseded' | 'crashed' | 'pre_migration'

export interface Workspace { readonly root: string }
export interface OutputCursor { readonly offset: number }
export interface TraceCursor { readonly offset: number }

export interface NormalizedTraceEvent {
  readonly ts: string
  readonly kind: 'message' | 'tool_call' | 'tool_result' | 'thinking' | 'lifecycle'
  readonly role?: 'assistant' | 'user' | 'system'
  readonly summary: string
  readonly detail?: unknown
}

export interface CapabilityBundle {
  readonly skills: ReadonlyArray<{ id: string; name: string; skill_dir: string }>
  readonly mcp_servers: ReadonlyArray<Record<string, unknown>>
}

export interface SpawnSpec {
  readonly worker_id: string
  readonly prompt: string
  readonly workspace: Workspace
  readonly goal?: string
  /** builtin 专用注入(外部 CLI adapter 忽略) */
  readonly builtin?: {
    readonly adapter: LLMAdapter
    readonly model: string
    readonly systemPrompt: Resolvable<string>
    readonly tools: Resolvable<ReadonlyArray<ToolDefinition>>
    readonly maxTurnsPerBurst?: number
  }
}

export interface IncarnationHandle {
  readonly worker_id: string
  readonly seq: number
  readonly impl: WorkerImplId
}
export interface IncarnationRef {
  readonly worker_id: string
  readonly seq: number
  /** builtin: session 树 node_id;CLI: 原生 session id */
  readonly session_ref: string
}

export interface DetectResult { installed: boolean; activated: boolean; detail?: string }
export interface AdapterCapabilities {
  readonly fork: boolean; readonly revive: boolean; readonly goalMode: boolean
  readonly subagent: boolean; readonly structuredTrace: boolean
}

export interface WorkerAdapter {
  readonly implId: WorkerImplId
  detect(): Promise<DetectResult>
  provision(ws: Workspace, caps: CapabilityBundle): Promise<void>
  spawn(spec: SpawnSpec): Promise<IncarnationHandle>
  resume(prev: IncarnationRef, wakeInput: string): Promise<IncarnationHandle>
  fork(prev: IncarnationRef, forkInput: string): Promise<IncarnationHandle>
  sendInput(h: IncarnationHandle, text: string, opts?: { raw?: boolean }): Promise<void>
  readOutput(h: IncarnationHandle, cursor: OutputCursor): Promise<{ chunk: string; nextCursor: OutputCursor }>
  state(h: IncarnationHandle): Promise<WorkerContractState>
  readTrace?(h: IncarnationHandle, cursor?: TraceCursor): Promise<NormalizedTraceEvent[]>
  kill(h: IncarnationHandle): Promise<void>
  capabilities(): AdapterCapabilities
}
