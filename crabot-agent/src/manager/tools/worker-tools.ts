/**
 * worker 工具集 —— manager 唯一的 worker 编排入口(protocol-agent-v3 §4.1/§4.3/§5.5)。
 *
 * worker 编排/观察工具全部是 `WorkerHarness`(P3 已合并,本模块只调用、不修改,唯一的 additive 例外见
 * `harness.getWorkerTerminal` 的 `opts.seq` 参数)既有方法的薄封装:只负责
 * 1) 组装 harness 方法的入参(`spawn_worker` 据 `deps.context()` 填 `origin`/`report_to`);
 * 2) 把 harness 的返回值/异常转成 engine `ToolCallResult`——异常永不穿透成 engine 层错误,
 *    统一转成 `isError: true` 的可读文本,manager 能读到失败
 *    原因并自行决策(如 worker 不存在就换个 id 或重新 spawn,protocol-agent-v3 §4.3)。
 *
 * ---
 *
 * ## 同步性语义的实现取舍(protocol §4.1"等待 = end_turn")
 *
 * `spawn_worker`、`send_to_worker` 和 `query_worker` 都完整 `await` 对应的
 * harness 方法——`spawnWorker` 顺序 await workspace 解析、台账初始写入、`adapter.provision`、
 * `adapter.spawn`;`sendToWorker` 顺序 await 入信箱与 `inbox.flush`(经 `adapter.sendInput`,
 * 命中终态化身时还会走一整套 kill+provision+spawn 的透明接续);`queryWorker` 只 await
 * fork 建立、首问接受与 ledger/receipt 提交，不等待侧问回答生成——这些都是"编排动作完整
 * 落地"才 resolve 的有限时长调用。Worker 执行、输入异步终态与侧问回答终态仍通过事件
 * 唤醒 manager，完整 await 不违反"manager 的 loop 内不存在等待 Worker 执行完成的阻塞原语"
 * 这条约束。若不 await,会丢失两样东西:
 * 1. `spawn_worker` 依赖 harness 内部生成的 `worker_id` 供 LLM 后续引用——不 await 就拿不到;
 * 2. `WorkerNotFoundError`/`TaskCancelledError`/`QueryEstablishmentError` 一类的失败原因就没有
 *    办法在这次调用内回传给 LLM,违反"manager 应能读到失败原因并自行决策"这条要求。
 *
 * ## isReadOnly
 *
 * 与 `get_worker_state`/`get_worker_activity`/`get_worker_turn`/`get_worker_terminal`/`list_workers`/`get_worker_detail` 标 `isReadOnly: true`(供 engine 并行调度只读工具,
 * `partitionToolCalls`)。worker control 与 UI response 会改变执行状态，不是只读。
 *
 * @see crabot-docs/protocols/protocol-agent-v3.md §4.1、§4.3、§5.5
 */

import { defineTool } from '../../engine/index.js'
import type { ToolDefinition, ToolCallResult } from '../../engine/index.js'
import type { WorkerHarness } from '../../workers/harness/harness'
import type { ManagerKey, LedgerWorker, TaskStatus } from '../../workers/harness/ledger-types'
import { isDecisionVisibleWorker } from '../../workers/harness/task-status.js'
import type { MasterAuthorization } from '../principal.js'
import type { WorkerActivity, WorkerImplId } from '../../workers/types'
import type { WorkerTurnResolution } from '../../workers/harness/worker-turn-store.js'
import { projectWorkerActivity } from '../../workers/trace/activity-projection.js'
import type { ResolvedPermissions } from '../../types'
import type { LegacyContinuationAuth } from '../../workers/harness/legacy-continuation-auth.js'
import { QueryEstablishmentError } from '../../workers/errors.js'

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
  /** Agent-owned structured session projection; manager never receives a native session path. */
  readonly readWorkerActivity?: (params: {
    worker_id: string
    incarnation_id?: string
    after?: string
    view: 'assistant' | 'all'
  }) => Promise<{
    incarnation_id: string
    activities: WorkerActivity[]
    next_cursor?: string
    unavailable_reason?: string
  }>
  /** Exact report target must have accepted a send_message in this Manager episode. */
  readonly hasSuccessfulSendMessageTo?: (target: { channel_id: string; session_id: string }) => boolean
  /** A continued turn needs an actual same-episode input/continuation action. */
  readonly hasContinuedWorker?: (workerId: string) => boolean
  readonly onWorkerContinuation?: (workerId: string) => void
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
  if (error instanceof QueryEstablishmentError) {
    return {
      output: JSON.stringify({
        query_id: error.query_id,
        reason_code: error.reason_code,
        reason: error.reason,
        certainty: error.certainty,
      }),
      isError: true,
    }
  }
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
    supervision_mode: worker.supervision?.mode ?? 'default',
    ...(worker.supervision?.next_due_at ? { next_due_at: worker.supervision.next_due_at } : {}),
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

