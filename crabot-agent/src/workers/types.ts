import type { ToolDefinition, LLMAdapter } from '../engine/index.js'
import type { Resolvable } from '../engine/types.js'
// 纯类型引用(两侧都是 `import type`,编译后无运行时依赖,不构成模块环)。
import type { LedgerWorker } from './harness/ledger-types.js'
import type { ResolvedPermissions } from '../types.js'

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
  /**
   * 台账 origin(派发来源与权限身份)。builtin adapter 把它与 workspace/goal 一起持久化,
   * 起后续化身(resume/fork)时回喂给运行配置工厂——包括进程重启之后。外部 CLI adapter 忽略。
   */
  readonly origin?: LedgerWorker['origin']
  /**
   * spawn 那一刻 manager 按 `origin.creator_friend_id` 算好的发起人权限档位(§8.2)。
   * builtin adapter 与 workspace/goal/origin 一起持久化,后续所有化身(resume/fork/续 burst,
   * 含进程重启之后)都读回同一份——权限是身份属性,不随会话里后来谁说话而变
   * (见 `BuiltinRuntimeContext.principal_permissions`)。外部 CLI adapter 忽略。
   */
  readonly principal_permissions?: ResolvedPermissions
  /** builtin 专用注入(外部 CLI adapter 忽略) */
  readonly builtin?: {
    readonly adapter: LLMAdapter
    readonly model: string
    readonly systemPrompt: Resolvable<string>
    readonly tools: Resolvable<ReadonlyArray<ToolDefinition>>
    readonly maxTurnsPerBurst?: number
    /** 以下四项随 model 一起由注入工厂解析——adapter 自己无从知道模型能力/上限。 */
    readonly maxTokens?: number
    readonly contextWindowTokens?: number
    readonly supportsVision?: boolean
    /** IANA 时区名,用于 tool_result 时间戳渲染 */
    readonly timezone?: string
  }
}

export interface IncarnationHandle {
  readonly worker_id: string
  readonly seq: number
  readonly impl: WorkerImplId
  /** 本化身自己的会话引用,创建时(spawn/resume/fork 返回前)即由 adapter 填入真值——
   * builtin: 本化身当前 tip node_id;CLI: 原生 session id(resume 沿用 prev 不变;fork 化身
   * 填 fork 自己的引用,不是父化身的)。handle 自描述,调用方无需事后反查(protocol-agent-v3 §6.1)。 */
  readonly session_ref: string
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
  readTrace?(h: IncarnationHandle, cursor?: TraceCursor): Promise<{ events: NormalizedTraceEvent[]; nextCursor: TraceCursor }>
  kill(h: IncarnationHandle): Promise<void>
  capabilities(): AdapterCapabilities
}
