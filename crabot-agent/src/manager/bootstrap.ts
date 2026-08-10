/**
 * manager 栈装配 —— protocol-agent-v3.md §4/§5/§6/§7(P5 Task 1)。
 *
 * P4 之前,`LedgerStore` / `WorkspaceManager` / `WorkerHarness` / 三个 `WorkerAdapter` /
 * `ManagerRegistry` 只在测试里被完整装配过(`tests/manager/manager-integration.test.ts` 的
 * 私有 `setupAssembly`,以及 `tests/workers/harness/*` 里五份重复的 `makeHarness`)——生产
 * 侧没有任何装配入口。本文件是第一个:把那套只存在于测试里的接线固化成生产代码,
 * `unified-agent.ts`(P5 Task 6)持有它,其余调用方一律经 `ManagerStack` 取件,不再各自 new。
 *
 * ## 两条硬边界
 *
 * 1. **`buildManagerStack` 无 I/O 副作用**:只 new 对象、只接回调。不调 `adapter.detect()`
 *    (会起 `claude --version` / `codex --version` / `tmux -V` 子进程)、不调
 *    `ledger.init()`(会 `mkdir -p` 并扫整个台账目录)、不碰 workspace。理由:它在 agent
 *    启动路径上被调用,而 P5 阶段这套栈**没有任何生产调用方**——装配本身的现网影响必须
 *    近似为零。需要探测/对账时由调用方显式调下面的 `reconcileManagerStack`。
 * 2. **`harness.ts` 文件头的四步接线契约**:空 Map → `new WorkerHarness({adapters})` →
 *    构造三个 adapter 时传 `onStateChange: harness.handleStateChange` → `adapters.set(...)`
 *    回**同一个** Map。顺序写错(比如先构造 adapter 再构造 harness、或 set 进另一个 Map)
 *    的后果是静默的:adapter 的状态变化到不了 harness,台账永远停在旧状态。
 *
 * ## 与 registry 的环形依赖
 *
 * `HarnessDeps.onEvent` 要把 harness 事件路由给 manager(`registry.routeWorkerEvent`),而
 * `ManagerRegistryDeps.harness` 又要求 harness 先存在。用一个 `let` 闭包变量打破环:harness
 * 构造时 registry 还是 undefined,但 `onEvent` 只在真有事件发生时才读它,那时 registry 早已
 * 赋值。这与四步接线契约里"Map 引用先给、内容后填"是同一种解法。
 *
 * @see crabot-docs/protocols/protocol-agent-v3.md §4、§5、§6、§7
 * @see crabot-agent/src/workers/harness/harness.ts 文件头"onStateChange 接线契约"
 */

import { join, resolve } from 'path'

import { WorkerHarness, type HarnessDeps, type ReconcileReport } from '../workers/harness/harness'
import { LedgerStore } from '../workers/harness/ledger-store'
import { WorkspaceManager } from '../workers/harness/workspace-manager'
import type { ManagerKey } from '../workers/harness/ledger-types'
import { BuiltinWorkerAdapter } from '../workers/builtin/adapter.js'
import { ClaudeCodeAdapter } from '../workers/claude-code/adapter.js'
import { CodexWorkerAdapter } from '../workers/codex/adapter.js'
import type { WorkerAdapter, WorkerImplId, CapabilityBundle, WorkerCapabilityContext } from '../workers/types.js'
import type { BuiltinRuntimeFactory } from '../workers/builtin/runtime.js'

import { ManagerRegistry, SYSTEM_TASKS_MANAGER_KEY } from './registry.js'
import { ManagerSessionStore } from './session-store.js'
import { makeTaskStatusEventBridge, type AgentEventPublisher } from './events.js'
import { shouldWakeOnHarnessEvent } from './inbound-adapters.js'
import { buildManagerToolFace } from './tools/tool-face.js'
import {
  ManagerPrincipalStore,
  applyGroupScopeFallback,
  splitManagerKey,
  type HumanPrincipal,
  type PrincipalResolverDeps,
  type ResolvedPrincipal,
} from './principal.js'
import type { CompactionPolicy } from './compaction.js'
import type { ManagerEpisodeFailure } from './types.js'