async function workerState(harness: WorkerHarness, worker: LedgerWorker) {
  const mainline = worker.incarnations.filter((inc) => inc.forked_from === undefined).at(-1)
  const [latestTurn, latestActivity, activeOperations] = await Promise.all([
    harness.getWorkerTurn(worker.worker_id),
    mainline?.incarnation_id
      ? harness.getLatestWorkerActivity(worker.worker_id, mainline.incarnation_id)
      : undefined,
    harness.getWorkerControlOperations(worker.worker_id),
  ])
  return {
    worker_id: worker.worker_id,
    ...(mainline?.incarnation_id
      ? {
          mainline: {
            incarnation_id: mainline.incarnation_id,
            impl: mainline.impl,
            state: mainline.state,
          },
        }
      : {}),
    forks: worker.incarnations
      .filter((inc) => inc.forked_from !== undefined && inc.incarnation_id !== undefined && inc.query_id !== undefined)
      .map((inc) => ({
        incarnation_id: inc.incarnation_id!,
        query_id: inc.query_id!,
        state: inc.state,
      })),
    ...(latestActivity
      ? {
          latest_activity: {
            activity_id: latestActivity.activity_id,
            kind: latestActivity.kind,
            occurred_at: latestActivity.occurred_at,
          },
        }
      : {}),
    ...(latestTurn ? { latest_turn: { turn_id: latestTurn.turn_id, disposition: latestTurn.disposition } } : {}),
    active_operations: activeOperations,
  }
}

