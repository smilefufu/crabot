/**
 * task 读模型的纯逻辑 —— protocol-agent-v3.md §8.3(P5 Task 3)。
 *
 * v3 把 task 的真相源从 admin 迁到 agent,admin 退化成只读代理。本文件是 `list_workers_admin`
 * / `get_worker_detail` 两个读端点的**纯计算部分**:只接收已经取出来的台账数据,不读盘、不碰
 * LedgerStore / WorkerHarness 实例。RPC 壳(取数、错误码、fire-and-forget)在 P5 Task 4。
 * 这样切是为了让过滤/排序/分页的边界语义能被确定性地测出来,不必造文件系统。
 *
 * ## 复用而非重造
 *
 * - `PaginationParams` / `PaginatedResult<T>` 直接用 `crabot-shared` 的导出(base-protocol §5.6),
 *   不在本文件另立形状相近的类型;
 * - 过滤 → 排序 → 分页的写法沿用 admin 既有 list 处理器的范式(`handleListTasks`
 *   `crabot-admin/src/index.ts`、`AgentManager.listImplementations`):status 单值/数组归一后
 *   `includes`、时间用 ISO 8601 字符串直接比较、`page ?? 1` / `page_size ?? 20` +
 *   `Math.ceil(total / pageSize)` + `slice((page-1)*pageSize, ...)`;
 * - `page_size` 的 100 上限沿用 agent 侧既有范式(`src/agent/find-task-tool.ts` 的
 *   `Math.min(page_size ?? 20, 100)`),admin 侧的处理器没有夹紧,这里以 base-protocol
 *   §5.6 注释("默认 20,最大 100")为准。
 *
 * ## `task.status` 的可信度分级(不要据此假定"completed = 任务真的成功")
 *
 * 本文件只忠实反映台账,不做任何补偿。台账的 `task.status` 由 harness 依据 adapter 上报的
 * `ended_reason` 落定,其可信度因实现而异(协议 §6.3):`builtin` 有 `finish_task` 结构化
 * 终态上报,`completed`/`failed` 是确证;`claude-code`/`codex` 基于交互式 CLI,没有任何可得
 * 的任务成败信号,其 `completed` 是**推断**(会话消失且非本进程 kill),不表示任务真的成功。
 *
 * @see crabot-docs/protocols/protocol-agent-v3.md §8.3、§7
 * @see crabot-docs/protocols/base-protocol.md §5.6(分页)、§5.7(TimeRange)
 */

import type { PaginationParams, PaginatedResult } from 'crabot-shared'
import type { ManagerKey, LedgerWorker, TaskStatus } from '../workers/harness/ledger-types.js'
import { isDecisionVisibleWorker } from '../workers/harness/task-status.js'
import type { NormalizedTraceEvent, WorkerImplId, WorkerTerminalView } from '../workers/types.js'

/**
 * base-protocol §5.7 TimeRange。`crabot-shared` 目前没有导出它(只在协议文档和各 channel
 * 模块的本地 types.ts 里各写各的),这里按协议原样声明,待上游补齐后再收敛为复用——
 * 与 ledger-types.ts 处理 `TaskPriority` 的做法一致。
 *
 * 注意各 channel 模块本地的 `TimeRange { before?, after? }` 是另一套形状(历史偏离),
 * 本文件以 base-protocol 为准。
 */
export interface TimeRange {
  /** 起始时间,ISO 8601,**包含** */
  start?: string
  /** 结束时间,ISO 8601,**不包含** */
  end?: string
}

/** §8.3 list_workers_admin:跨对话对象扁平查询 */
export interface ListWorkersAdminParams {
  status?: TaskStatus | TaskStatus[]
  impl?: WorkerImplId
  manager_key?: ManagerKey
  time_range?: TimeRange
  /** 默认 false：只返回 Manager 决策视野（非终态）。 */
  include_terminal?: boolean
  /** 默认 false：legacy 导入历史需显式进入。 */
  include_legacy?: boolean
  /** title contains，大小写不敏感。 */
  q?: string
  pagination?: PaginationParams
}

export interface ListWorkersAdminResult extends PaginatedResult<LedgerWorker> {
  total_active: number
  total_terminal: number
  total_legacy: number
}

/** §8.3 get_worker_detail:单 worker 全量(台账条目 + 化身链) */
export interface GetWorkerDetailParams {
  worker_id: string
}

export interface GetWorkerDetailResult {
  worker: LedgerWorker
}

/**
 * §8.3 get_worker_terminal:按化身读取完整终端视图。
 */
export interface GetWorkerTerminalParams {
  worker_id: string
  /**
   * 化身序号(从 1 起)。**可选**:缺省 = 主线化身(`mainlineIncarnation`,即排除侧问 fork
   * 之后的最新化身),沿用 `WorkerHarness.getWorkerTerminal` 的既有缺省语义。调用方(admin
   * REST `?seq=` 缺省时)拿不到台账,算不出主线是哪个化身,只有不下发这个字段才落在正确的
   * 化身上——填 0 台账里恒不存在,填 1 则锁死在最早那个化身上。
   */
  seq?: number
}

