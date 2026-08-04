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
   * worker 自己写的收尾结论,来自 builtin 的 `finish_task(summary)`,因此只可能在
   * `state==='exited'` 时出现,且只有那一条终止路径有——crashed/killed/上下文超限
   * 收场时 worker 根本没机会写。cc/codex 没有对应的结构化终态上报,不产。
   *
   * 它与 `lastText` 是**两样东西**,不能相互替代:`lastText` 是 assistant 说的话,一个
   * 全程只调工具、最后用 `finish_task` 收场的 worker(定时反思/早报就是这个形态)从头到
   * 尾一句 text 都没有,`lastText` 与 `output.log` 双双为空,`summary` 是它唯一的交付物。
   */
  readonly summary?: string
  /**
   * 化身当前 pane 输出的**原始尾部**(含 ANSI 转义序列),只有 CLI 实现在**启动期就绪握手
   * 超时**这一条路径上产出:此时开工输入一个字符都没投递,worker 停在一个我们无法识别的
   * 界面上(典型是模态弹窗),manager 需要现场才能决策——protocol-agent-v3 §5.5「检测到
   * 无法识别的交互界面:暂扣 + 唤醒 manager(附界面内容);manager 可用 `raw` 直接敲键」。
   *
   * 与 `lastText` 是**两样东西**,不能相互替代:`lastText` 是 worker 说的话(只有 builtin
   * 拆得出);这里是屏幕这一刻吐出的字节,没有经过任何归一化,也不代表 worker 表达了什么
   * ——它只是给 manager 判断"卡在哪"的现场素材。
   */
  readonly outputTail?: string
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