// 与 `unified-agent.ts` 同款引用路径:这两个常量没有从 `engine/index.ts` 转出,直接引子模块
// (engine 本阶段零改动,不为此新增 barrel 导出)。
import { ContextManager, DEFAULT_COMPACT_THRESHOLD } from '../engine/context-manager.js'
import { DEFAULT_MAX_CONTEXT_TOKENS } from '../engine/query-loop.js'
import type { LLMAdapter } from '../engine/index.js'
import type { CrabMessagingDeps } from '../mcp/crab-messaging.js'
import type { MemoryTaskContext } from '../mcp/crab-memory.js'
import type { McpServer } from '../mcp/mcp-helpers.js'

/**
 * 全局缺省 worker 实现(§6.4"实现选择":人类显式指定 > manager 按偏好选择 > 全局默认)。
 * 取 builtin:它是唯一不依赖外部 CLI 安装/登录态的实现,`detect()` 恒 true,不会因为开发机
 * 没装 claude/codex 就让 `spawn_worker` 在缺省路径上直接失败。
 */
const DEFAULT_WORKER_IMPL: WorkerImplId = 'builtin'

/**
 * manager 会话压缩参数(§4.2"参数经 extra 配置"——尚无配置入口,这里给一份可用缺省)。
 * - `keepRecent`:唤醒边界之外保留的原始消息条数,取 20(manager 的一轮 episode 常有
 *   数条工具调用往返,留太少会把同一件事的上下文折断);
 * - `cacheTtlMs`:prompt 缓存热判定窗口,取 5 分钟——与 provider 侧 prompt cache 的常见
 *   TTL 一致,超过它再压缩不会浪费一次已经失效的缓存前缀;
 * - `foldTokenThreshold`:唤醒边界折叠的历史 token 门槛;
 * - `hardCapTokens`:热态强压兜底,直接复用 engine 自己的比例常量
 *   `DEFAULT_COMPACT_THRESHOLD` × 默认上下文窗口,不另定一个数。
 */
export const DEFAULT_MANAGER_COMPACTION_POLICY: CompactionPolicy = {
  keepRecent: 20,
  cacheTtlMs: 5 * 60_000,
  foldTokenThreshold: 20_000,
  hardCapTokens: Math.floor(DEFAULT_MAX_CONTEXT_TOKENS * DEFAULT_COMPACT_THRESHOLD),
}

export interface ManagerStack {
  readonly ledger: LedgerStore
  readonly harness: WorkerHarness
  readonly registry: ManagerRegistry
  readonly adapters: Map<WorkerImplId, WorkerAdapter>
  /**
   * 人类消息发起人身份的解析缓存(P7 J)。服务于三个**同步** thunk:记忆档位、台账归档键、
   * 对话对象档案(见 `principal.ts` 文件头)。
   *
   * **不是 worker 权限的取数入口**(PR #59 review):缓存是"该会话最近一次解析",worker 的
   * 权限档位是身份属性——由本 episode 的唤醒事件带来、在 spawn 那一刻随 worker 固定并落盘
   * (`SpawnWorkerParams.principal_permissions` → `context.json`)。
   */
  readonly principals: ManagerPrincipalStore
  /**
   * builtin adapter 的私有 dataDir。`reconcileManagerStack` 需要它跑
   * `BuiltinWorkerAdapter.scanOrphans`——见该函数注释里的顺序契约。放在 stack 上而不是
   * 让调用方自己推,是为了让"路径怎么派生"这件事只有 `buildManagerStack` 一处真相。
   */
  readonly builtinDataDir: string
}