export type GetWorkerTerminalResult = WorkerTerminalView

/** §8.3 get_worker_trace:结构化时间线(两层信息源见 §10.2) */
export interface GetWorkerTraceParams {
  worker_id: string
  /** 化身序号(从 1 起)。**可选**:缺省 = 主线化身,与 `GetWorkerTerminalParams.seq` 同一缺省。 */
  seq?: number
  cursor?: string
}

export interface GetWorkerTraceResult {
  events: NormalizedTraceEvent[]
  next_cursor?: string
  unavailable_reason?: string
}

/**
 * 台账条目 + 它所属的对话对象 —— `LedgerStore.listAllWorkers()` / `findWorker()` 的返回元素形状。
 * `managerKey` 只用于过滤,不出现在协议返回体里(§8.3 的 items 是 `LedgerWorker`)。
 */
export interface LedgerWorkerEntry {
  managerKey: ManagerKey
  worker: LedgerWorker
}

/** base-protocol §5.6:每页数量默认 20,最大 100 */
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100

/** 页码/每页数量归一:非正数、非有限数、缺失一律退回默认值(读端点不该因为参数脏就报错) */
function normalizePositive(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return fallback
  return Math.floor(value)
}

/**
 * 过滤 → 排序 → 分页。纯函数:不修改入参数组。
 *
 * **排序 `updated_at desc`**:台账的每次状态迁移都会刷新 `updated_at`(harness 的
 * upsertWorker 路径),而 `task.created_at` 只反映建账时刻。admin 的 worker 列表是运维视角的
 * "最近发生了什么",按最近活动排序才能让在途/刚变更的 worker 浮到首页;若按 created_at 排,
 * 一个跑了三天仍在推进的 worker 会沉底。§8.3 未开放排序参数,故此处固定不可配。
 *
 * **同 `updated_at` 的兜底次序**:按 `worker_id` 升序。不依赖 `Array.prototype.sort` 的稳定性,
 * 因为输入顺序本身不确定(`listAllWorkers` 按 Map/Set 的迭代序拼装,受台账文件扫描顺序影响),
 * 稳定排序只能保证"保持输入序",保证不了"跨调用一致"——而分页要求全序确定,否则同一批数据
 * 翻页会出现漏项/重项。
 *
 * **`time_range` 边界**:base-protocol §5.7 —— `start` 闭(含)、`end` 开(不含),即 `[start, end)`;
 * 比较的是 `task.created_at`(创建时间落在窗口内),与 admin 既有 `list_tasks` 的
 * `created_after`/`created_before` 语义一致。ISO 8601 UTC 串按字典序比较即时间序。
 *
 * **越界分页**:返回空 items,`pagination` 原样回显请求的 page,不报错(§8.3 没有定义越界错误码,
 * 且列表在并发删改下天然可能翻到空页,报错只会让 admin UI 更难用)。
 */
