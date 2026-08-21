import type { ModelFormat } from 'crabot-shared'
import type { ToolDefinition, LLMAdapter } from '../engine/index.js'
import type { Resolvable } from '../engine/types.js'
// 纯类型引用(两侧都是 `import type`,编译后无运行时依赖,不构成模块环)。
import type { LedgerWorker } from './harness/ledger-types.js'
import type { ResolvedPermissions, MCPServerConfig } from '../types.js'

export type WorkerImplId = 'builtin' | 'claude-code' | 'codex'
export type CLIWorkerImplId = Exclude<WorkerImplId, 'builtin'>
export type IncarnationId = string

export interface WorkspaceInstructionSnapshot {
  readonly source: 'agents_md' | 'absent'
  readonly captured_at: string
  readonly digest?: string
  readonly artifact_id?: string
}

/** Harness-private, immutable AGENTS.md capture delivered to an adapter at incarnation launch. */
export interface WorkspaceInstructionPayload {
  readonly snapshot: WorkspaceInstructionSnapshot
  readonly text?: string
}

// ── P6-B：worker implementation connection / activation（protocol-agent-v3 §6.5 逐字段对齐）──

export type WorkerConnectionConfig =
  | { mode: 'native_account' }
  | { mode: 'admin_provider'; provider_id: string; model_id: string }
  | { mode: 'existing_host' }

export interface WorkerConnectionCapability {
  mode: 'native_account' | 'admin_provider' | 'existing_host'
  translator_id: string
  translator_version: string
  cli_version_range: string
  provider_formats?: ModelFormat[]
  endpoint_policy?: 'official_only' | 'custom_base_url'
  credential_transport: 'native_store' | 'process_env' | 'agent_runtime_file'
  model_selection: 'native_default' | 'explicit_model'
  credential_scope: 'managed' | 'runtime_user_home' | 'admin_runtime'
}

export interface WorkerImplementationPolicy {
  enabled: boolean
  preference?: string
  connection?: WorkerConnectionConfig
}

export interface WorkerImplementationConfig {
  revision: number
  default_impl: WorkerImplId
  implementations: Record<WorkerImplId, WorkerImplementationPolicy>
}

/** Admin→Agent runtime shape；connection_revisions 是 nonsecret invalidation signal。 */
export interface WorkerImplementationRuntimeConfig {
  config: WorkerImplementationConfig
  connection_revisions: Partial<Record<CLIWorkerImplId, string>>
}

export type WorkerVerificationState = 'never' | 'running' | 'passed' | 'failed' | 'grandfathered'

export interface WorkerImplementationStatus {
  impl: WorkerImplId
  /** policy 的 enabled（Manager 工具按此区分「policy 关掉」与「没装」）。 */
  enabled: boolean
  installed: boolean
  version?: string
  /** 只解析用户级安装（v1 无 managed）。 */
  install_source?: 'user'
  /** 用户级缺失但检测到全局安装（被忽略；UI 提示「请用用户级安装」）。 */
  global_install_detected?: boolean
  connection_mode?: WorkerConnectionConfig['mode']
  credential_scope?: WorkerConnectionCapability['credential_scope']
  configured: boolean
  policy_revision: number
  connection_revision?: string
  translator?: WorkerConnectionCapability
  verification: WorkerVerificationState
  /** binding 分量与当前不一致（提示用，不阻断）。 */
  verification_stale?: boolean
  /** 运行时真实失败置位（脱敏原因）；存在时阻断派活，成功执行自动清除。 */
  degraded?: string
  ready: boolean
  capabilities: AdapterCapabilities
  connection_capabilities: WorkerConnectionCapability[]
  observed_at: string
  last_verified_at?: string
  /** 必须脱敏；不得包含 endpoint credential、Authorization、assertion、terminal bytes 或本地 secret 路径。 */
  detail?: string
}
export type WorkerContractState = 'running' | 'idle' | 'exited'
export type CliControlState =
  | { readonly kind: 'running' }
  | { readonly kind: 'waiting_text' }
  | { readonly kind: 'waiting_action'; readonly reason: string }
  | { readonly kind: 'exited'; readonly reason?: IncarnationEndReason }
export type InitialInputDisposition = 'accepted' | 'not_pasted' | 'pending_in_ui'
export type IncarnationEndReason =
  | 'completed' | 'failed' | 'killed' | 'superseded' | 'crashed' | 'pre_migration'

export interface Workspace { readonly root: string }
export interface TraceCursor { readonly offset: number }

export interface SupervisionObservation {
  readonly kind: 'text' | 'tool_only' | 'none' | 'unknown'
  readonly next_cursor: { readonly offset: number }
}

