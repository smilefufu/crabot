/**
 * v3 task 状态机：精简状态集下的合法转换表、派生字段维护。
 *
 * 协议对齐：base-protocol §5.10（TaskStatus v3 精简集）、protocol-agent-v3 §5.2（化身→task 映射）。
 * 移植参考：crabot-admin/src/task-state-machine.ts（结构参考，v3 重写）。
 */

import type { TaskStatus, LedgerWorker } from './ledger-types'
import type { WorkerContractState, IncarnationEndReason } from '../types'

/**
 * v3 状态转换表：每个状态的出边列表。
 * queued → running|cancelled
 * running → waiting_input|completed|failed|cancelled
 * waiting_input → running|completed|failed|cancelled
 * 终态（completed/failed/cancelled） → 无出边
 */
export const VALID_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ['running', 'cancelled'],
  running: ['waiting_input', 'completed', 'failed', 'cancelled'],
  waiting_input: ['running', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
} as const

const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(['completed', 'failed', 'cancelled'])

/**
 * 判断状态是否为终态。
 * 终态：completed、failed、cancelled
 */
export function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status)
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

/**
 * 应用状态转换并回填派生字段。
 *
 * 派生字段维护规则：
 * - completed_at：仅在转换至终态时回填为 now；其他情况清空
 * - error：仅在转换至 failed 时设置（opts.error）；其他情况清空
 * - outcome：按 opts.outcome 透传（如未指定则保持）
 *
 * @param task 当前 task（来自 LedgerWorker.task）
 * @param to 目标状态
 * @param opts 可选参数：{ error?, outcome?, now }
 * @returns 新的 task 对象（不修改原 task）
 * @throws InvalidTaskTransitionError 若状态转换非法
 */
export function applyStatusTransition(
  task: LedgerWorker['task'],
  to: TaskStatus,
  opts?: { error?: string; outcome?: string; now: string },
): LedgerWorker['task'] {
  const { error, outcome, now } = opts || {}

  if (!canTransition(task.status, to)) {
    throw new InvalidTaskTransitionError(task.status, to)
  }

  const next: LedgerWorker['task'] = { ...task, status: to }

  // 派生字段：updated_at（总是更新）
  if (now) {
    ;(next as any).updated_at = now
  }

  // 派生字段：completed_at（仅终态回填）
  if (isTerminalStatus(to)) {
    next.completed_at = now
  } else {
    next.completed_at = undefined
  }

  // 派生字段：error（仅 failed 时设置）
  if (to === 'failed') {
    if (error !== undefined) {
      next.error = error
    }
  } else {
    next.error = undefined
  }

  // 派生字段：outcome（按 opts 透传）
  if (outcome !== undefined) {
    next.outcome = outcome
  }

  return next
}

/**
 * 化身契约状态 → task 状态的映射。
 *
 * 规则（protocol-agent-v3 §5.2）：
 * - contractState=running → 'running'
 * - contractState=idle → waitingInput ? 'waiting_input' : 'running'
 * - contractState=exited:
 *   - endReason=completed → 'completed'
 *   - endReason=failed, crashed → 'failed'
 *   - endReason=killed → 'cancelled'
 *   - endReason=pre_migration → 'failed'
 *   - endReason=superseded → 'running'（占位值，调用方应根据新化身决定最终状态）
 *
 * 特别说明：当化身被取代（superseded）时，task 生命周期应由化身链新成员决定。
 * 本函数返回 'running' 作为占位值，调用方需读取新化身并覆盖此状态，不应单用此函数的返回值。
 *
 * @param contractState worker 当前合约状态
 * @param endReason 化身终止原因（exited 状态时必须指定）
 * @param waitingInput 是否在等待输入（idle 状态时有意义）
 * @returns 对应的 task 状态
 */
export function taskStatusFromIncarnation(
  contractState: WorkerContractState,
  endReason?: IncarnationEndReason,
  waitingInput?: boolean,
): TaskStatus {
  switch (contractState) {
    case 'running':
      return 'running'

    case 'idle':
      return waitingInput ? 'waiting_input' : 'running'

    case 'exited':
      switch (endReason) {
        case 'completed':
          return 'completed'
        case 'failed':
        case 'crashed':
          return 'failed'
        case 'killed':
          return 'cancelled'
        case 'pre_migration':
          return 'failed'
        case 'superseded':
          // 占位值：由调用方根据新化身覆盖
          return 'running'
        default:
          // 防守：如果 exited 但无 endReason，视为异常
          return 'failed'
      }

    default:
      // 协议应保证 contractState 是已知值，此分支不应到达
      return 'running'
  }
}