export interface BootstrapDeps {
  /** 存储根(= `getDataRootDir()`,即 `$DATA_DIR`);台账/事件流/manager 会话都按 §7 派生自它。 */
  readonly dataRoot: string
  /** ISO 时间注入(harness 用);registry 需要的 `() => Date` 由本模块从它派生,保持单一时间源。 */
  readonly now: () => string
  /**
   * 实例时区(人类消息渲染的 `ts` 属性,见 `ManagerLoopDeps.timezone`)。thunk:admin 改了
   * `agent_config.timezone` 不必重建整个栈。不注入则退回 `resolveTimezone(undefined)`。
   */
  readonly timezone?: () => string
  /** manager 的 LLM 来源(model_config.manager ?? powerful),thunk 以支持热更 */
  readonly managerAdapter: () => LLMAdapter
  readonly managerModel: () => string
  readonly messagingDeps: CrabMessagingDeps
  /**
   * crab-memory server **工厂**(P7 J:原本是一个建好的 `McpServer` 定值)。
   *
   * 改成工厂的理由是语义而非形式:记忆的 visibility / scopes 随**发起人身份**变
   * (§4.3),定值意味着全实例共用一档。现网那一档是 `{visibility:'public', scopes:[]}`
   * ——群 A 的对话会以 public 落进记忆、群 B 的 manager 读得到,是跨会话信息泄漏。
   * 工具面本来就每轮 turn 重建(`ToolFaceDeps` 全是 thunk),这里跟着现建即可。
   */
  readonly memoryServerFor: (ctx: MemoryTaskContext) => McpServer
  readonly callAdmin: <P, R>(m: string, p: P) => Promise<R>
  /**
   * 发起人身份的解析原料(admin 权限解析 / session memory_scopes / 场景画像 /
   * crab self handle / master friend id)。本模块据它在**唤醒边界**解析一次并缓存,
   * 让 `managerKeyFor` / `toolFace` / `promptInputs` 这三个同步 thunk 只读缓存
   * ——签名一个都不用改成异步(见 `principal.ts` 文件头)。
   */
  readonly principalResolver: PrincipalResolverDeps
  /**
   * builtin worker 的运行配置工厂(spawn 缺省注入 / handoff 目标为 builtin 时的注入)。
   * 同一个工厂同时喂给 `HarnessDeps.builtinSpawnDefaults`(spawn/handoff 起化身)与
   * `BuiltinWorkerAdapter.resolveRuntime`(resume/fork/续 burst 起化身)——两条路都要
   * "起化身时现取",不能各持一份(spec 决策 2)。
   */
  readonly builtinSpawnDefaults?: BuiltinRuntimeFactory
  /** 当前 worker capability；调用方必须按 harness 给出的固定权限快照过滤。 */
  readonly capabilityBundle?: (ctx: WorkerCapabilityContext) => Promise<CapabilityBundle>
  /** Shared bg registry ownership check for builtin end_turn state mapping. */
  readonly hasRunningBg?: (workerId: string) => Promise<boolean>
  /**
   * 对外事件发布口(§9.2 `agent.task_status_changed`),由 `makeAgentEventPublisher` 构造。
   * 可选:P5 阶段这套栈没有生产调用方,注入真实 rpcClient 是 P5 Task 6 的事;不注入则本栈
   * 只维护台账、不对外发事件。
   */
  readonly publishEvent?: AgentEventPublisher
  /**
   * fail-loud 兜底出口:worker 事件唤醒的 manager episode 失败时,直接告诉人类一声。
   * 接线范式与上面的 `publishEvent` 完全一致(可选;不注入则这条路保持"只记日志"的既有行为)。
   *
   * 为什么要有:`onEvent` 是 fire-and-forget,原本只 `.catch(console.error)`,且**从不看
   * outcome**——最常见的失败(F1:LLM 挂 / key 过期 / 限流耗尽,不抛错、只把 `outcome` 写成
   * `failed`)因此完全静默。人类那一侧的表现是"worker 干完了/挂了,但再也没人来汇报"。
   *
   * 实现落在 `unified-agent.ts`(`sendBackgroundFailLoud`):出站要 `rpcClient` + channel 端口,
   * 而那是 agent 的东西,不是 manager 栈的。这里只交出口子。
   */
  readonly reportEpisodeFailure?: EpisodeFailureReporter
}

/**
 * `BootstrapDeps.reportEpisodeFailure` 的形状。
 *
 * - `target`:告诉谁。由本模块从台账解出(见 `onEvent` 处的注释),已是 `{channel_id, session_id}`;
 * - `subject`:哪件事没跑成,直接做兜底文案的主语;
 * - `failure`:失败形态(判据双管,见 `ManagerEpisodeFailure`)。
 *
 * **返回 void 且实现方绝不能抛**:调用点在游离 promise 的收尾里,抛出去就是 unhandledRejection。
 */
export type EpisodeFailureReporter = (report: {
  readonly target: { readonly channel_id: string; readonly session_id: string }
  readonly subject: string
  readonly failure: ManagerEpisodeFailure
}) => void

/** `ManagerKey` → `{channel_id, session_id}`。按**第一个** `::` 切,session_id 里再含 `::` 也不会被截断。 */
function channelSessionFromManagerKey(key: ManagerKey): { channel_id: string; session_id: string } {
  const { channelId, sessionId } = splitManagerKey(key)
  return { channel_id: channelId, session_id: sessionId }
}

