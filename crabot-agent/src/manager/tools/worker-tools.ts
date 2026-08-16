/**
 * worker 工具集 —— manager 唯一的 worker 编排入口(protocol-agent-v3 §4.1/§4.3/§5.5)。
 *
 * 七个工具全部是 `WorkerHarness`(P3 已合并,本模块只调用、不修改,唯一的 additive 例外见
 * `harness.readWorkerOutput` 的 `opts.seq` 参数)既有方法的薄封装:只负责
 * 1) 组装 harness 方法的入参(`spawn_worker` 据 `deps.context()` 填 `origin`/`report_to`);
 * 2) 把 harness 的返回值/异常转成 engine `ToolCallResult`——除 `query_worker`(见下)外,
 *    异常永不穿透成 engine 层错误,统一转成 `isError: true` 的可读文本,manager 能读到失败
 *    原因并自行决策(如 worker 不存在就换个 id 或重新 spawn,protocol-agent-v3 §4.3)。
 *
 * ---
 *
 * ## 同步性语义的实现取舍(protocol §4.1"等待 = end_turn")
 *
 * 协议表(§4.3)把 `spawn_worker`/`send_to_worker`/`query_worker` 标"异步",
 * `read_worker_output`/`list_workers`/`kill_worker` 标"同步"。`spawn_worker`/`send_to_worker`
 * 与 `read_worker_output`/`list_workers`/`kill_worker` 这五个工具都完整 `await` 对应的
 * harness 方法——`spawnWorker` 顺序 await workspace 解析、台账初始写入、`adapter.provision`、
 * `adapter.spawn`;`sendToWorker` 顺序 await 入信箱与 `inbox.flush`(经 `adapter.sendInput`,
 * 命中终态化身时还会走一整套 kill+provision+spawn 的透明接续)——这些都是"编排动作完整
 * 落地"才 resolve 的有限时长调用,不会进一步阻塞等待 worker 自己执行任务、产出真正的回复
 * (那部分永远经由 harness 的 `onEvent`/`onStateChange` 异步发生),完整 await 并不违反
 * "manager 的 loop 内不存在阻塞等待原语"这条约束。这五个工具若不 await,会丢失两样东西:
 * 1. `spawn_worker` 依赖 harness 内部生成的 `worker_id` 供 LLM 后续引用——不 await 就拿不到;
 * 2. `WorkerNotFoundError`/`TaskCancelledError`/`ImplAlreadyUsedError` 一类的失败原因就没有
 *    办法在这次调用内回传给 LLM,违反"manager 应能读到失败原因并自行决策"这条要求。
 *
 * `query_worker` 是唯一的例外,采用字面意义的 JS fire-and-forget(调用 `harness.queryWorker`
 * 后不 `await`、立即返回,游离 promise 用 `.catch()` 兜住)。原因:`harness.queryWorker` 顺序
 * await `adapter.fork`,而 `claude-code/adapter.ts` 的 `fork()` 实现是
 * `await execFileAsync('/bin/sh', ['-c', shellCommand], ...)`——等的是整个无头 `claude -p`
 * 子进程跑完(一次完整 LLM 调用,几十秒到数分钟),不是"发起"这一有限时长的编排动作。完整
 * await 会把 manager 的这一整个 turn 阻塞住,违反 protocol-agent-v3 §4.1/§4.3"慢工具异步
 * 发起即返回,结果作为事件唤醒"。代价:`forkSeq` 拿不到(它在 `adapter.fork` 落地之后才由
 * harness 生成),`WorkerNotFoundError`/`CapabilityNotSupportedError` 等失败原因也不再能在
 * 这次调用内回传给 LLM,只记诊断日志——不打破"manager 应能读到失败原因"这条要求的字面表述
 * 的场景是:manager 观察不到进展(既无 fork 化身出现,也没有对应事件)时,应主动用
 * `list_workers` 核实,不是假定这条要求覆盖 `query_worker` 这一条异步发起路径(controller
 * 决定,理由见上,记录于 task-4-report.md 追加内容)。
 *
 * 三个"异步"工具的输出因此刻意写得简短(确认式:status + 关键标识符,`query_worker` 甚至
 * 只有 status + worker_id),提示 LLM 后续进展会由事件唤醒。
 *
 * 若未来 harness 提供了"仅等 fork 发起、不等 `claude -p` 子进程落地"的拆分入口,`query_worker`
 * 应优先切换回完整 await 的实现,与其余五个工具的语义保持一致。
 *
 * ## isReadOnly
 *
 * 与 `read_worker_output`/`list_workers`/`get_worker_detail` 标 `isReadOnly: true`(供 engine 并行调度只读工具,
 * `partitionToolCalls`)。`kill_worker` 虽然同步返回,但会改变 worker/task 状态,不是只读。
 *
 * @see crabot-docs/protocols/protocol-agent-v3.md §4.1、§4.3、§5.5
 */