export function filterAndPageWorkers(
  all: ReadonlyArray<LedgerWorkerEntry>,
  params: ListWorkersAdminParams
): ListWorkersAdminResult {
  const statuses =
    params.status === undefined
      ? undefined
      : Array.isArray(params.status)
        ? params.status
        : [params.status]
  const range = params.time_range
  const hasRange = range !== undefined && (range.start !== undefined || range.end !== undefined)
  const query = params.q?.trim().toLocaleLowerCase()

  // 先应用身份/内容/时间范围，计数与当前查询 scope 对齐；visibility/status 后应用。
  const scoped = all.filter((entry) => {
    const worker = entry.worker
    if (params.manager_key && entry.managerKey !== params.manager_key) return false
    if (params.impl) {
      const mainline = worker.incarnations.filter((inc) => inc.forked_from === undefined).at(-1)
      if (mainline?.impl !== params.impl) return false
    }
    if (query && !worker.task.title.toLocaleLowerCase().includes(query)) return false
    if (hasRange) {
      const createdAt = worker.task.created_at
      if (!createdAt) return false
      if (range!.start !== undefined && createdAt < range!.start) return false
      if (range!.end !== undefined && createdAt >= range!.end) return false
    }
    return true
  })
  const totalActive = scoped.filter((entry) => isDecisionVisibleWorker(entry.worker.task.status)).length
  const totalTerminal = scoped.length - totalActive
  const totalLegacy = scoped.filter((entry) => entry.worker.legacy_source !== undefined).length

  // filter 总是产出新数组,后面的 sort 不会污染入参
  const matched = scoped.filter((entry) => {
    const worker = entry.worker
    if (!params.include_terminal && !isDecisionVisibleWorker(worker.task.status)) return false
    // active legacy 已通过 v3 continuation 成为真实可续跑 worker，必须与 Manager 决策视野一致。
    // include_legacy 只控制终态 legacy 历史。
    if (!params.include_legacy && worker.legacy_source !== undefined && !isDecisionVisibleWorker(worker.task.status)) return false
    if (statuses && !statuses.includes(worker.task.status)) return false
    return true
  })

  matched.sort((a, b) => {
    const byUpdatedDesc = (b.worker.updated_at ?? '').localeCompare(a.worker.updated_at ?? '')
    if (byUpdatedDesc !== 0) return byUpdatedDesc
    return a.worker.worker_id.localeCompare(b.worker.worker_id)
  })

  const page = normalizePositive(params.pagination?.page, 1)
  const pageSize = Math.min(
    normalizePositive(params.pagination?.page_size, DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE
  )
  const totalItems = matched.length
  const offset = (page - 1) * pageSize

  return {
    items: matched.slice(offset, offset + pageSize).map((entry) => entry.worker),
    total_active: totalActive,
    total_terminal: totalTerminal,
    total_legacy: totalLegacy,
    pagination: {
      page,
      page_size: pageSize,
      total_items: totalItems,
      total_pages: Math.ceil(totalItems / pageSize),
    },
  }
}

/**
 * 台账条目 → §8.3 的 `GetWorkerDetailResult`。
 *
 * 详情就是台账条目本身(含完整化身链),不做任何计算或裁剪——v3 里 agent 即真相源,台账结构
 * (§3)本身就是对外契约。这里只负责剥掉 `LedgerStore.findWorker` 附带的 `managerKey`
 * 包装:它是查找的副产物,不在协议返回体里(调用方要用的话自己留着)。
 */
export function buildWorkerDetail(found: LedgerWorkerEntry): GetWorkerDetailResult {
  return { worker: found.worker }
}

// ============================================================================
// P6-A 阶段 3：Manager 读模型（protocol-agent-v3 §8.4）
// ============================================================================

export interface ManagerAdminSummary {
  manager_key: ManagerKey
  last_activity_at?: string
  recent_activity_summary?: string
  active_worker_count: number
}

export interface ManagerSummarySources {
  /** disk session keys（ManagerSessionStore.listManagerKeys 已做 dir/key 校验）。 */
  readonly diskSessionKeys: ReadonlyArray<ManagerKey>
  /** TraceStore 已验证 manager keys。 */
  readonly traceKeys: ReadonlyArray<ManagerKey>
  /** 每 key 最近 episode 的时间与人话 trigger summary。 */
  readonly episodeStats: (key: ManagerKey) => { latestStartedAt?: string; latestSummary?: string }
  /** 与 list_workers 默认视野共用判据后的 active worker 数。 */
  readonly activeWorkerCount: (key: ManagerKey) => number
  /** 内存 registry 当前 running manager 的最近活跃毫秒（补充尚未首次 save 的当前 manager）。 */
  readonly runningLastActiveAtMs: (key: ManagerKey) => number | undefined
}

/**
 * `list_managers_admin` 的纯计算：disk session keys ∪ TraceStore keys 去重 union
 * （内存 running 只提供 last_activity 提示——episode 起点已 ensureSession 落盘，
 * 不存在只在内存的 manager），排序 `last_activity_at desc, manager_key asc`，
 * base pagination 1/20/max100。
 */
export function buildManagerAdminSummaries(
  sources: ManagerSummarySources,
  pagination?: PaginationParams,
): PaginatedResult<ManagerAdminSummary> {
  const keys = new Set<ManagerKey>()
  for (const key of sources.diskSessionKeys) keys.add(key)
  for (const key of sources.traceKeys) keys.add(key)

  const items: ManagerAdminSummary[] = Array.from(keys).map((key) => {
    const stats = sources.episodeStats(key)
    const runningMs = sources.runningLastActiveAtMs(key)
    const lastActivity = [stats.latestStartedAt, runningMs !== undefined ? new Date(runningMs).toISOString() : undefined]
      .filter((value): value is string => value !== undefined)
      .sort()
      .pop()
    return {
      manager_key: key,
      ...(lastActivity ? { last_activity_at: lastActivity } : {}),
      ...(stats.latestSummary ? { recent_activity_summary: stats.latestSummary } : {}),
      active_worker_count: sources.activeWorkerCount(key),
    }
  })

  items.sort((left, right) => {
    const byActivityDesc = (right.last_activity_at ?? '').localeCompare(left.last_activity_at ?? '')
    if (byActivityDesc !== 0) return byActivityDesc
    return left.manager_key.localeCompare(right.manager_key)
  })

  const page = normalizePositive(pagination?.page, 1)
  const pageSize = Math.min(normalizePositive(pagination?.page_size, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE)
  const totalItems = items.length
  const offset = (page - 1) * pageSize
  return {
    items: items.slice(offset, offset + pageSize),
    pagination: {
      page,
      page_size: pageSize,
      total_items: totalItems,
      total_pages: Math.ceil(totalItems / pageSize),
    },
  }
}