/** Shared classification for each adapter's native structured trace reader. */
export function classifySupervisionActivity(
  events: ReadonlyArray<NormalizedTraceEvent>,
  next_cursor: { readonly offset: number },
): SupervisionObservation {
  if (events.some((event) => event.kind === 'message' && event.role === 'assistant' && event.summary.trim())) {
    return { kind: 'text', next_cursor }
  }
  if (events.some((event) => event.kind === 'tool_call' || event.kind === 'tool_result')) {
    return { kind: 'tool_only', next_cursor }
  }
  return { kind: 'none', next_cursor }
}

export interface SendInputOptions {
  readonly raw?: boolean
  readonly delivery_id?: string
  readonly deadline_at?: string
  readonly signal?: AbortSignal
}

/** The only fixed TUI keys an adapter may expose through a UI snapshot. */
export const WORKER_UI_CONTROL_KEYS = [
  'Enter',
  'Escape',
  'Up',
  'Down',
  'Left',
  'Right',
  'Tab',
  'Space',
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
] as const

export type WorkerUiControlKey = (typeof WORKER_UI_CONTROL_KEYS)[number]

/**
 * Adapter-declared actions are persisted with the UI snapshot. A key action is an exact,
 * finite sequence; a text action may only carry ordinary text within its declared limit.
 */
export type WorkerUiActionDescriptor =
  | {
      readonly action_id: string
      readonly kind: 'keys'
      readonly keys: readonly WorkerUiControlKey[]
    }
  | {
      readonly action_id: string
      readonly kind: 'text'
      readonly min_length?: number
      readonly max_length: number
    }

export type WorkerUiResponse =
  | { readonly kind: 'keys'; readonly keys: readonly WorkerUiControlKey[] }
  | { readonly kind: 'text'; readonly text: string }

export interface ForkOptions {
  readonly query_id: string
  /** Allocated by Harness before adapter.fork; direct adapter callers may omit it. */
  readonly incarnation_id?: IncarnationId
  readonly establishment_deadline_at: string
  readonly connection_env?: Record<string, string>
  /** Present only when this adapter needs Harness to inject the AGENTS.md capture at launch. */
  readonly workspace_instructions?: WorkspaceInstructionPayload
}

export interface NormalizedTraceEvent {
  readonly ts: string
  readonly kind: 'message' | 'llm_call' | 'tool_call' | 'tool_result' | 'thinking' | 'lifecycle'
  readonly role?: 'assistant' | 'user' | 'system'
  readonly summary: string
  readonly detail?: unknown
  /**
   * 事件来源（P6-A §8.1）。adapter 归一化时缺省（adapter 只解析本实现 source），
   * composite reader 合并时强制填上——对外（RPC/REST）该字段必有值。
   */
  readonly source?: 'harness' | 'native' | 'legacy'
  /**
   * 本事件在其原生 source 里的行/记录位置（内部字段，不进 REST/RPC response）。
   * 归一化跳过的行也消费行号，composite 钳制与 copy 回退必须按它而不是事件条数。
   */
  readonly source_offset?: number
}

export type WorkerActivityKind = 'assistant_text' | 'tool_call' | 'tool_result'
export type WorkerActivityView = 'assistant' | 'all'
export type WorkerActivityCursor = string

/**
 * A Manager-safe projection of a Worker native session record. Native paths, raw JSON and
 * adapter cursor details remain inside the Harness/adapter boundary.
 */
export interface WorkerActivity {
  readonly activity_id: string
  readonly worker_id: string
  readonly incarnation_id: IncarnationId
  readonly kind: WorkerActivityKind
  readonly occurred_at: string
  readonly summary: string
  readonly text?: string
  readonly detail?: unknown
}

export interface CapabilityBundle {
  readonly skills: ReadonlyArray<{ id: string; name: string; skill_dir: string }>
  readonly mcp_servers: ReadonlyArray<MCPServerConfig>
}

/** Harness 向 capability provider 提供的 worker 身份上下文；权限是 spawn 时固定的快照。 */
export interface WorkerCapabilityContext {
  readonly worker_id: string
  readonly principal_permissions?: ResolvedPermissions
}