import { defineTool } from '../../engine/index.js'
import type { ToolDefinition, ToolCallResult } from '../../engine/index.js'
import type { WorkerHarness } from '../../workers/harness/harness'
import type { ManagerKey, LedgerWorker, TaskStatus } from '../../workers/harness/ledger-types'
import type { MasterAuthorization } from '../principal.js'
import type { WorkerImplId } from '../../workers/types'
import type { ResolvedPermissions } from '../../types'
import type { LegacyContinuationAuth } from '../../workers/harness/legacy-continuation-auth.js'

export interface WorkerToolsContext {
  /** Current manager session: worker owner and list_workers scope. */
  readonly managerKey: ManagerKey
  /** 当前 episode 的 trace id(可跳转);填入 `origin.spawned_by_episode`。 */
  readonly episodeId?: string
  /**
   * spawn 成功回调(P6-A §6.6):把 worker ID 追加进当前 episode trace 的 spawned_worker_ids。
   * 与 `origin.spawned_by_episode` 同一 episode ID,两处必须一致。
   */
  readonly onWorkerSpawned?: (workerId: string) => void
  /** 权限身份:以谁的名义派发这个 worker;填入 `origin.creator_friend_id`。 */
  readonly creatorFriendId?: string
  /**
   * 上面那个身份**算好的权限档位**(§8.2"manager 算好结果随 spawn 下传"),填入
   * `SpawnWorkerParams.principal_permissions`。
   *
   * 与 `creatorFriendId` 严格同源、同一时刻取:worker 拿到的是这一份**快照**,spawn 之后
   * 不再变(见 `BuiltinRuntimeContext.principal_permissions`)。缺省 = 无发起人档位,worker
   * 退回自己的固定档位。
   */
  readonly principalPermissions?: ResolvedPermissions
  /** 结果回报目标,默认 = 当前 session(protocol-agent-v3 §3)。 */
  readonly reportTo: { channel_id: string; session_id: string }
  /** Opaque credential factory; only legacy terminal continuation consumes its result. */
  readonly legacyContinuationAuth?: (managerKey: ManagerKey) => LegacyContinuationAuth | undefined
  /**
   * 本次唤醒的触发来源,填入 `origin.trigger_type`;缺省 'message'。给 scheduled 路由
   * (Task 8)/system 场景预留——本任务只加这个可选出口,不在这里做路由判断。
   */
  readonly triggerType?: LedgerWorker['origin']['trigger_type']
}

export interface WorkerToolsDeps {
  readonly harness: WorkerHarness
  /** P6-C §7：registry snapshot 只读 getter（list_worker_implementations 用）。 */
  readonly workerImplSnapshot?: () => {
    revision: number
    default_impl: string
    preference: Record<string, string>
    statuses: Array<{
      impl: string
      enabled: boolean
      installed: boolean
      version?: string
      connection_mode?: string
      capabilities?: unknown
      verification: string
      verification_stale?: boolean
      degraded?: string
      ready: boolean
      detail?: string
    }>
    observed_at: string
  }
  /** 当前 manager 的归属:决定 spawn 的 managerKey / origin / report_to。 */
  readonly context: () => WorkerToolsContext
  /** Opaque authorization is captured by the control plane, never exposed in a tool schema/history. */
  readonly authorization?: () => MasterAuthorization | undefined
  readonly validateMasterAuthorization?: (auth: MasterAuthorization) => Promise<boolean>
  /**
   * P4 Task 4 additive 扩展点:`query_worker` 的游离 promise reject 时,除了
   * `console.error` 诊断日志外还调用这个可选回调。本任务只提供出口、不接线——`harness.
   * queryWorker` 本身已经把同一失败 appendEvent('query_failed')(见 harness.ts 注释),
   * 这里的 `onAsyncError` 面向的是"当前这个 manager 实例要不要因为这次失败立刻醒来"这层
   * 决策,不是失败留痕本身。Task 7/8 的契约:接上后用它"把这条错误接成唤醒本 manager 的
   * 信号"(如推一条系统消息触发下一轮 loop),不在这里预判具体唤醒机制。缺省不传时行为
   * 与之前完全一致(仅 console.error)。
   */
  readonly onAsyncError?: (info: { tool: string; worker_id: string; error: string }) => void
}

