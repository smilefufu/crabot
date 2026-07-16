/**
 * Task 状态机：合法状态转换表。
 *
 * 后续 task（同一 plan 内）会在本文件追加 applyDerivedFields / assertTaskInvariants
 * / repairTaskInvariants，并由 AdminModule.applyStatusTransition 统一调度。
 */

import type { Task, TaskStatus } from './types.js'
import { transitionGoalStatus } from './task-goal.js'

// pending → failed 是合法转换（兜底/异常路径会用到）。
export const VALID_TRANSITIONS: Readonly<Record<TaskStatus, ReadonlyArray<TaskStatus>>> = {
  pending: ['planning', 'failed', 'cancelled'],
  planning: ['executing', 'failed', 'cancelled'],
  executing: ['waiting_human', 'waiting', 'completed', 'failed', 'cancelled'],
  waiting_human: ['executing', 'cancelled', 'failed'],
  waiting: ['executing', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
}

const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(['completed', 'failed', 'cancelled'])

export function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

export type DerivedFieldOpts = {
  error?: string
  pendingQuestion?: string | null
}

/**
 * 应用状态变更带来的所有派生字段维护。纯函数，返回新 task。
 *
 * 调用方负责：
 * - 状态机校验（VALID_TRANSITIONS）—— AdminModule.applyStatusTransition 内做
 * - 不变量断言（assertTaskInvariants）—— 同上
 * - 事件发布、持久化 —— 同上或调用方自行
 */
export function applyDerivedFields(
  task: Task,
  newStatus: TaskStatus,
  nowISO: string,
  opts: DerivedFieldOpts = {},
): Task {
  const next: Task = { ...task, status: newStatus, updated_at: nowISO }

  if (newStatus === 'executing' && !next.started_at) {
    next.started_at = nowISO
  }

  if (isTerminalStatus(newStatus)) {
    next.completed_at = nowISO
    // 收尾清理：task 进终态时 still-active goal 无条件切 cleared——goal 生命周期闭环，
    // 防止"task 终态 + goal active"组合在后续 re-pull 时重新武装 audit gate（幽灵 audit）。
    // warn 留统计口径："未审即收尾"的实际发生率，事后 audit 是否值得做以此为据（spec §4.3）。
    // spec: 2026-07-16-wait-signal-targets-goal-lifecycle-design §4.2
    if (next.goal && next.goal.status === 'active') {
      console.warn(
        `[TaskStateMachine] task ${task.id} 切 ${newStatus} 时 goal 仍 active，自动切 cleared`
        + `（objective="${next.goal.objective.slice(0, 50)}", audit_history=${next.goal.audit_history.length} 条）`,
      )
      next.goal = transitionGoalStatus(next.goal, 'cleared', nowISO)
    }
  }

  next.waiting_human_at = newStatus === 'waiting_human' ? nowISO : undefined
  next.waiting_at = newStatus === 'waiting' ? nowISO : undefined

  // pending_question：离开 waiting_human 永远清空（旧 handleUpdateTaskStatus 仅在显式
  // 传 null 时清，是 INV-4 残留 bug 的来源）。进入 waiting_human 时调用方可覆盖
  // （opts.pendingQuestion=null 表示显式清空；undefined 表示保留 spread 带过来的旧值）。
  if (newStatus === 'waiting_human') {
    if (opts.pendingQuestion !== undefined) {
      next.pending_question = opts.pendingQuestion ?? undefined
    }
  } else {
    next.pending_question = undefined
  }

  if (opts.error !== undefined) {
    next.error = opts.error
  }

  return next
}

/**
 * 校验 task 满足派生字段不变量。违反抛错。
 *
 * 设计意图：所有走 applyStatusTransition 出来的 task 都必须 pass；
 * loadData 时 repair 后也必须 pass。pass 不掉 = repair 或派生字段
 * 实现有 bug，立刻暴露。
 */
export function assertTaskInvariants(task: Task): void {
  // INV-1: status === 'waiting_human' ⇔ waiting_human_at !== undefined
  if (task.status === 'waiting_human' && task.waiting_human_at === undefined) {
    throw new Error(`Task ${task.id}: INV-1 violated — status=waiting_human but waiting_human_at missing`)
  }
  if (task.status !== 'waiting_human' && task.waiting_human_at !== undefined) {
    throw new Error(
      `Task ${task.id}: INV-1 violated — status=${task.status} but waiting_human_at still set`,
    )
  }

  // INV-2: status === 'waiting' ⇔ waiting_at !== undefined
  if (task.status === 'waiting' && task.waiting_at === undefined) {
    throw new Error(`Task ${task.id}: INV-2 violated — status=waiting but waiting_at missing`)
  }
  if (task.status !== 'waiting' && task.waiting_at !== undefined) {
    throw new Error(`Task ${task.id}: INV-2 violated — status=${task.status} but waiting_at still set`)
  }

  // INV-3: terminal ⇒ completed_at !== undefined
  if (isTerminalStatus(task.status) && task.completed_at === undefined) {
    throw new Error(`Task ${task.id}: INV-3 violated — terminal status=${task.status} but completed_at missing`)
  }

  // INV-4: status !== 'waiting_human' ⇒ pending_question === undefined
  if (task.status !== 'waiting_human' && task.pending_question !== undefined) {
    throw new Error(
      `Task ${task.id}: INV-4 violated — status=${task.status} but pending_question still set`,
    )
  }
}

/**
 * 修正历史脏数据的派生字段不一致。loadData 启动期调用，目的：
 * 1. 治掉旧版本代码（绕过 applyStatusTransition 的 self-healing / cancel 路径）
 *    留下的 waiting_human_at / waiting_at / pending_question 残留
 * 2. 给 terminal 但缺 completed_at 的 task 回填一个时间戳（用 updated_at）
 *
 * 不会"反向修复"——比如 status=waiting_human 但缺 waiting_human_at，
 * 我们无法凭空造时间戳，留给 assertTaskInvariants 抛错。这种情况只会
 * 来自磁盘损坏或外部手工修改，应当被发现而不是默默掩盖。
 *
 * @returns task 同引用（无修改时）或新对象（有修改），fixes 列表说明修了哪些字段
 */
export function repairTaskInvariants(input: Task): { task: Task; fixes: string[] } {
  const fixes: string[] = []
  let task = input

  const fix = (field: string, mut: (t: Task) => void) => {
    if (task === input) task = { ...input }
    mut(task)
    fixes.push(field)
  }

  // INV-1 反向：清掉与 status 不符的 waiting_human_at
  if (task.status !== 'waiting_human' && task.waiting_human_at !== undefined) {
    fix('waiting_human_at', (t) => { t.waiting_human_at = undefined })
  }

  // INV-2 反向：清掉与 status 不符的 waiting_at
  if (task.status !== 'waiting' && task.waiting_at !== undefined) {
    fix('waiting_at', (t) => { t.waiting_at = undefined })
  }

  // INV-3 回填：terminal 但缺 completed_at → 用 updated_at 兜底
  if (isTerminalStatus(task.status) && task.completed_at === undefined) {
    fix('completed_at', (t) => { t.completed_at = t.updated_at })
  }

  // INV-4 反向：清掉与 status 不符的 pending_question
  if (task.status !== 'waiting_human' && task.pending_question !== undefined) {
    fix('pending_question', (t) => { t.pending_question = undefined })
  }

  // MIG-1：TaskMessage 老格式（含 type 字段）转新格式（role 字段）
  // 旧：{ id, type: 'user_input'|'agent_output'|..., content, timestamp, metadata? }
  // 新：{ id, role: 'human'|'agent', content, timestamp, source?, agent_intent? }
  // spec 2026-06-09-task-trace-tool-unification.md §4.2
  const hasLegacyMessage = task.messages.some((m) => {
    const legacy = m as unknown as { type?: unknown; role?: unknown }
    return legacy.type !== undefined && legacy.role === undefined
  })
  if (hasLegacyMessage) {
    fix('messages_legacy_role', (t) => {
      t.messages = t.messages.map((m) => {
        const legacy = m as unknown as { type?: string; role?: string }
        if (legacy.role !== undefined) return m
        return {
          id: m.id,
          // 老 type 仅 'user_input' 对应人类输入；其他全部视为 agent 输出
          role: legacy.type === 'user_input' ? 'human' : 'agent',
          content: m.content,
          timestamp: m.timestamp,
        }
      })
    })
  }

  // MIG-2：老 task.description 字段（已删）转 messages[0]（仅当 messages 为空时）
  // spec 2026-06-09-task-trace-tool-unification.md §4.2: description 已死字段，
  // 历史磁盘数据可能仍有；为不丢上下文，转成 role='human' 的 messages[0]。
  const legacyDescription = (input as unknown as { description?: unknown }).description
  if (typeof legacyDescription === 'string' && legacyDescription.length > 0 && task.messages.length === 0) {
    fix('description_to_messages', (t) => {
      t.messages = [{
        id: `legacy-desc-${t.id}`,
        role: 'human',
        content: legacyDescription,
        timestamp: t.created_at,
      }]
      // 显式删 description 字段，避免下次持久化时重新出现
      delete (t as unknown as { description?: unknown }).description
    })
  }

  return { task, fixes }
}
