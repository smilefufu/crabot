import { describe, it, expect } from 'vitest'
import {
  VALID_TRANSITIONS,
  isTerminalStatus,
  canTransition,
  applyStatusTransition,
  isDecisionVisibleWorker,
  InvalidTaskTransitionError,
} from '../../../src/workers/harness/task-status'
import type { TaskStatus } from '../../../src/workers/harness/ledger-types'

describe('v3 task 状态机（2026-08-31 4 态修正）', () => {
  describe('VALID_TRANSITIONS', () => {
    it('应定义所有 4 个状态', () => {
      const states: TaskStatus[] = ['queued', 'running', 'halted', 'closed']
      states.forEach((s) => {
        expect(VALID_TRANSITIONS).toHaveProperty(s)
        expect(Array.isArray(VALID_TRANSITIONS[s])).toBe(true)
      })
    })

    it('queued 可转换至 running 和 closed', () => {
      const allowed = VALID_TRANSITIONS.queued
      expect(allowed).toContain('running')
      expect(allowed).toContain('closed')
      expect(allowed).not.toContain('halted')
    })

    it('running 可转换至 halted 和 closed', () => {
      const allowed = VALID_TRANSITIONS.running
      expect(allowed).toContain('halted')
      expect(allowed).toContain('closed')
      expect(allowed).not.toContain('queued')
    })

    it('halted 可转换至 running 和 closed', () => {
      const allowed = VALID_TRANSITIONS.halted
      expect(allowed).toContain('running')
      expect(allowed).toContain('closed')
      expect(allowed).not.toContain('queued')
    })
  })

  describe('isTerminalStatus', () => {
    it('closed 是唯一终态', () => {
      expect(isTerminalStatus('closed')).toBe(true)
      expect(isTerminalStatus('queued')).toBe(false)
      expect(isTerminalStatus('running')).toBe(false)
      expect(isTerminalStatus('halted')).toBe(false)
    })
  })

  describe('isDecisionVisibleWorker', () => {
    it('非终态可见，closed 不可见', () => {
      expect(isDecisionVisibleWorker('queued')).toBe(true)
      expect(isDecisionVisibleWorker('running')).toBe(true)
      expect(isDecisionVisibleWorker('halted')).toBe(true)
      expect(isDecisionVisibleWorker('closed')).toBe(false)
    })
  })

  describe('canTransition', () => {
    it('合法迁移返回 true', () => {
      expect(canTransition('queued', 'running')).toBe(true)
      expect(canTransition('running', 'halted')).toBe(true)
      expect(canTransition('halted', 'running')).toBe(true)
      expect(canTransition('running', 'closed')).toBe(true)
      expect(canTransition('halted', 'closed')).toBe(true)
      expect(canTransition('queued', 'closed')).toBe(true)
    })

    it('非法迁移返回 false', () => {
      expect(canTransition('queued', 'halted')).toBe(false)
      expect(canTransition('closed', 'running')).toBe(false)
      expect(canTransition('closed', 'halted')).toBe(false)
      expect(canTransition('halted', 'queued')).toBe(false)
    })
  })

  describe('applyStatusTransition', () => {
    const baseTask = {
      id: 'task-1',
      title: 'Test Task',
      status: 'queued' as TaskStatus,
      created_at: '2026-07-28T00:00:00Z',
    }
    const now = '2026-07-28T12:00:00Z'
    const halt = {
      halted_at: now,
      halt_reason: 'turn_end' as const,
    }

    it('合法迁移应成功', () => {
      const task = applyStatusTransition(baseTask, 'running', { now })
      expect(task.status).toBe('running')
      expect(task.updated_at).toBeUndefined()
      expect(task.halt).toBeUndefined()
    })

    it('非法迁移应抛 InvalidTaskTransitionError 并含 from/to 字段', () => {
      expect(() => {
        applyStatusTransition(baseTask, 'halted', { now, halt })
      }).toThrow(InvalidTaskTransitionError)

      try {
        applyStatusTransition(baseTask, 'halted', { now, halt })
      } catch (e) {
        const err = e as InvalidTaskTransitionError
        expect(err.from).toBe('queued')
        expect(err.to).toBe('halted')
      }
    })

    it('进入 halted 必须携带 halt evidence，缺失即抛错', () => {
      const runningTask = { ...baseTask, status: 'running' as TaskStatus }
      expect(() => {
        applyStatusTransition(runningTask, 'halted', { now })
      }).toThrow(InvalidTaskTransitionError)

      const task = applyStatusTransition(runningTask, 'halted', { now, halt })
      expect(task.status).toBe('halted')
      expect(task.halt).toEqual(halt)
    })

    it('halted→running 续办应清除 halt evidence', () => {
      const haltedTask = {
        ...baseTask,
        status: 'halted' as TaskStatus,
        halt: { ...halt, worker_self_report: { outcome: 'completed' as const, summary: '自报完成' } },
      }
      const task = applyStatusTransition(haltedTask, 'running', { now })
      expect(task.status).toBe('running')
      expect(task.halt).toBeUndefined()
    })

    it('进入 closed 必须携带关闭信息，缺失即抛错；at 由 now 回填', () => {
      const runningTask = { ...baseTask, status: 'running' as TaskStatus }
      expect(() => {
        applyStatusTransition(runningTask, 'closed', { now })
      }).toThrow(InvalidTaskTransitionError)

      const task = applyStatusTransition(runningTask, 'closed', {
        now,
        closed: { by: 'manager_stop' },
      })
      expect(task.status).toBe('closed')
      expect(task.closed).toEqual({ at: now, by: 'manager_stop' })
    })

    it('closed 可带备注', () => {
      const runningTask = { ...baseTask, status: 'running' as TaskStatus }
      const task = applyStatusTransition(runningTask, 'closed', {
        now,
        closed: { by: 'migration', note: '旧值 completed' },
      })
      expect(task.closed?.note).toBe('旧值 completed')
    })

    it('返回新对象不改变原 task', () => {
      const original = { ...baseTask }
      const task = applyStatusTransition(baseTask, 'running', { now })
      expect(baseTask).toEqual(original)
      expect(task).not.toBe(baseTask)
    })

    it('closed 是唯一终态，无出边（自迁移也不行）', () => {
      const closedTask = {
        ...baseTask,
        status: 'closed' as TaskStatus,
        closed: { at: now, by: 'manager_stop' as const },
      }
      const states: TaskStatus[] = ['queued', 'running', 'halted', 'closed']
      states.forEach((to) => {
        expect(() => {
          applyStatusTransition(closedTask, to, { now, halt, closed: { by: 'admin' } })
        }).toThrow(InvalidTaskTransitionError)
      })
    })
  })

  describe('迁移矩阵完整性检验', () => {
    const states: TaskStatus[] = ['queued', 'running', 'halted', 'closed']

    it('4 状态两两组合 16 对，合法的按 VALID_TRANSITIONS，其余全 false', () => {
      for (const from of states) {
        for (const to of states) {
          const expected = VALID_TRANSITIONS[from].includes(to)
          const actual = canTransition(from, to)
          expect(actual).toBe(expected, `canTransition(${from}, ${to}) 应返回 ${expected}`)
        }
      }
    })

    it('终态无出边（自迁移也不行）', () => {
      expect(VALID_TRANSITIONS.closed.length).toBe(0)
      states.forEach((to) => {
        expect(canTransition('closed', to)).toBe(false, `closed 不能转换至 ${to}`)
      })
    })
  })

  describe('InvalidTaskTransitionError', () => {
    it('应是 Error 的子类', () => {
      const err = new InvalidTaskTransitionError('queued', 'halted')
      expect(err).toBeInstanceOf(Error)
    })

    it('应含 from 和 to 字段', () => {
      const err = new InvalidTaskTransitionError('queued', 'halted')
      expect(err.from).toBe('queued')
      expect(err.to).toBe('halted')
    })

    it('message 应包含 from 和 to 状态', () => {
      const err = new InvalidTaskTransitionError('queued', 'halted')
      expect(err.message).toContain('queued')
      expect(err.message).toContain('halted')
    })
  })
})