export interface SpawnSpec {
  readonly worker_id: string
  /** Harness-owned identity. Direct adapter tests may omit it, production Harness never does. */
  readonly incarnation_id?: IncarnationId
  readonly prompt: string
  readonly workspace: Workspace
  /** Present only when this adapter needs Harness to inject the AGENTS.md capture at launch. */
  readonly workspace_instructions?: WorkspaceInstructionPayload
  /**
   * P6-B §6.5：operation admission 由 translator 注入的最小连接 env（CLI adapter 透传到
   * 进程 env；tmux driver 侧仍会过 scrubChildEnv）。不得由 Manager/调用方直接构造——
   * 只能来自 activation registry admission 的 translator 输出。
   */
  readonly connection_env?: Record<string, string>
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

export interface ResumeOptions {
  readonly connection_env?: Record<string, string>
  readonly incarnation_id?: IncarnationId
  /** Present only when this adapter needs Harness to inject the AGENTS.md capture at launch. */
  readonly workspace_instructions?: WorkspaceInstructionPayload
}

export interface IncarnationHandle {
  readonly worker_id: string
  /** Present for every Harness-created incarnation; legacy adapters may omit it during migration. */
  readonly incarnation_id?: IncarnationId
  readonly seq: number
  readonly impl: WorkerImplId
  /** 本化身自己的会话引用,创建时(spawn/resume/fork 返回前)即由 adapter 填入真值——
   * builtin: 本化身当前 tip node_id;CLI: 原生 session id(resume 沿用 prev 不变;fork 化身
   * 填 fork 自己的引用,不是父化身的)。handle 自描述,调用方无需事后反查(protocol-agent-v3 §6.1)。 */
  readonly session_ref: string
  /** Fork handles carry the stable query operation identity; mainline handles omit it. */
  readonly query_id?: string
  /** CLI spawn/resume 首投的事实；builtin/fork 省略并按既有行为处理。 */
  readonly initial_input?: InitialInputResult
}
export interface IncarnationRef {
  readonly worker_id: string
  readonly incarnation_id?: IncarnationId
  readonly seq: number
  /** builtin: session 树 node_id;CLI: 原生 session id */
  readonly session_ref: string
}

/**
 * adapter 在一次状态转换上**顺带上报**的可选信息(`deps.onStateChange` 的第三个实参)。
 *
 * 字段都是可选的、彼此独立的、按 adapter 能力有则报之的东西,没有先后语义,也没有哪两个
 * 必须成对出现——这是一个**载荷**,不是一串位置参数。收成对象而不是继续往回调后面追加
 * 形参,理由:
 *
 * 1. cc/codex 本就不产 `lastText`,位置参数下它们得写 `(h,'exited',undefined,reason)` 这种
 *    占位调用,每加一个字段就得重数一遍位置;
 * 2. 同类型的可选字段一旦不止一个(都是 `string | undefined`),位置写反了类型检查一个字
 *    都不会说,错法是静默的语义错;
 * 3. 后续再接新信号(比如 cc 拿到真实终态、或带上本轮耗时)是加一个具名字段,所有调用点
 *    不动。
 */
export interface InitialInputResult {
  readonly control_state: CliControlState['kind']
  readonly disposition: InitialInputDisposition
  readonly report?: StateChangeReport
}

export interface StateChangeReport {
  /**
   * 本次转换发生时 worker 最后说的那段 assistant text。只有 builtin 产出(它的输出天然
   * 只含 text);cc/codex 的输出是整屏 TUI,拆不出干净的"最后一段话",不报。
   */
  readonly lastText?: string
  /**
   * 化身的终止原因,只在 `state==='exited'` 时有意义,由 adapter 的 `transitionExited`
   * 原样上报。可信度分级见协议 §6.3:builtin 的是确证(finish_task 结构化上报),
   * cc/codex 的 `completed` 是"会话消失且非本进程 kill"的推断。
   */
  readonly endReason?: IncarnationEndReason
  /**
   * Adapter observed a native turn boundary. This is deliberately distinct from
   * a lifecycle state: an exit caused by a crash or a harness stop is not a
   * worker result that the Manager may mark delivered.
   */
  readonly completionSource?: 'builtin_end_turn' | 'claude_stop' | 'codex_turn_complete'
  /**
   * worker 自己写的收尾结论,来自 builtin 的 `finish_task(summary)`,因此只可能在
   * `state==='exited'` 时出现,且只有那一条终止路径有——crashed/killed/上下文超限
   * 收场时 worker 根本没机会写。cc/codex 没有对应的结构化终态上报,不产。
   *
   * 它与 `lastText` 是**两样东西**,不能相互替代:`lastText` 是 assistant 说的话,一个
   * 全程只调工具、最后用 `finish_task` 收场的 worker(定时反思/早报就是这个形态)从头到
   * 尾一句 text 都没有,`lastText` 与 builtin 的纯文本 artifact 双双为空,`summary` 是它唯一的交付物。
   */
  readonly summary?: string
  /** 当前终端画面或明确不可用原因；只供显式诊断读取，不进入常规 manager 状态事件。 */
  readonly terminal?: WorkerTerminalView
  /** CLI waiting_action / 投递暂扣的诊断原因。 */
  readonly waitReason?: string
  /**
   * An adapter's identity and bounded actions for a currently visible manager-required UI.
   * The terminal itself stays behind explicit `get_worker_terminal` reads.
   */
  readonly ui?: {
    readonly fingerprint: string
    readonly actions: readonly WorkerUiActionDescriptor[]
  }
  /** cc Notification 的解析载荷；harness 映射为 manager-facing detail。 */
  readonly notification?: { readonly type: string; readonly message?: string; readonly title?: string }
}

export type WorkerTerminalView =
  | { kind: 'live_terminal'; text: string; captured_at: string }
  | { kind: 'final_terminal'; text: string; captured_at: string }
  | { kind: 'headless_text'; text: string; captured_at?: string }
  | { kind: 'unavailable'; unavailable_reason: string }

export interface DetectResult {
  installed: boolean
  activated: boolean
  /** 当前检测到的 CLI 版本（translator/version range 匹配输入）。 */
  version?: string
  /** 只解析用户级安装（v1 无 managed）。 */
  install_source?: 'user'
  /** 用户级缺失但检测到全局安装（被忽略）。 */
  global_detected?: boolean
  /**
   * 宿主 credential 的非敏感代际信号（文件 mtime+size 的 HMAC 输入，不读正文）——
   * 宿主换账号/重登会让代际变化，existing_host/native_account binding 随之失效。
   */
  credential_generation?: string
  detail?: string
}
export interface AdapterCapabilities {
  readonly fork: boolean; readonly revive: boolean; readonly goalMode: boolean
  readonly subagent: boolean; readonly structuredTrace: boolean
}

export interface WorkerAdapter {
  readonly implId: WorkerImplId
  detect(): Promise<DetectResult>
  /**
   * 与当前 detect 版本一致的静态 translator 声明（P6-B §6）；
   * detect 与声明不一致时 registry 标 degraded/not ready。
   */
  connectionCapabilities?(): WorkerConnectionCapability[]
  /** 无副作用的 workspace/capability 前置检查；handoff 在触碰源化身前调用。 */
  preflightProvision?(ws: Workspace, caps: CapabilityBundle): Promise<void>
  provision(ws: Workspace, caps: CapabilityBundle): Promise<void>
  spawn(spec: SpawnSpec): Promise<IncarnationHandle>
  resume(prev: IncarnationRef, wakeInput: string, opts?: ResumeOptions): Promise<IncarnationHandle>
  fork(prev: IncarnationRef, forkInput: string, opts: ForkOptions): Promise<IncarnationHandle>
  sendInput(h: IncarnationHandle, text: string, opts?: SendInputOptions): Promise<void>
  readTerminal(h: IncarnationHandle): Promise<WorkerTerminalView>
  state(h: IncarnationHandle): Promise<WorkerContractState>
  /**
   * 该化身**最近一次可观察到的任务/执行进展**时刻(epoch ms);全部来源不可用时返回
   * undefined(protocol-agent-v3 §6.1)。进程存活、终端动画和无条件定时心跳不算进展。
   * 不实现者不参与活性巡检(harness 不做实现特判)。CLI 取 meta 与原生会话记录,
   * builtin 以真实 engine 进展更新、无常驻实例时以 meta 兜底。
   */
  lastActivityAt?(h: IncarnationHandle): Promise<number | undefined>
  inspectSupervisionActivity(
    h: IncarnationHandle,
    cursor?: { readonly offset: number },
  ): Promise<SupervisionObservation>
  readTrace?(h: IncarnationHandle, cursor?: TraceCursor): Promise<{ events: NormalizedTraceEvent[]; nextCursor: TraceCursor }>
  /** Request only the active turn to stop. Completion is verified by Harness control operations. */
  interrupt?(h: IncarnationHandle): Promise<void>
  /** Stop the adapter-owned execution. Completion is verified by Harness control operations. */
  stop?(h: IncarnationHandle): Promise<void>
  /** Reply to an unknown UI after Harness has verified a one-time snapshot. */
  respondToUi?(h: IncarnationHandle, response: WorkerUiResponse): Promise<void>
  /** @deprecated Compatibility primitive. New control requests use stop(). */
  kill(h: IncarnationHandle): Promise<void>
  /** Release adapter-owned runtime resources without terminating independent tmux workers. */
  dispose(): Promise<void>
  capabilities(): AdapterCapabilities
}