/**
 * 解析出来的身份档位 → crab-memory 的 `MemoryTaskContext`。
 *
 * 与 worker 侧 `agent-handler.ts:1261-1274` 的同名映射逐字段对齐(同一份语义,别处已经
 * 落地过一遍,这里不另发明):`visibility`/`scopes` 取写入档位、`isMasterPrivate` 决定
 * `scene_profile` 工具要不要暴露 scene 参数。
 *
 * **身份未解析时退回现网那一档**(`public` / 空 scopes / `system`)——这是 manager 在
 * 没有人类会话身份时的既有行为(系统线程、纯 worker 事件唤醒),不做静默收紧。
 */
function memoryContextFor(key: ManagerKey, resolved: ResolvedPrincipal | undefined): MemoryTaskContext {
  const { channelId, sessionId } = splitManagerKey(key)
  if (!resolved) {
    return { channelId, sessionId, visibility: 'public', scopes: [], sourceType: 'system', isMasterPrivate: false }
  }
  const { principal, memory } = resolved
  return {
    channelId,
    sessionId,
    visibility: memory.write_visibility,
    scopes: [...memory.write_scopes],
    sourceType: 'conversation',
    sessionType: principal.sessionType,
    ...(principal.friend ? { senderFriendId: principal.friend.id } : {}),
    isMasterPrivate: principal.friend?.permission === 'master' && principal.sessionType === 'private',
  }
}

/**
 * worker workspace 根。与 `core/data-paths.ts` 的 `getWorkspacesRootDir()` 语义一致
 * (`WORKER_WORKSPACES_DIR` 覆盖 > `<dataRoot>/workspaces`),但根从注入的 `dataRoot` 派生
 * 而不是从进程 env 推导——bootstrap 的所有路径都必须可被调用方/测试完全决定。
 */
function resolveWorkspacesRoot(dataRoot: string): string {
  return process.env.WORKER_WORKSPACES_DIR ? resolve(process.env.WORKER_WORKSPACES_DIR) : join(dataRoot, 'workspaces')
}

/**
 * 只构造对象与接线,不做探测/不扫盘/不建目录;可安全在启动路径调用(见文件头"两条硬边界")。
 */
