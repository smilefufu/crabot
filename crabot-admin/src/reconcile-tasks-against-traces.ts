/**
 * Task / Trace 状态对账（spec：task/trace 状态同步 SSOT 重整 2026-06-09）。
 *
 * 背景：admin tasks.json 是 task.status 的 SSOT，agent 通过 RPC（update_task_status）写入。
 * 但任何 RPC 都可能失败 / 状态机拒绝 / 调用方漏调 —— drift 不可避免。本模块作为兜底，
 * 周期性对账"非终态 task vs 关联 trace 状态"，发现 drift 自动修复。
 *
 * 典型场景：
 * - worker loop 调 ask_human → task=waiting_human，trace 仍 running
 * - 用户回话 → supplement push 到 humanQueue → worker loop 继续
 * - worker 跑完 → trace=completed → agent 调 update_task_status('completed')
 * - admin 状态机判定 waiting_human → completed 非法，拒绝
 * - bestEffortRpc 吞错，task 永远卡在 waiting_human
 *
 * 修复策略：检测到"task 仍活跃 + 所有 worker trace 终态 + 距上次更新 > minStaleAgeMs"时，
 * 按最后启动的 worker 状态切 completed/failed。reconciliation 不修 status=pending 的 task
 * （刚创建还没起 worker 的，留给 dispatcher 重新调度）。
 */

import type { Task, TaskStatus } from './types.js'

/** Worker trace 索引子集，对账只关心这几个字段 */
export interface TraceIndexLite {
  trace_id: string
  related_task_id?: string
  status: 'running' | 'completed' | 'failed'
  outcome?: { summary?: string } | undefined
}

export interface ReconcileInput {
  /** admin 全部 task（pure function 不读磁盘） */
  readonly tasks: ReadonlyArray<Task>
  /** 拉单个 task 按 started_at 升序排列的所有 worker trace（注入式，便于 mock） */
  readonly fetchTracesByTaskId: (taskId: string) => Promise<ReadonlyArray<TraceIndexLite>>
  /**
   * task 多久没更新才纳入对账（防止刚 spawn 还没写 trace 的 task 被误判 stale）。
   * 默认 60s。
   */
  readonly minStaleAgeMs?: number
  /** 注入 now 便于测试 */
  readonly now?: Date
}

export interface ReconcilePatch {
  readonly taskId: string
  readonly oldStatus: TaskStatus
  readonly newStatus: 'completed' | 'failed'
  /** 触发对账修复的原因，供日志和审计 */
  readonly reason: string
  /** 涉及的 trace 状态快照 */
  readonly traces: ReadonlyArray<{
    readonly trace_id: string
    readonly status: 'running' | 'completed' | 'failed'
  }>
}

/** admin 维护的非终态状态集合（reconciliation 只考虑这些） */
const ACTIVE_STATUSES = new Set<TaskStatus>(['pending', 'planning', 'executing', 'waiting_human', 'waiting'])

/**
 * 对账主逻辑（pure function）。
 *
 * 返回 patches 列表 —— 调用方负责真正 apply（走 applyStatusTransition 路径）。
 */
export async function reconcileTasksAgainstTraces(input: ReconcileInput): Promise<ReadonlyArray<ReconcilePatch>> {
  const { tasks, fetchTracesByTaskId } = input
  const now = input.now ?? new Date()
  const minStaleAgeMs = input.minStaleAgeMs ?? 60_000
  const patches: ReconcilePatch[] = []

  for (const task of tasks) {
    if (!ACTIVE_STATUSES.has(task.status)) continue

    // 防御刚 spawn 还没写 trace 的 task：updated_at 距今 < minStaleAgeMs → 跳过
    const updatedAtMs = Date.parse(task.updated_at)
    if (Number.isFinite(updatedAtMs) && now.getTime() - updatedAtMs < minStaleAgeMs) {
      continue
    }

    // 拉 task 关联的所有 worker trace
    let workers: ReadonlyArray<TraceIndexLite>
    try {
      workers = await fetchTracesByTaskId(task.id)
    } catch {
      // 拉失败（agent 不可达 / RPC 错）就跳过本轮 —— 下轮再试
      continue
    }

    // 无 worker：可能是 task 刚建还没 spawn。保守跳过。
    if (workers.length === 0) continue

    // 任一 worker 仍 running → task 真在跑，不对账
    const anyRunning = workers.some(t => t.status === 'running')
    if (anyRunning) continue

    // 所有 worker 都终态 + task 仍活跃 → 以后启动的 worker 为权威。
    const latestWorker = workers.at(-1)
    if (!latestWorker || latestWorker.status === 'running') continue
    const newStatus = latestWorker.status

    patches.push({
      taskId: task.id,
      oldStatus: task.status,
      newStatus,
      reason: `task ${task.status} but all ${workers.length} worker trace(s) terminal ` +
        `(latest worker ${latestWorker.trace_id.slice(0, 8)}=${latestWorker.status})`,
      traces: workers.map(t => ({ trace_id: t.trace_id, status: t.status })),
    })
  }

  return patches
}