// --- tool_result 构造辅助 ---

function ok(data: unknown): ToolCallResult {
  return { output: JSON.stringify(data), isError: false }
}

function invalid(message: string): ToolCallResult {
  return { output: message, isError: true }
}

/**
 * 把 harness 抛出的异常(`WorkerNotFoundError`/`TaskCancelledError`/`ImplAlreadyUsedError`
 * 及其它未预期异常)转成对 LLM 友好的 `tool_result` 文本——异常永不穿透成 engine 层错误。
 * 三种已知错误类本身的 message 已经足够可读(见 harness.ts 的构造函数),不需要按类型
 * 再各写一套文案;这里统一处理即可。同时 `console.error` 留一份诊断痕迹(harness 内部对
 * 自己台账/化身状态变化的失败已经有独立的事件流,这里补的是"这次工具调用本身失败了"这层,
 * 二者互补,不是重复)。
 */
function mapError(prefix: string, error: unknown): ToolCallResult {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[worker-tools] ${prefix} failed:`, error)
  // P6-C：结构化 NOT_READY 的 ready_impls/reasons 必须到 Manager（C-02/C-05 的观测点）。
  const details = (error as { code?: string; details?: { ready_impls?: string[]; reasons?: Record<string, string> } })
  if (details.code === 'WORKER_IMPLEMENTATION_NOT_READY' && details.details) {
    return {
      output: `${prefix} 失败: ${message}\nready_impls: ${JSON.stringify(details.details.ready_impls ?? [])}\nreasons: ${JSON.stringify(details.details.reasons ?? {})}`,
      isError: true,
    }
  }
  return { output: `${prefix} 失败: ${message}`, isError: true }
}

const WORKER_IMPL_IDS: readonly WorkerImplId[] = ['builtin', 'claude-code', 'codex']

function isWorkerImplId(value: unknown): value is WorkerImplId {
  return typeof value === 'string' && (WORKER_IMPL_IDS as readonly string[]).includes(value)
}

function summarizeWorker(worker: LedgerWorker) {
  const mainline = worker.incarnations.filter(inc => inc.forked_from === undefined).at(-1)
  return {
    worker_id: worker.worker_id,
    manager_key: worker.manager_key,
    title: worker.task.title,
    task_status: worker.task.status,
    ...(mainline ? { incarnation_state: mainline.state, impl: mainline.impl } : {}),
    updated_at: worker.updated_at,
  }
}

function sortSummaries<T extends { updated_at: string; worker_id: string }>(items: T[]): T[] {
  return items.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.worker_id.localeCompare(b.worker_id))
}

function normalizePagination(page: unknown, pageSize: unknown): { page: number; page_size: number } {
  const valid = (value: unknown, fallback: number) => typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : fallback
  return { page: valid(page, 1), page_size: Math.min(valid(pageSize, 20), 100) }
}

const ACCESS_DENIED = 'worker 不存在或当前会话无权访问'

export function buildWorkerTools(deps: WorkerToolsDeps): ToolDefinition[] {
  const { harness, context, authorization, validateMasterAuthorization, onAsyncError } = deps
  // Capture exactly once: a tool definition belongs to one model turn. A later
  // regrant must not make an already-issued privileged closure usable again.
  const capturedAuthorization = authorization?.()
  const capturedLegacyContinuationAuth = context().legacyContinuationAuth

  const masterAuthorized = async (): Promise<boolean> => {
    return !!capturedAuthorization && !!validateMasterAuthorization && await validateMasterAuthorization(capturedAuthorization)
  }

  const authorizeWorker = async (workerId: string): Promise<LedgerWorker> => {
    const found = await harness.findWorker(workerId)
    if (!found) throw new Error(ACCESS_DENIED)
    if (found.worker.manager_key === context().managerKey) return found.worker
    if (!await masterAuthorized()) throw new Error(ACCESS_DENIED)
    return found.worker
  }

  // --- spawn_worker(异步:发起即返回,任务进展由事件唤醒) ---
  //
  // 刻意**不收** `goal`:没有任何 worker 实现装配 goal 模式(builtin 的工具集硬禁
  // `set_task_goal`,见 `workers/builtin/runtime.ts` 的 `FORBIDDEN_WORKER_TOOLS`;
  // cc/codex 的 `capabilities().goalMode` 本来就是 false)。再收这个参数只会让 manager
  // 照着工具描述传、以为生效,实际静默落进台账哪儿都到不了。要 worker 目标驱动,就把目标
  // 写进 `prompt`——protocol-agent-v3 §4.3 / §6.4。
  const spawnWorker = defineTool({
    name: 'spawn_worker',
    description:
      '派发一个新的 worker 去执行一项任务。用于真正另起炉灶的新任务——是已有任务的延续/' +
      '补充/返工时改用 send_to_worker 投给原 worker(它会自动复活已结束的会话),新 worker ' +
      '拿不到旧 worker 积累的上下文。异步语义:本工具在 worker 化身创建完成后即返回' +
      '(不等 worker 把任务做完),返回 worker_id;worker 每跑完一轮(转 idle)或结束时会作为' +
      '事件唤醒你,事件里带着它这一轮最后说的那段话。impl 缺省按部署偏好选择;workspace 缺省新建。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '任务标题(简短)' },
        prompt: {
          type: 'string',
          description: '交给 worker 的任务描述/初始输入。要它目标驱动就把目标写在这里',
        },
        impl: { type: 'string', enum: WORKER_IMPL_IDS as unknown as string[], description: 'worker 实现,缺省按部署偏好' },
        workspace: { type: 'string', description: '复用的 workspace 路径,缺省新建一个' },
      },
      required: ['title', 'prompt'],
    },
    isReadOnly: false,
    call: async (input): Promise<ToolCallResult> => {
      const { title, prompt, impl, workspace } = input as {
        title?: string
        prompt?: string
        impl?: string
        workspace?: string
      }
      if (!title || typeof title !== 'string') return invalid('spawn_worker: title 必填且为字符串')
      if (!prompt || typeof prompt !== 'string') return invalid('spawn_worker: prompt 必填且为字符串')
      if (impl !== undefined && !isWorkerImplId(impl)) {
        return invalid(`spawn_worker: impl 取值非法 '${impl}',合法值: ${WORKER_IMPL_IDS.join('/')}`)
      }

      const ctx = context()
      try {
        const worker: LedgerWorker = await harness.spawnWorker({
          managerKey: ctx.managerKey,
          title,
          prompt,
          origin: {
            spawned_by_episode: ctx.episodeId,
            creator_friend_id: ctx.creatorFriendId,
            // 缺省按最常见场景填 'message';scheduled/system 场景由 context() 提供
            // triggerType 覆盖(如 Task 8 的 scheduled 路由)。
            trigger_type: ctx.triggerType ?? 'message',
          },
          report_to: ctx.reportTo,
          // 权限档位随 spawn 下传并落盘(§8.2)——worker 之后所有化身都用这一份,
          // 不再回头查会话级缓存。
          principal_permissions: ctx.principalPermissions,
          impl,
          workspace,
        })
        ctx.onWorkerSpawned?.(worker.worker_id)
        return ok({ status: 'spawned', worker_id: worker.worker_id, impl: worker.incarnations[0]?.impl })
      } catch (error) {
        return mapError('spawn_worker', error)
      }
    },
  })

  // --- send_to_worker(异步:投递即返回,worker 的回应由事件唤醒) ---
  const sendToWorker = defineTool({
    name: 'send_to_worker',
    description:
      '向指定 worker 的信箱投递一条输入,worker 处于什么状态都能投:在跑/空闲的排进信箱,' +
      '已结束(completed/failed)的会自动复活它原来的会话接着干、上下文完整保留——所以延续、' +
      '补充、返工一个老任务都走这里,不必先判断它死活,也不必为此新开 worker。异步语义:本工具' +
      '在投递落地(或复活发起)后即返回,不等 worker 处理完这条消息;worker 每跑完一轮或结束时' +
      '会作为事件唤醒你,事件里带着它这一轮最后说的那段话。命中已 cancelled 的任务会被拒绝。' +
      'raw=true 用于向卡住的交互式界面原样敲键,不是普通对话消息。',
    inputSchema: {
      type: 'object',
      properties: {
        worker_id: { type: 'string', description: '目标 worker id' },
        text: { type: 'string', description: '要投递的文本' },
        raw: { type: 'boolean', description: '原样敲键(驱动卡住的交互界面专用),缺省 false' },
      },
      required: ['worker_id', 'text'],
    },
    isReadOnly: false,
    call: async (input): Promise<ToolCallResult> => {
      const { worker_id, text, raw } = input as { worker_id?: string; text?: string; raw?: boolean }
      if (!worker_id || typeof worker_id !== 'string') return invalid('send_to_worker: worker_id 必填且为字符串')
      if (typeof text !== 'string' || text.length === 0) return invalid('send_to_worker: text 必填且为非空字符串')

      try {
        const worker = await authorizeWorker(worker_id)
        const legacyContinuationAuth = capturedLegacyContinuationAuth?.(worker.manager_key)
        await harness.sendToWorker(worker_id, text, {
          ...(raw !== undefined ? { raw } : {}),
          ...(legacyContinuationAuth ? { legacyContinuationAuth } : {}),
        })
        return ok({ status: 'sent', worker_id })
      } catch (error) {
        return mapError(`send_to_worker(${worker_id})`, error)
      }
    },
  })

  // --- query_worker(字面 fire-and-forget:发起后不 await,立即返回;答案由事件唤醒) ---
  //
  // 与其余五个工具不同的实现取舍:cc worker 的 harness.queryWorker → adapter.fork 会 await
  // 一整个无头 `claude -p` 子进程跑完(一次完整 LLM 调用,几十秒到数分钟)——完整 await 会把
  // manager 的这一整个 turn 阻塞住,违反 protocol-agent-v3 §4.1/§4.3"慢工具异步发起即返回,
  // 结果作为事件唤醒"。因此本工具字面意义地不等 harness.queryWorker 落地:调用后立即返回
  // 简短确认,游离 promise 用 .catch() 兜住(不得产生 unhandledRejection,P1/P3 反复踩过的
  // 坑),失败只记诊断日志——这意味着 WorkerNotFoundError/CapabilityNotSupportedError 等
  // 已知错误不再能在这次调用内回传给 LLM(相对其余五个工具"异常永不穿透,统一转 isError"
  // 这条约定的一处刻意偏离,controller 决定,见 task-4-report.md 追加记录)。forkSeq 同理
  // 拿不到(它在 adapter.fork 落地之后才由 harness 生成),不写进返回文本。
  // P4 Task 4 additive:失败除 console.error 外还调 deps.onAsyncError?.(见 WorkerToolsDeps
  // 注释)——本任务只开这个口子,不接线;harness.queryWorker 自己也会把同一失败
  // appendEvent('query_failed'),二者互补(留痕 vs. 是否要唤醒当前 manager 两层决策)。
  const queryWorker = defineTool({
    name: 'query_worker',
    description:
      '对正在跑的 worker 发起一次侧问(fork 语义),不打扰主线执行。fire-and-forget:本工具' +
      '发起侧问后立即返回,不等侧问化身创建完成,拿不到 fork_seq;答案就绪(或发起失败)只' +
      '会作为事件唤醒你,届时事件会带上该侧问化身的 seq,用 read_worker_output 传入该 seq ' +
      '读取答案。目标实现需支持 fork 能力,不支持时的失败不会体现在这次调用的返回里。',
    inputSchema: {
      type: 'object',
      properties: {
        worker_id: { type: 'string', description: '目标 worker id' },
        question: { type: 'string', description: '侧问的问题内容' },
      },
      required: ['worker_id', 'question'],
    },
    isReadOnly: false,
    call: async (input): Promise<ToolCallResult> => {
      const { worker_id, question } = input as { worker_id?: string; question?: string }
      if (!worker_id || typeof worker_id !== 'string') return invalid('query_worker: worker_id 必填且为字符串')
      if (!question || typeof question !== 'string') return invalid('query_worker: question 必填且为字符串')

      try {
        // Authorization must settle before this fire-and-forget action is started.
        await authorizeWorker(worker_id)
      } catch (error) {
        return mapError(`query_worker(${worker_id})`, error)
      }
      harness.queryWorker(worker_id, question).catch((error) => {
        console.error(`[worker-tools] query_worker(${worker_id}) 后台发起失败(fire-and-forget):`, error)
        onAsyncError?.({ tool: 'query_worker', worker_id, error: error instanceof Error ? error.message : String(error) })
      })
      return ok({ status: 'queried', worker_id })
    },
  })

  // --- read_worker_output(同步:真实增量输出) ---
  const readWorkerOutput = defineTool({
    name: 'read_worker_output',
    description:
      '同步读取 worker 化身的输出(从 offset 读到当前末尾,全文另落盘留路径)。' +
      '**超长时保留的是尾部**——你拿到的永远是最新的那一段,诊断"现在卡在哪"直接读即可,' +
      '不必为了够到最新状态反复续读。首次调用 offset 传 0,之后用上次返回的 next_offset ' +
      '拿增量。缺省读主线化身;读侧问分支(query_worker 触发)的答案时传 seq——事件里会' +
      '给出该侧问化身的 seq。',
    inputSchema: {
      type: 'object',
      properties: {
        worker_id: { type: 'string', description: '目标 worker id' },
        offset: { type: 'number', description: '读取起点(上次返回的 next_offset),缺省 0 = 从头(超长则给尾部)' },
        seq: { type: 'number', description: '读侧问分支的答案时传 query 事件里给出的 seq;缺省读主线化身' },
      },
      required: ['worker_id'],
    },
    isReadOnly: true,
    call: async (input): Promise<ToolCallResult> => {
      const { worker_id, offset, seq } = input as { worker_id?: string; offset?: number; seq?: number }
      if (!worker_id || typeof worker_id !== 'string') return invalid('read_worker_output: worker_id 必填且为字符串')

      try {
        await authorizeWorker(worker_id)
        const { chunk, nextCursor, unavailable_reason } = await harness.readWorkerOutput(
          worker_id,
          { offset: offset ?? 0 },
          seq !== undefined ? { seq } : undefined
        )
        return ok({ worker_id, chunk, next_offset: nextCursor.offset, ...(unavailable_reason ? { unavailable_reason } : {}) })
      } catch (error) {
        return mapError(`read_worker_output(${worker_id})`, error)
      }
    },
  })

  const listWorkers = defineTool({
    name: 'list_workers',
    description: '列出当前会话派出的 worker 精简摘要；需要继续、返工或汇报进度时先查询。',
    inputSchema: { type: 'object', properties: {} },
    isReadOnly: true,
    call: async (): Promise<ToolCallResult> => {
      try {
        return ok({ workers: sortSummaries((await harness.listWorkers(context().managerKey)).map(summarizeWorker)) })
      } catch (error) { return mapError('list_workers', error) }
    },
  })

  const listWorkerImplementations = defineTool({
    name: 'list_worker_implementations',
    description:
      '列出可用的 worker 实现（builtin/claude-code/codex）的当前状态：enabled/ready/' +
      'capabilities/preference/default 与脱敏原因。需要选择实现或回应用户偏好时先查；' +
      'preference 只是给你的自然语言软指导，不是硬规则。',
    inputSchema: { type: 'object', properties: {} },
    isReadOnly: true,
    call: async (): Promise<ToolCallResult> => {
      try {
        if (!deps.workerImplSnapshot) throw new Error('worker implementation registry not available')
        const snapshot = deps.workerImplSnapshot()
        return ok({
          revision: snapshot.revision,
          default_impl: snapshot.default_impl,
          preference: snapshot.preference,
          observed_at: snapshot.observed_at,
          implementations: snapshot.statuses.map((st) => ({
            impl: st.impl,
            enabled: st.enabled,
            ready: st.ready,
            installed: st.installed,
            version: st.version,
            connection_mode: st.connection_mode,
            capabilities: st.capabilities,
            verification: st.verification,
            ...(st.verification_stale ? { verification_stale: true } : {}),
            ...(st.degraded ? { degraded: st.degraded } : {}),
            ...(st.detail ? { detail: st.detail } : {}),
          })),
        })
      } catch (error) { return mapError('list_worker_implementations', error) }
    },
  })

  const getWorkerDetail = defineTool({
    name: 'get_worker_detail',
    description: '读取一个 worker 的完整详情。当前会话只能读取自己的 worker。',
    inputSchema: { type: 'object', properties: { worker_id: { type: 'string' } }, required: ['worker_id'] },
    isReadOnly: true,
    call: async (input): Promise<ToolCallResult> => {
      const workerId = (input as { worker_id?: string }).worker_id
      if (!workerId) return invalid('get_worker_detail: worker_id 必填且为字符串')
      try { return ok({ worker: await authorizeWorker(workerId) }) }
      catch (error) { return mapError(`get_worker_detail(${workerId})`, error) }
    },
  })

  const listAllWorkers = capturedAuthorization ? defineTool({
    name: 'list_all_workers',
    description: '仅 Master 可用：跨会话列出 worker 精简摘要，支持 manager_key/status/分页过滤。',
    inputSchema: {
      type: 'object', properties: {
        manager_key: { type: 'string' }, status: { oneOf: [{ type: 'string', enum: ['queued', 'running', 'waiting_input', 'completed', 'failed', 'cancelled'] }, { type: 'array', items: { type: 'string', enum: ['queued', 'running', 'waiting_input', 'completed', 'failed', 'cancelled'] } }] },
        page: { type: 'number' }, page_size: { type: 'number' },
      },
    },
    isReadOnly: true,
    call: async (input): Promise<ToolCallResult> => {
      try {
        if (!await masterAuthorized()) return invalid(ACCESS_DENIED)
        const p = input as { manager_key?: string; status?: TaskStatus | TaskStatus[]; page?: number; page_size?: number }
        const status = p.status === undefined ? undefined : (Array.isArray(p.status) ? p.status : [p.status])
        const pagination = normalizePagination(p.page, p.page_size)
        const summaries = sortSummaries((await harness.listAllWorkers())
          .filter(({ worker }) => (!p.manager_key || worker.manager_key === p.manager_key) && (!status || status.includes(worker.task.status)))
          .map(({ worker }) => summarizeWorker(worker)))
        const total_items = summaries.length
        const start = (pagination.page - 1) * pagination.page_size
        return ok({ items: summaries.slice(start, start + pagination.page_size), pagination: {
          ...pagination, total_items, total_pages: Math.ceil(total_items / pagination.page_size),
        } })
      } catch (error) { return mapError('list_all_workers', error) }
    },
  }) : undefined

  // --- kill_worker(同步:终止当前化身,幂等) ---
  const killWorker = defineTool({
    name: 'kill_worker',
    description:
      '终止 worker 当前主线化身,task 状态转为 cancelled。对已是终态的 worker 幂等(不重复' +
      '操作、不报错)。reason 可选,会记入事件留痕。',
    inputSchema: {
      type: 'object',
      properties: {
        worker_id: { type: 'string', description: '目标 worker id' },
        reason: { type: 'string', description: '终止原因,可选' },
      },
      required: ['worker_id'],
    },
    isReadOnly: false,
    call: async (input): Promise<ToolCallResult> => {
      const { worker_id, reason } = input as { worker_id?: string; reason?: string }
      if (!worker_id || typeof worker_id !== 'string') return invalid('kill_worker: worker_id 必填且为字符串')

      try {
        await authorizeWorker(worker_id)
        await harness.killWorker(worker_id, reason)
        return ok({ status: 'killed', worker_id })
      } catch (error) {
        return mapError(`kill_worker(${worker_id})`, error)
      }
    },
  })

  return [spawnWorker, sendToWorker, queryWorker, readWorkerOutput, listWorkers, getWorkerDetail, listWorkerImplementations, ...(listAllWorkers ? [listAllWorkers] : []), killWorker]
}