export function buildManagerStack(deps: BootstrapDeps): ManagerStack {
  const agentDir = join(deps.dataRoot, 'agent')
  // 三个 adapter 各自的私有 dataDir(存 meta-<seq>.json / 运行时目录 / session 树),与 §7 的
  // `agent/workers/<worker_id>/`(harness 亲历事件流与输出)是两个互不相干的目录。
  const adapterDataDir = (impl: WorkerImplId): string => join(agentDir, 'worker-adapters', impl)
  const builtinDataDir = adapterDataDir('builtin')

  const ledger = new LedgerStore(join(agentDir, 'worker-ledgers'))
  const workspaces = new WorkspaceManager(resolveWorkspacesRoot(deps.dataRoot))

  // 见文件头"与 registry 的环形依赖"。
  let registry: ManagerRegistry | undefined

  // harness 事件 → 对外的 `agent.task_status_changed`(§9.2)。翻译与去重都在 events.ts 里,
  // 这里只负责把口子接上。
  const publishTaskStatusChanged = deps.publishEvent
    ? makeTaskStatusEventBridge({ ledger, publish: deps.publishEvent })
    : undefined

  /**
   * worker 事件唤醒的 episode 失败 → `deps.reportEpisodeFailure`(fail-loud)。
   *
   * 目标会话取**该 worker 的监护 manager**(`origin.manager_key`),台账查不到则落系统
   * 线程——与 `routeWorkerEvent` 自己的路由判据逐字相同,所以"哪个 manager 挂了"和"告诉谁"
   * 永远是同一个会话。不用 `report_to`:那是 worker **结果**的回报目标,可以与监护 session 不同
   * (同一 friend 跨 channel 共享台账),拿它当告警目标会把话说到另一个对话里去。
   *
   * **绝不抛**:调用点在游离 promise 的 `.then`/`.catch` 收尾里,从这里抛出去就是
   * unhandledRejection → 打死 agent 进程。台账读失败(findWorker)也只记日志。
   */
  const reportWorkerEventFailure = async (workerId: string, failure: ManagerEpisodeFailure): Promise<void> => {
    if (!deps.reportEpisodeFailure) return
    try {
      const found = await ledger.findWorker(workerId)
      const target = channelSessionFromManagerKey(
        found?.worker.manager_key ?? SYSTEM_TASKS_MANAGER_KEY,
      )
      const title = found?.worker.task.title
      deps.reportEpisodeFailure({
        target,
        subject: `worker「${title ?? workerId}」的状态更新`,
        failure,
      })
    } catch (err) {
      console.error(`[manager-bootstrap] fail-loud 上报失败 (worker=${workerId}):`, err)
    }
  }

  // --- 四步接线契约 step 1:先建空壳 Map ---
  const adapters = new Map<WorkerImplId, WorkerAdapter>()

  const harnessDeps: HarnessDeps = {
    adapters,
    defaultImpl: DEFAULT_WORKER_IMPL,
    ledger,
    workspaces,
    workersDir: join(agentDir, 'workers'),
    now: deps.now,
    // harness 事件 → 该 worker 的监护 manager(§4.4)。过滤复用 P4 的
    // `shouldWakeOnHarnessEvent`(input_sent 不唤醒:manager 发起 send_to_worker 时已在同一次
    // 工具调用里同步拿到结果)。
    //
    // **这个函数上交汇着两件事,都必须在,顺序是"先上报、后返回"**:
    // 1. **副作用**:episode 失败时经 `reportEpisodeFailure` 告诉人类一声(fail-loud,
    //    判据双管见下方注释)——否则"worker 干完了但再也没人来汇报"完全静默;
    // 2. **返回值**:把"这次唤醒有没有被 manager 消费"如实交回 harness,活性巡检据此决定
    //    要不要在下一轮重报(见 `WorkerHarness.sweepLiveness` 的去重与重报规则)。
    // 两者不是一回事,也不互斥:episode 失败时人类收到招呼,巡检同时拿到"未消费"。
    //
    // **返回的 Promise 永不 reject**:路由失败绝不能反噬 harness 的状态机推进,更不能变成
    // unhandledRejection 打崩 agent 进程——绝大多数调用点根本不 await 它(见
    // `HarnessDeps.onEvent`)。失败落成 `consumed: false`,与"episode 没消费这批事件"同义:
    // 活性巡检据此在下一轮重报,这正是"manager 不可用时通知挂起、恢复后仍能收到"。
    // (`reportWorkerEventFailure` 自己保证不抛,见其注释。)
    onEvent: (event) => {
      // 对外事件走在唤醒过滤之前,且不共用下面那个门:`shouldWakeOnHarnessEvent` 答的是"要不
      // 要唤醒 manager"(input_sent 不唤醒),`!registry` 答的是"manager 侧接线好了没"——两者
      // 都与"task 状态有没有变"无关,拿它们当对外事件的门,等于把 §9.2 的正确性挂在别的模块
      // 的过滤规则上。对外事件自己的去重按 task.status 做,在 events.ts 里。
      publishTaskStatusChanged?.(event)

      if (!registry || !shouldWakeOnHarnessEvent(event)) return { consumed: false }
      return registry.routeWorkerEvent(event).then(
        async (result) => {
          // fail-loud 的判据必须双管:`.catch` 只抓得到 F2(中途抛错),而最常见的 F1(LLM 挂 /
          // key 过期 / 限流耗尽)是**正常 resolve 且 outcome='failed'**——只 catch 等于对它全瞎。
          if (result?.outcome === 'failed' || result?.outcome === 'aborted') {
            console.error(
              `[manager-bootstrap] routeWorkerEvent episode outcome=${result.outcome} (worker=${event.worker_id}, kind=${event.kind})`,
            )
            await reportWorkerEventFailure(event.worker_id, { kind: 'outcome', outcome: result.outcome })
          }
          // 上报在先、返回在后:episode 失败时两件事都要发生——人类得到一声招呼(上面),
          // 巡检拿到"未消费"因而下一轮还能重报(这里)。`ManagerLoop` 只在
          // outcome ∈ {completed, max_turns} 时置 consumedEvents,所以失败分支这一句必然
          // 返回 false,两条语义天然对齐,不需要在这里另判一次。
          return { consumed: result?.consumedEvents === true }
        },
        async (err) => {
          console.error(`[manager-bootstrap] routeWorkerEvent 失败 (worker=${event.worker_id}, kind=${event.kind}):`, err)
          await reportWorkerEventFailure(event.worker_id, { kind: 'threw', error: err })
          return { consumed: false }
        },
      )
    },
    builtinSpawnDefaults: deps.builtinSpawnDefaults,
    capabilityBundle: deps.capabilityBundle,
    hasRunningBg: deps.hasRunningBg,
  }

  // --- step 2:把空壳 Map 交给 harness ---
  const harness = new WorkerHarness(harnessDeps)

  // --- step 3 + 4:构造三个 adapter 时传 harness.handleStateChange,再 set 回同一个 Map ---
  adapters.set(
    'builtin',
    new BuiltinWorkerAdapter({
      dataDir: builtinDataDir,
      onStateChange: harness.handleStateChange,
      resolveRuntime: deps.builtinSpawnDefaults,
    }),
  )
  adapters.set(
    'claude-code',
    new ClaudeCodeAdapter({ dataDir: adapterDataDir('claude-code'), onStateChange: harness.handleStateChange }),
  )
  adapters.set(
    'codex',
    new CodexWorkerAdapter({ dataDir: adapterDataDir('codex'), onStateChange: harness.handleStateChange }),
  )

  // token 估算复用 engine 既有的 `ContextManager.estimateTotalTokens`(chars/4 + 每条消息
  // 固定开销 + 图片按固定 token 折算),与 `unified-agent.ts` 里同款用法一致——不另写一版
  // 估算器,避免"重造版本漏掉原版有的条件"。
  const tokenEstimator = new ContextManager({ maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS })

  // 发起人身份:唤醒边界异步解析一次,三个同步 thunk 读缓存(见 principal.ts 文件头)。
  const principals = new ManagerPrincipalStore(deps.principalResolver)

  registry = new ManagerRegistry({
    store: new ManagerSessionStore(join(agentDir, 'managers')),
    policy: DEFAULT_MANAGER_COMPACTION_POLICY,
    estimateTokens: (msgs) => tokenEstimator.estimateTotalTokens(msgs),
    harness,
    ledger,
    adapter: deps.managerAdapter,
    model: deps.managerModel,
    now: () => new Date(deps.now()),
    timezone: deps.timezone,
    managerKeyFor: (key) => key,
    // 人类消息唤醒边界:这是人类消息链路上**唯一**一次异步解析。返回本批发言者算好的档位,
    // 由 registry 挂到本 episode 的唤醒事件上——缓存只服务于同步 thunk(记忆档位 /
    // 对话对象档案),派活用的档位走事件,不走缓存(PR #59 review)。
    onHumanWake: async (key, principal) => (await principals.resolve(key, principal)).permissions,
    // scheduled 唤醒边界(§4.4"权限按 `Schedule.creator_friend_id` 解析,`is_builtin` 按 master
    // 等价"):按**调度自己的身份**解析,不碰该会话的发起人缓存(既不读也不写)。
    //
    // - `is_builtin` 或 creator 为空 → master 等价。这里返回 null 而不是去解析一份 master 档位:
    //   worker 的固定档位(`BUILTIN_WORKER_PERMISSIONS`)本就是 master 等价情形下的上限,
    //   `narrowWorkerPermissions(base, null)` 原样返回它,与 admin 侧"空 creator → master_private"
    //   的既有规则同解。
    // - 有 creator → 按该 friend 解析。`sessionType` 取该会话上一次解析出来的私/群(未知按
    //   'private'):这一项只影响 admin 侧要不要并上 group_default,猜错只会更严,不会更宽。
    onScheduleWake: async ({ key, creatorFriendId, isBuiltin }) => {
      if (isBuiltin || !creatorFriendId) return null
      const { sessionId } = splitManagerKey(key)
      const sessionType = principals.get(key)?.principal.sessionType ?? 'private'
      // 群聊防跨群泄漏的收敛与人类消息那条路共用同一个规则(空 scopes → 本会话)。
      return applyGroupScopeFallback(
        await deps.principalResolver.resolvePermissions({ senderFriendId: creatorFriendId, sessionId, sessionType }),
        sessionType,
        sessionId,
      )
    },
    toolFace: (key, isSystemThread, onAsyncError, scheduleIdentity, humanPrincipal, principalPermissions) =>
      buildManagerToolFace({
        harness,
        workerContext: () => ({
          managerKey: key,
          reportTo: channelSessionFromManagerKey(key),
          // 权限身份(§4.4"权限按 Schedule.creator_friend_id 解析(is_builtin 按 master
          // 等价)"):内置 schedule 不以任何 friend 的名义执行,显式留空——空 creator 正是
          // admin 侧既有的 master 等价规则(protocol-admin §"is_builtin=true 或
          // creator_friend_id 为空 → master_private"),所以这里丢弃而不是改写成某个 id。
          //
          // P7 J:人类消息唤醒时改记**本批消息的发言者**(§8.2)。取 `humanPrincipal`
          // (随本 episode 的唤醒事件而来)而不是缓存里的"最近一次"——worker 事件唤醒的
          // episode 里没有人在说话,拿上一次的发言者冒充会把 worker 记到错的人名下。
          creatorFriendId: scheduleIdentity
            ? (scheduleIdentity.isBuiltin ? undefined : scheduleIdentity.creatorFriendId)
            : humanPrincipal?.friend?.id,
          // 上面那个身份**算好的档位**,随 spawn 下传给 worker 并落盘(§8.2)。与
          // `creatorFriendId` 同源同刻:两者都来自本 episode 的唤醒事件,不来自会话级缓存。
          //
          // 没有身份的唤醒(worker 事件 / 自唤醒)落到 `principals.get(key)`:那类 episode 里
          // 没人说话,但它仍发生在这个会话里,记忆可见范围是**会话属性**(与下面 memoryServer
          // 同一条理由)。这里退回会话级档位,而不是让 worker 拿到空 scopes 把群里的内容以
          // public 落进记忆。取数只发生在派活这一刻,取到之后就随 worker 固定下来。
          principalPermissions:
            principalPermissions ?? (scheduleIdentity ? undefined : principals.get(key)?.permissions ?? undefined),
          // scheduled 触发(不论有无目标 session)记 'scheduled';系统线程的其余唤醒
          // (查不到监护 session 的 worker 事件)记 'system';人类消息记 'message'。
          triggerType: scheduleIdentity ? 'scheduled' : isSystemThread ? 'system' : 'message',
        }),
        messagingDeps: deps.messagingDeps,
        // 记忆档位按**这个会话最近一次解析出来的发起人身份**现建。这里刻意不用
        // `humanPrincipal`:worker 事件唤醒的 episode 里没人说话,但该会话的记忆可见范围
        // 并不因此改变——它是会话属性,不是本轮属性。
        memoryServer: deps.memoryServerFor(memoryContextFor(key, principals.get(key))),
        callAdmin: deps.callAdmin,
        isSystemThread,
        // 这一行是本文件存在的理由之一:registry 按 key 绑定好的 onAsyncError 必须一路传到
        // `buildWorkerTools`,否则 codex worker 上 `query_worker`(fork 能力恒 false)的失败
        // 只会 console.error,manager 永远等不到回音(P4 Task 8 留给本 task 的验证点)。
        onAsyncError,
      }),
    // system prompt 的「对话对象档案」段(§4.2 5b/5d):场景画像 + crab 在该渠道的
    // @handle,由唤醒边界解析好放在缓存里(见 principal.ts `renderDialogProfile`)。
    // 「待处理通知」仍无解析入口,继续留空——prompt.ts 对缺省有处理。
    promptInputs: (key) => {
      const dialogProfile = principals.get(key)?.dialogProfile
      return dialogProfile ? { dialogProfile } : {}
    },
  })

  return { ledger, harness, registry, adapters, principals, builtinDataDir }
}

/**
 * 显式的启动对账入口(§12),与构造分离——由调用方决定何时调(建议:启动后异步跑一次,
 * 失败仅 warn)。
 *
 * 两步顺序不可换,理由见 `harness.reconcileOnStartup` 的方法注释:`scanOrphans` 修的是
 * builtin adapter 自己 dataDir 下 meta 文件那份"进程内存活状态"私有真相(进程重启后
 * state==='running' 的 meta 必是孤儿),必须先把它改写成 exited(crashed);否则
 * `reconcileOnStartup` 调 `builtin.state()` 时会读到过期的 'running',把已经不存在的化身
 * 误判进 revived 桶。
 */
export async function reconcileManagerStack(stack: ManagerStack): Promise<ReconcileReport> {
  await BuiltinWorkerAdapter.scanOrphans(stack.builtinDataDir)
  return stack.harness.reconcileOnStartup()
}
