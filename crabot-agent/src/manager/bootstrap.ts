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
import type { DialogObjectId } from '../workers/harness/ledger-types'
import { BuiltinWorkerAdapter } from '../workers/builtin/adapter.js'
import { ClaudeCodeAdapter } from '../workers/claude-code/adapter.js'
import { CodexWorkerAdapter } from '../workers/codex/adapter.js'
import type { SpawnSpec, WorkerAdapter, WorkerImplId } from '../workers/types.js'

import { ManagerRegistry } from './registry.js'
import { ManagerSessionStore } from './session-store.js'
import { makeTaskStatusEventBridge, type AgentEventPublisher } from './events.js'
import { shouldWakeOnHarnessEvent } from './inbound-adapters.js'
import { buildManagerToolFace } from './tools/tool-face.js'
import type { CompactionPolicy } from './compaction.js'
import type { ManagerKey } from './types.js'

// 与 `unified-agent.ts` 同款引用路径:这两个常量没有从 `engine/index.ts` 转出,直接引子模块
// (engine 本阶段零改动,不为此新增 barrel 导出)。
import { ContextManager, DEFAULT_COMPACT_THRESHOLD } from '../engine/context-manager.js'
import { DEFAULT_MAX_CONTEXT_TOKENS } from '../engine/query-loop.js'
import type { LLMAdapter } from '../engine/index.js'
import type { CrabMessagingDeps } from '../mcp/crab-messaging.js'
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
  /** manager 的 LLM 来源(model_config.manager ?? powerful),thunk 以支持热更 */
  readonly managerAdapter: () => LLMAdapter
  readonly managerModel: () => string
  readonly messagingDeps: CrabMessagingDeps
  readonly memoryServer: McpServer
  readonly callAdmin: <P, R>(m: string, p: P) => Promise<R>
  /**
   * `ManagerKey`(channel::session)→ 台账聚合键 `DialogObjectId`。必须由调用方注入:
   * 私聊要解析成 `friend:<friend_id>`(跨 channel 聚合),这一步依赖 admin 的 friend 解析,
   * 本模块拿不到,而 `ManagerRegistryDeps.dialogObjectIdFor` 又是同步签名,不能在这里现查。
   */
  readonly dialogObjectIdFor: (key: ManagerKey) => DialogObjectId
  /** handoff 目标为 builtin 时的 LLM 注入缺省值,原样透传给 `HarnessDeps.builtinSpawnDefaults`。 */
  readonly builtinSpawnDefaults?: () => SpawnSpec['builtin']
  /**
   * 对外事件发布口(§9.2 `agent.task_status_changed`),由 `makeAgentEventPublisher` 构造。
   * 可选:P5 阶段这套栈没有生产调用方,注入真实 rpcClient 是 P5 Task 6 的事;不注入则本栈
   * 只维护台账、不对外发事件。
   */
  readonly publishEvent?: AgentEventPublisher
}

/** `ManagerKey` → `{channel_id, session_id}`。按**第一个** `::` 切,session_id 里再含 `::` 也不会被截断。 */
function channelSessionFromManagerKey(key: ManagerKey): { channel_id: string; session_id: string } {
  const sep = key.indexOf('::')
  return sep < 0
    ? { channel_id: key, session_id: '' }
    : { channel_id: key.slice(0, sep), session_id: key.slice(sep + 2) }
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

  const ledger = new LedgerStore(join(agentDir, 'ledgers'))
  const workspaces = new WorkspaceManager(resolveWorkspacesRoot(deps.dataRoot))

  // 见文件头"与 registry 的环形依赖"。
  let registry: ManagerRegistry | undefined

  // harness 事件 → 对外的 `agent.task_status_changed`(§9.2)。翻译与去重都在 events.ts 里,
  // 这里只负责把口子接上。
  const publishTaskStatusChanged = deps.publishEvent
    ? makeTaskStatusEventBridge({ ledger, publish: deps.publishEvent })
    : undefined

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
    // 工具调用里同步拿到结果)。fire-and-forget,必须 .catch():路由失败绝不能反噬 harness 的
    // 状态机推进,更不能变成 unhandledRejection 打崩 agent 进程。
    onEvent: (event) => {
      // 对外事件走在唤醒过滤之前,且不共用下面那个门:`shouldWakeOnHarnessEvent` 答的是"要不
      // 要唤醒 manager"(input_sent 不唤醒),`!registry` 答的是"manager 侧接线好了没"——两者
      // 都与"task 状态有没有变"无关,拿它们当对外事件的门,等于把 §9.2 的正确性挂在别的模块
      // 的过滤规则上。对外事件自己的去重按 task.status 做,在 events.ts 里。
      publishTaskStatusChanged?.(event)

      if (!registry || !shouldWakeOnHarnessEvent(event)) return
      void registry.routeWorkerEvent(event).catch((err) => {
        console.error(`[manager-bootstrap] routeWorkerEvent 失败 (worker=${event.worker_id}, kind=${event.kind}):`, err)
      })
    },
    builtinSpawnDefaults: deps.builtinSpawnDefaults,
  }

  // --- step 2:把空壳 Map 交给 harness ---
  const harness = new WorkerHarness(harnessDeps)

  // --- step 3 + 4:构造三个 adapter 时传 harness.handleStateChange,再 set 回同一个 Map ---
  adapters.set(
    'builtin',
    new BuiltinWorkerAdapter({ dataDir: builtinDataDir, onStateChange: harness.handleStateChange }),
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

  registry = new ManagerRegistry({
    store: new ManagerSessionStore(join(agentDir, 'managers')),
    policy: DEFAULT_MANAGER_COMPACTION_POLICY,
    estimateTokens: (msgs) => tokenEstimator.estimateTotalTokens(msgs),
    harness,
    ledger,
    adapter: deps.managerAdapter,
    model: deps.managerModel,
    now: () => new Date(deps.now()),
    dialogObjectIdFor: deps.dialogObjectIdFor,
    toolFace: (key, isSystemThread, onAsyncError) =>
      buildManagerToolFace({
        harness,
        workerContext: () => ({
          dialogObjectId: deps.dialogObjectIdFor(key),
          managerKey: key,
          reportTo: channelSessionFromManagerKey(key),
          // 系统线程(未指定目标 session 的 scheduled 触发 / 查不到监护 session 的 worker
          // 事件)派出去的 worker 记 'system';其余按人类消息触发记 'message'。
          // 'scheduled'(有目标 session 的定时触发)由 P5 Task 4 的 trigger_schedule 路径
          // 补,那时才有"本次唤醒是不是 schedule"这个信息。
          triggerType: isSystemThread ? 'system' : 'message',
        }),
        messagingDeps: deps.messagingDeps,
        memoryServer: deps.memoryServer,
        callAdmin: deps.callAdmin,
        isSystemThread,
        // 这一行是本文件存在的理由之一:registry 按 key 绑定好的 onAsyncError 必须一路传到
        // `buildWorkerTools`,否则 codex worker 上 `query_worker`(fork 能力恒 false)的失败
        // 只会 console.error,manager 永远等不到回音(P4 Task 8 留给本 task 的验证点)。
        onAsyncError,
      }),
    // system prompt 的动态段素材(对话对象档案 / 待处理通知)目前没有解析入口,给空对象;
    // prompt.ts 对两者缺省都有处理,不会因此少渲染任何必需段落。
    promptInputs: () => ({}),
  })

  return { ledger, harness, registry, adapters, builtinDataDir }
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
