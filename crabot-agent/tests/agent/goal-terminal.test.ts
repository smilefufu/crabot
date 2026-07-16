/**
 * goal 终态判定（spec 2026-07-16-wait-signal-targets-goal-lifecycle-design §2）：
 *  - shouldArmGoalGate：goal 存在且非终态才武装 audit gate
 *  - 终态集合与 crabot-admin/src/task-goal.ts 的 isTerminal 逐值对齐（防两边漂移）
 */

import { describe, it, expect } from 'vitest'
import {
  TERMINAL_GOAL_STATUSES,
  isGoalTerminal,
  shouldArmGoalGate,
  type GoalStatus,
} from '../../src/agent/goal-audit'
import { isTerminal as adminIsTerminal } from '../../../crabot-admin/src/task-goal'

describe('isGoalTerminal / TERMINAL_GOAL_STATUSES', () => {
  it('与 admin isTerminal 对每个 GoalStatus 取值一致（对齐测试）', () => {
    const all: GoalStatus[] = ['active', 'complete', 'blocked', 'budget_limited', 'cleared']
    for (const s of all) {
      expect(isGoalTerminal(s), `status=${s}`).toBe(adminIsTerminal(s))
    }
  })

  it('active 非终态，其余四态为终态', () => {
    expect(isGoalTerminal('active')).toBe(false)
    for (const s of ['complete', 'blocked', 'budget_limited', 'cleared'] as const) {
      expect(TERMINAL_GOAL_STATUSES.has(s)).toBe(true)
    }
  })
})

describe('shouldArmGoalGate', () => {
  it('goal undefined/null → false', () => {
    expect(shouldArmGoalGate(undefined)).toBe(false)
    expect(shouldArmGoalGate(null)).toBe(false)
  })

  it('goal active → true', () => {
    expect(shouldArmGoalGate({ objective: 'x', status: 'active' })).toBe(true)
  })

  it('goal 终态（complete/blocked/budget_limited/cleared）→ false', () => {
    for (const s of ['complete', 'blocked', 'budget_limited', 'cleared']) {
      expect(shouldArmGoalGate({ objective: 'x', status: s }), `status=${s}`).toBe(false)
    }
  })

  it('goal 无 status 字段（旧数据防御）→ true（视为 active）', () => {
    expect(shouldArmGoalGate({ objective: 'x' })).toBe(true)
  })
})
