/**
 * v3 task 状态机：精简状态集下的合法转换表、派生字段维护。
 *
 * 协议对齐：base-protocol §5.10（TaskStatus 4 态集，2026-08-31 修正）、
 * protocol-agent-v3 §5.2（化身→task 映射与边所有权）。
 *
 * **边所有权**（2026-08-31 修正）：worker 行为只产生事实边 `running ⇄ halted`；
 * 唯一终态 `closed` 只能由 manager/admin 处置动作产生（request_worker_stop、
 * admin 取消、迁移），worker 事件——含 builtin `finish_task` 的自报 outcome、
 * CLI 停止钩子、crash——在任何路径下都不得把 task 写到 `closed`。停因与
 * worker 自报是 `halt` evidence 标注，不进状态机。
 */

import type { TaskClosedInfo, TaskHaltEvidence, TaskStatus, LedgerWorker } from './ledger-types'

/**
 * v3 状态转换表：每个状态的出边列表。
 * queued → running | closed（未拉起即被处置）
 * running → halted | closed（manager 可从 running 直达 closed）
 * halted → running | closed（续办 / 收尾）
 * 终态（closed） → 无出边
 */
export const VALID_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ['running', 'closed'],
  running: ['halted', 'closed'],
  halted: ['running', 'closed'],
  closed: [],
} as const

const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(['closed'])

/**
 * 判断状态是否为终态。
 * 终态：closed（唯一）。
 */
export function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

/**
 * Manager 默认决策视野（恢复 v2 dispatcher 的 active-only 不变量）。
 * 工具、Admin summary、Workers 默认列表、retention 保护集必须共用本函数。
 */
export function isDecisionVisibleWorker(status: TaskStatus): boolean {
  return !isTerminalStatus(status)
}

/**
 * 检查两个状态之间是否允许转换。
 */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to)
}

/**
 * 非法转换错误。包含 from/to 字段供调用方诊断。
 */
export class InvalidTaskTransitionError extends Error {
  readonly from: TaskStatus
  readonly to: TaskStatus

  constructor(from: TaskStatus, to: TaskStatus) {
    super(`Invalid task transition: ${from} → ${to}`)
    this.from = from
    this.to = to
    this.name = 'InvalidTaskTransitionError'
    Object.setPrototypeOf(this, InvalidTaskTransitionError.prototype)
  }
}

export interface StatusTransitionOpts {
  now: string
  /** to='halted' 时必填——进入事实状态必须携带事实记录。 */
  halt?: TaskHaltEvidence
  /** to='closed' 时必填——终态必须可回答"谁、何时关的"。 */
  closed?: Omit<TaskClosedInfo, 'at'>
}

/**
 * 应用状态转换并回填派生字段。
 *
 * 派生字段维护规则（task 子对象内）：
 * - halt：进入 halted 时必须由 opts.halt 提供；halted→running（续办）时清除——
 *   evidence 属于"当前这次停止"，续办即复位；
 * - closed：进入 closed 时由 opts.closed 提供（at 由 now 回填）；closed 无出边，
 *   不存在离开时的清理问题；
 * - 语义边界：updated_at 是 LedgerWorker（父级）的字段，不是 task 子对象的字段。
 *   维护职责归调用方（harness 在 upsertWorker 时设 LedgerWorker.updated_at）。
 *
 * @param task 当前 task（来自 LedgerWorker.task）
 * @param to 目标状态
 * @throws InvalidTaskTransitionError 若状态转换非法，或 halted/closed 缺少必填标注
 */
export function applyStatusTransition(
  task: LedgerWorker['task'],
  to: TaskStatus,
  opts?: StatusTransitionOpts,
): LedgerWorker['task'] {
  const { now, halt, closed } = opts || {}

  if (!canTransition(task.status, to)) {
    throw new InvalidTaskTransitionError(task.status, to)
  }

  const next: LedgerWorker['task'] = { ...task, status: to }

  if (to === 'halted') {
    if (!halt || !now) throw new InvalidTaskTransitionError(task.status, to)
    next.halt = halt
  } else if (task.status === 'halted') {
    next.halt = undefined
  }

  if (to === 'closed') {
    if (!closed || !now) throw new InvalidTaskTransitionError(task.status, to)
    next.closed = { at: now, ...closed }
  }

  return next
}