export function buildWorkerTools(deps: WorkerToolsDeps): ToolDefinition[] {
  const { harness, context, authorization, validateMasterAuthorization } = deps
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
      '事件唤醒你,事件带状态和待处置回合；用 get_worker_activity 读取原生会话。impl 缺省按部署偏好选择;workspace 缺省新建。',
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

  // --- send_to_worker(同步完成一次投递尝试,worker 的回应仍由事件唤醒) ---
  const sendToWorker = defineTool({
    name: 'send_to_worker',
    description:
      '向指定 worker 投递一条输入。返回 delivered 才表示 worker adapter 已确认接受；failed 会立即给出简要原因与送达确定性。' +
      'worker 处于什么状态都能投:在跑/空闲的排进信箱,' +
      '已结束(completed/failed)的会自动复活它原来的会话接着干、上下文完整保留——所以延续、' +
      '补充、返工一个老任务都走这里,不必先判断它死活,也不必为此新开 worker。同步投递只等待一次有界尝试，' +
      '不等 worker 处理完这条消息;worker 每跑完一轮或结束时' +
      '会作为事件唤醒你,事件带状态和待处置回合；用 get_worker_activity 读取原生会话。命中已 cancelled 的任务会被拒绝。' +
      '未知交互界面必须使用 respond_to_worker_ui，普通输入不提供 raw 终端旁路。' +
      '如果这条消息代表立即改变当前任务方向，设置 immediate_redirect=true；非 builtin worker 会先由 Harness 中断当前回合，' +
      '确认中断完成后再投递，builtin worker 不 abort 而是在下一轮 LLM 调用前优先消费。',
    inputSchema: {
      type: 'object',
      properties: {
        worker_id: { type: 'string', description: '目标 worker id' },
        text: { type: 'string', description: '要投递的文本' },
        immediate_redirect: {
          type: 'boolean',
          description: '是否立即改变当前任务方向；CLI worker 先中断并确认完成，再投递文本。',
        },
      },
      required: ['worker_id', 'text'],
    },
    isReadOnly: false,
    call: async (input): Promise<ToolCallResult> => {
      const { worker_id, text, immediate_redirect } = input as {
        worker_id?: string
        text?: string
        immediate_redirect?: unknown
      }
      if (!worker_id || typeof worker_id !== 'string') return invalid('send_to_worker: worker_id 必填且为字符串')
      if (typeof text !== 'string' || text.length === 0) return invalid('send_to_worker: text 必填且为非空字符串')
      if (immediate_redirect !== undefined && typeof immediate_redirect !== 'boolean') {
        return invalid('send_to_worker: immediate_redirect 必须为布尔值')
      }

      try {
        const worker = await authorizeWorker(worker_id)
        const legacyContinuationAuth = capturedLegacyContinuationAuth?.(worker.manager_key)
        const result = await harness.sendToWorker(worker_id, text, {
          managerKey: context().managerKey,
          ...(immediate_redirect !== undefined ? { immediate_redirect } : {}),
          ...(legacyContinuationAuth ? { legacyContinuationAuth } : {}),
        })
        if (result.status === 'delivered') deps.onWorkerContinuation?.(worker_id)
        return ok(result)
      } catch (error) {
        return mapError(`send_to_worker(${worker_id})`, error)
      }
    },
  })

  // --- query_worker（同步确认 fork + 首问建立；回答继续异步执行） ---
  const queryWorker = defineTool({
    name: 'query_worker',
    description:
      '对正在跑的 worker 建立一次独立侧问(fork 语义),不打扰主线执行。只有 fork 已创建、' +
      '首问已接受且化身已落账后才返回 started + query_id + fork_seq；建立失败会在本次调用' +
      '直接返回原因。答案生成仍异步，完成或失败后会可靠通知你；用 get_worker_terminal 传入' +
      '返回的 fork_seq 可随时读取侧问文本。',
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
        await authorizeWorker(worker_id)
        const result = await harness.queryWorker(worker_id, question, {
          managerKey: context().managerKey,
        })
        return ok(result)
      } catch (error) {
        return mapError(`query_worker(${worker_id})`, error)
      }
    },
  })

  const getWorkerState = defineTool({
    name: 'get_worker_state',
    description: '读取 worker 当前任务状态和主线化身状态。用于判断是否在运行、等待输入或已经结束，不读取终端。',
    inputSchema: {
      type: 'object',
      properties: { worker_id: { type: 'string', description: '目标 worker id' } },
      required: ['worker_id'],
    },
    isReadOnly: true,
    call: async (input): Promise<ToolCallResult> => {
      const workerId = (input as { worker_id?: string }).worker_id
      if (!workerId || typeof workerId !== 'string') return invalid('get_worker_state: worker_id 必填且为字符串')
      try {
        return ok(await workerState(harness, await authorizeWorker(workerId)))
      } catch (error) {
        return mapError(`get_worker_state(${workerId})`, error)
      }
    },
  })

  const getWorkerActivity = defineTool({
    name: 'get_worker_activity',
    description:
      '读取 worker 原生会话解析出的增量活动。缺省 view=assistant，只返回 assistant text；' +
      '仅在诊断执行细节时传 view=all 以同时查看 tool call/result。after 是上次返回的 opaque cursor；切换 view 时不传旧 after。',
    inputSchema: {
      type: 'object',
      properties: {
        worker_id: { type: 'string', description: '目标 worker id' },
        incarnation_id: { type: 'string', description: '可选的稳定化身 id，缺省主线化身' },
        after: { type: 'string', description: '上次返回的 opaque cursor' },
        view: { type: 'string', enum: ['assistant', 'all'], description: 'assistant 为默认，all 含工具活动' },
      },
      required: ['worker_id'],
    },
    isReadOnly: true,
    call: async (input): Promise<ToolCallResult> => {
      const { worker_id, incarnation_id, after, view } = input as {
        worker_id?: string
        incarnation_id?: string
        after?: string
        view?: 'assistant' | 'all'
      }
      if (!worker_id || typeof worker_id !== 'string') return invalid('get_worker_activity: worker_id 必填且为字符串')
      if (incarnation_id !== undefined && typeof incarnation_id !== 'string') return invalid('get_worker_activity: incarnation_id 必须是字符串')
      if (after !== undefined && typeof after !== 'string') return invalid('get_worker_activity: after 必须是字符串')
      if (view !== undefined && view !== 'assistant' && view !== 'all') return invalid('get_worker_activity: view 只能是 assistant 或 all')
      try {
        await authorizeWorker(worker_id)
        if (!deps.readWorkerActivity) throw new Error('worker activity reader is unavailable')
        const result = await deps.readWorkerActivity({
          worker_id,
          ...(incarnation_id !== undefined ? { incarnation_id } : {}),
          ...(after !== undefined ? { after } : {}),
          view: view ?? 'assistant',
        })
        return ok({ worker_id, view: view ?? 'assistant', ...result })
      } catch (error) {
        return mapError(`get_worker_activity(${worker_id})`, error)
      }
    },
  })

  const getWorkerTurn = defineTool({
    name: 'get_worker_turn',
    description: '读取 worker 最近一个待处置回合，或按 turn_id 精确读取。回合只表示 worker 已停在一个可处理边界，不等于已经向人类交付。',
    inputSchema: {
      type: 'object',
      properties: {
        worker_id: { type: 'string', description: '目标 worker id' },
        turn_id: { type: 'string', description: '可选的具体回合 id' },
      },
      required: ['worker_id'],
    },
    isReadOnly: true,
    call: async (input): Promise<ToolCallResult> => {
      const { worker_id, turn_id } = input as { worker_id?: string; turn_id?: string }
      if (!worker_id || typeof worker_id !== 'string') return invalid('get_worker_turn: worker_id 必填且为字符串')
      if (turn_id !== undefined && typeof turn_id !== 'string') return invalid('get_worker_turn: turn_id 必须是字符串')
      try {
        await authorizeWorker(worker_id)
        const turn = await harness.getWorkerTurn(worker_id, turn_id)
        const activity = turn ? await harness.getWorkerTurnActivities(turn) : undefined
        return ok({
          worker_id,
          turn: turn ?? null,
          activities: turn && activity
            ? projectWorkerActivity(activity.events, 'all', {
                worker_id,
                incarnation_id: turn.incarnation_id,
              })
            : [],
          ...(activity?.unavailableReason ? { unavailable_reason: activity.unavailableReason } : {}),
        })
      } catch (error) {
        return mapError(`get_worker_turn(${worker_id})`, error)
      }
    },
  })

  const requestWorkerInterrupt = defineTool({
    name: 'request_worker_interrupt',
    description: '请求中断 worker 当前主线回合。返回持久化 control operation；请求被接受不等于已经中断，需以 operation status 和后续事件为准。',
    inputSchema: {
      type: 'object',
      properties: { worker_id: { type: 'string', description: '目标 worker id' } },
      required: ['worker_id'],
    },
    isReadOnly: false,
    call: async (input): Promise<ToolCallResult> => {
      const workerId = (input as { worker_id?: string }).worker_id
      if (!workerId || typeof workerId !== 'string') return invalid('request_worker_interrupt: worker_id 必填且为字符串')
      try {
        await authorizeWorker(workerId)
        return ok({ operation: await harness.requestWorkerInterrupt(workerId) })
      } catch (error) {
        return mapError(`request_worker_interrupt(${workerId})`, error)
      }
    },
  })

  const requestWorkerStop = defineTool({
    name: 'request_worker_stop',
    description: '请求停止 worker 主线、已登记 fork 与 Harness 可核验的 worker-owned 执行。返回持久化 control operation；只有核验成功后任务才会转为 cancelled，无法证明完整停止时状态为 unknown。',
    inputSchema: {
      type: 'object',
      properties: { worker_id: { type: 'string', description: '目标 worker id' } },
      required: ['worker_id'],
    },
    isReadOnly: false,
    call: async (input): Promise<ToolCallResult> => {
      const workerId = (input as { worker_id?: string }).worker_id
      if (!workerId || typeof workerId !== 'string') return invalid('request_worker_stop: worker_id 必填且为字符串')
      try {
        await authorizeWorker(workerId)
        return ok({ operation: await harness.requestWorkerStop(workerId) })
      } catch (error) {
        return mapError(`request_worker_stop(${workerId})`, error)
      }
    },
  })

  const respondToWorkerUi = defineTool({
    name: 'respond_to_worker_ui',
    description: '对未知 worker UI 的一次性快照作答。结合状态和原生会话判断；只有需要诊断未知界面时才读取终端。只能选择 interaction_required 事件中给出的 action_id；文本 action 才传 text。snapshot_id 过期、已使用或化身变化都会被拒绝。',
    inputSchema: {
      type: 'object',
      properties: {
        worker_id: { type: 'string', description: '目标 worker id' },
        snapshot_id: { type: 'string', description: 'interaction_required 事件返回的快照 id' },
        action_id: { type: 'string', description: 'interaction_required 的 actions 中一个 action_id' },
        text: { type: 'string', description: '仅 text action 需要的明确文本回答' },
      },
      required: ['worker_id', 'snapshot_id', 'action_id'],
    },
    isReadOnly: false,
    call: async (input): Promise<ToolCallResult> => {
      const { worker_id, snapshot_id, action_id, text } = input as { worker_id?: string; snapshot_id?: string; action_id?: string; text?: string }
      if (!worker_id || typeof worker_id !== 'string') return invalid('respond_to_worker_ui: worker_id 必填且为字符串')
      if (!snapshot_id || typeof snapshot_id !== 'string') return invalid('respond_to_worker_ui: snapshot_id 必填且为字符串')
      if (!action_id || typeof action_id !== 'string') return invalid('respond_to_worker_ui: action_id 必填且为字符串')
      if (text !== undefined && typeof text !== 'string') return invalid('respond_to_worker_ui: text 必须是字符串')
      try {
        await authorizeWorker(worker_id)
        return ok(await harness.respondToWorkerUi(worker_id, snapshot_id, action_id, text))
      } catch (error) {
        return mapError(`respond_to_worker_ui(${worker_id})`, error)
      }
    },
  })

  const resolveWorkerTurn = defineTool({
    name: 'resolve_worker_turn',
    description:
      '标记一个已检查的 worker 回合如何处置。reported 或 asked_human 必须已向该 worker 的 report_to 成功发送；' +
      'continued 必须已实际续办；suppressed 必须写明原因。',
    inputSchema: {
      type: 'object',
      properties: {
        worker_id: { type: 'string', description: '目标 worker id' },
        turn_id: { type: 'string', description: 'get_worker_turn 返回的回合 id' },
        resolution: { type: 'string', enum: ['continued', 'reported', 'asked_human', 'suppressed'], description: '本回合的处置结果' },
        reason: { type: 'string', description: 'suppressed 时必填的审计原因' },
      },
      required: ['worker_id', 'turn_id', 'resolution'],
    },
    isReadOnly: false,
    call: async (input): Promise<ToolCallResult> => {
      const { worker_id, turn_id, resolution, reason } = input as {
        worker_id?: string
        turn_id?: string
        resolution?: WorkerTurnResolution
        reason?: string
      }
      if (!worker_id || typeof worker_id !== 'string') return invalid('resolve_worker_turn: worker_id 必填且为字符串')
      if (!turn_id || typeof turn_id !== 'string') return invalid('resolve_worker_turn: turn_id 必填且为字符串')
      if (resolution !== 'continued' && resolution !== 'reported' && resolution !== 'asked_human' && resolution !== 'suppressed') {
        return invalid('resolve_worker_turn: resolution 只能是 continued、reported、asked_human 或 suppressed')
      }
      if (reason !== undefined && typeof reason !== 'string') return invalid('resolve_worker_turn: reason 必须是字符串')
      try {
        const worker = await authorizeWorker(worker_id)
        if ((resolution === 'reported' || resolution === 'asked_human') && !deps.hasSuccessfulSendMessageTo?.(worker.report_to)) {
          throw new Error('本 Manager 回合尚未向该 worker 的 report_to 成功调用 send_message，不能把 worker turn 标记为已交付')
        }
        if (resolution === 'continued' && !deps.hasContinuedWorker?.(worker_id)) {
          throw new Error('本 Manager 回合尚未对该 worker 执行实际续办动作，不能标记为 continued')
        }
        if (resolution === 'suppressed' && !reason?.trim()) {
          throw new Error('suppressed 必须提供非空 reason')
        }
        return ok({ worker_id, turn: await harness.resolveWorkerTurn(worker_id, turn_id, resolution, reason?.trim()) })
      } catch (error) {
        return mapError(`resolve_worker_turn(${worker_id})`, error)
      }
    },
  })

  // --- get_worker_terminal(同步:完整终端视图) ---
  const getWorkerTerminal = defineTool({
    name: 'get_worker_terminal',
    description:
      '同步读取 worker 化身当前完整终端画面、最终画面或 headless 纯文本。每次调用都是完整替换，' +
      '没有 offset/增量；缺省读主线化身，侧问结果传 query_worker 返回的 fork_seq。',
    inputSchema: {
      type: 'object',
      properties: {
        worker_id: { type: 'string', description: '目标 worker id' },
        seq: { type: 'number', description: '读侧问分支的答案时传 query 事件里给出的 seq;缺省读主线化身' },
      },
      required: ['worker_id'],
    },
    isReadOnly: true,
    call: async (input): Promise<ToolCallResult> => {
      const { worker_id, seq } = input as { worker_id?: string; seq?: number }
      if (!worker_id || typeof worker_id !== 'string') return invalid('get_worker_terminal: worker_id 必填且为字符串')

      try {
        await authorizeWorker(worker_id)
        const terminal = await harness.getWorkerTerminal(
          worker_id,
          seq !== undefined ? { seq } : undefined
        )
        return ok({ worker_id, terminal })
      } catch (error) {
        return mapError(`get_worker_terminal(${worker_id})`, error)
      }
    },
  })

  const listWorkers = defineTool({
    name: 'list_workers',
    description:
      '列出当前会话可决策的 worker。默认只返回非终态(queued/running/waiting_input)，' +
      '需要查历史时显式 include_terminal=true 并分页；需要继续、返工或汇报进度时先查询。',
    inputSchema: {
      type: 'object',
      properties: {
        include_terminal: { type: 'boolean', description: '是否包含已完成/失败/取消的历史；默认 false' },
        page: { type: 'number', description: '历史分页页码，从1开始；默认1' },
        page_size: { type: 'number', description: '每页数量，默认20，最大100' },
      },
    },
    isReadOnly: true,
    call: async (input): Promise<ToolCallResult> => {
      try {
        const params = input as { include_terminal?: boolean; page?: number; page_size?: number }
        const all = await harness.listWorkers(context().managerKey)
        const active = all.filter((worker) => isDecisionVisibleWorker(worker.task.status))
        const terminal = all.filter((worker) => !isDecisionVisibleWorker(worker.task.status))
        const selected = params.include_terminal ? [...active, ...terminal] : active
        const sorted = sortSummaries(selected.map(summarizeWorker))
        const pagination = normalizePagination(params.page, params.page_size)
        const offset = (pagination.page - 1) * pagination.page_size
        return ok({
          workers: sorted.slice(offset, offset + pagination.page_size),
          total_active: active.length,
          total_terminal: terminal.length,
          pagination: {
            ...pagination,
            total_items: sorted.length,
            total_pages: Math.ceil(sorted.length / pagination.page_size),
          },
        })
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

  const setWorkerPeriodicReport = defineTool({
    name: 'set_worker_periodic_report',
    description:
      '为一个仍在进行中的 worker 设置人类明确要求的定期汇报。规则绑定该 worker 的完整主线链，' +
      '首次从现在起按 interval_minutes 到期；它不是定时任务，也不会创建 Admin Schedule。',
    inputSchema: {
      type: 'object',
      properties: {
        worker_id: { type: 'string', description: '目标 worker id' },
        interval_minutes: { type: 'number', description: '正整数分钟' },
        expires_at: { type: 'string', description: '可选的未来绝对到期时间（ISO 8601）' },
      },
      required: ['worker_id', 'interval_minutes'],
    },
    isReadOnly: false,
    call: async (input): Promise<ToolCallResult> => {
      const { worker_id, interval_minutes, expires_at } = input as {
        worker_id?: string
        interval_minutes?: number
        expires_at?: string
      }
      if (!worker_id || typeof worker_id !== 'string') return invalid('set_worker_periodic_report: worker_id 必填且为字符串')
      if (typeof interval_minutes !== 'number' || !Number.isInteger(interval_minutes) || interval_minutes <= 0) {
        return invalid('set_worker_periodic_report: interval_minutes 必须是正整数')
      }
      if (expires_at !== undefined && typeof expires_at !== 'string') {
        return invalid('set_worker_periodic_report: expires_at 必须是 ISO 8601 字符串')
      }
      try {
        await authorizeWorker(worker_id)
        const supervision = await harness.setWorkerPeriodicReport(
          worker_id,
          context().reportTo,
          interval_minutes * 60_000,
          expires_at,
        )
        return ok({
          worker_id,
          mode: 'periodic_report',
          interval_minutes,
          next_due_at: supervision.next_due_at,
          ...(supervision.periodic_report?.expires_at ? { expires_at: supervision.periodic_report.expires_at } : {}),
        })
      } catch (error) {
        return mapError(`set_worker_periodic_report(${worker_id})`, error)
      }
    },
  })

  const clearWorkerPeriodicReport = defineTool({
    name: 'clear_worker_periodic_report',
    description: '取消 worker 的定期汇报，立即恢复默认例行巡检。',
    inputSchema: {
      type: 'object',
      properties: { worker_id: { type: 'string', description: '目标 worker id' } },
      required: ['worker_id'],
    },
    isReadOnly: false,
    call: async (input): Promise<ToolCallResult> => {
      const worker_id = (input as { worker_id?: string }).worker_id
      if (!worker_id || typeof worker_id !== 'string') return invalid('clear_worker_periodic_report: worker_id 必填且为字符串')
      try {
        await authorizeWorker(worker_id)
        const supervision = await harness.clearWorkerPeriodicReport(worker_id)
        return ok({
          worker_id,
          mode: 'default',
          ...(supervision.next_due_at ? { next_due_at: supervision.next_due_at } : {}),
        })
      } catch (error) {
        return mapError(`clear_worker_periodic_report(${worker_id})`, error)
      }
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

  return [
    spawnWorker,
    sendToWorker,
    queryWorker,
    getWorkerState,
    getWorkerActivity,
    getWorkerTurn,
    requestWorkerInterrupt,
    requestWorkerStop,
    respondToWorkerUi,
    resolveWorkerTurn,
    getWorkerTerminal,
    listWorkers,
    getWorkerDetail,
    listWorkerImplementations,
    setWorkerPeriodicReport,
    clearWorkerPeriodicReport,
    ...(listAllWorkers ? [listAllWorkers] : []),
  ]
}
