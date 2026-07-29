import { describe, it, expect } from 'vitest'
import {
  VALID_TRANSITIONS,
  isTerminalStatus,
  canTransition,
  applyStatusTransition,
  InvalidTaskTransitionError,
  taskStatusFromIncarnation,
} from '../../../src/workers/harness/task-status'
import type { TaskStatus } from '../../../src/workers/harness/ledger-types'
import type { WorkerContractState, IncarnationEndReason } from '../../src/workers/types'

describe('v3 task 状态机', () => {
  describe('VALID_TRANSITIONS', () => {
    it('应定义所有 6 个状态', () => {
      const states: TaskStatus[] = ['queued', 'running', 'waiting_input', 'completed', 'failed', 'cancelled']
      states.forEach((s) => {
        expect(VALID_TRANSITIONS).toHaveProperty(s)
        expect(Array.isArray(VALID_TRANSITIONS[s])).toBe(true)
      })
    })

    it('queued 可转换至 running 和 cancelled', () => {
      const allowed = VALID_TRANSITIONS.queued
      expect(allowed).toContain('running')
      expect(allowed).toContain('cancelled')
      expect(allowed).not.toContain('waiting_input')
      expect(allowed).not.toContain('completed')
      expect(allowed).not.toContain('failed')
    })

    it('running 可转换至 waiting_input, completed, failed, cancelled', () => {
      const allowed = VALID_TRANSITIONS.running
      expect(allowed).toContain('waiting_input')
      expect(allowed).toContain('completed')
      expect(allowed).toContain('failed')
      expect(allowed).toContain('cancelled')
      expect(allowed).not.toContain('queued')
    })

    it('waiting_input 可转换至 running, completed, failed, cancelled', () => {
      const allowed = VALID_TRANSITIONS.waiting_input
      expect(allowed).toContain('running')
      expect(allowed).toContain('completed')
      expect(allowed).toContain('failed')
      expect(allowed).toContain('cancelled')
      expect(allowed).not.toContain('queued')
    })

    it('终态 completed, failed, cancelled 无出边', () => {
      expect(VALID_TRANSITIONS.completed).toEqual([])
      expect(VALID_TRANSITIONS.failed).toEqual([])
      expect(VALID_TRANSITIONS.cancelled).toEqual([])
    })
  })

  describe('isTerminalStatus', () => {
    it('completed, failed, cancelled 是终态', () => {
      expect(isTerminalStatus('completed')).toBe(true)
      expect(isTerminalStatus('failed')).toBe(true)
      expect(isTerminalStatus('cancelled')).toBe(true)
    })

    it('queued, running, waiting_input 非终态', () => {
      expect(isTerminalStatus('queued')).toBe(false)
      expect(isTerminalStatus('running')).toBe(false)
      expect(isTerminalStatus('waiting_input')).toBe(false)
    })
  })

  describe('canTransition', () => {
    it('合法迁移返回 true', () => {
      expect(canTransition('queued', 'running')).toBe(true)
      expect(canTransition('running', 'waiting_input')).toBe(true)
      expect(canTransition('waiting_input', 'completed')).toBe(true)
    })

    it('非法迁移返回 false', () => {
      expect(canTransition('queued', 'waiting_input')).toBe(false)
      expect(canTransition('completed', 'running')).toBe(false)
      expect(canTransition('failed', 'cancelled')).toBe(false)
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

    it('合法迁移应成功', () => {
      const task = applyStatusTransition(baseTask, 'running', { now })
      expect(task.status).toBe('running')
      expect(task.updated_at).toBe(now)
      expect(task.completed_at).toBeUndefined()
    })

    it('非法迁移应抛 InvalidTaskTransitionError 并含 from/to 字段', () => {
      expect(() => {
        applyStatusTransition(baseTask, 'waiting_input', { now })
      }).toThrow(InvalidTaskTransitionError)

      try {
        applyStatusTransition(baseTask, 'waiting_input', { now })
      } catch (e) {
        const err = e as InvalidTaskTransitionError
        expect(err.from).toBe('queued')
        expect(err.to).toBe('waiting_input')
      }
    })

    it('终态迁移应回填 completed_at', () => {
      const runningTask = { ...baseTask, status: 'running' as TaskStatus }
      const task = applyStatusTransition(runningTask, 'completed', { now })
      expect(task.status).toBe('completed')
      expect(task.completed_at).toBe(now)
    })

    it('失败迁移应设置 error 字段', () => {
      const runningTask = { ...baseTask, status: 'running' as TaskStatus }
      const task = applyStatusTransition(runningTask, 'failed', { now, error: 'Connection timeout' })
      expect(task.status).toBe('failed')
      expect(task.error).toBe('Connection timeout')
      expect(task.completed_at).toBe(now)
    })

    it('outcome 应透传', () => {
      const runningTask = { ...baseTask, status: 'running' as TaskStatus }
      const task = applyStatusTransition(runningTask, 'completed', { now, outcome: 'Success' })
      expect(task.outcome).toBe('Success')
    })

    it('返回新对象不改变原 task', () => {
      const original = { ...baseTask }
      const task = applyStatusTransition(baseTask, 'running', { now })
      expect(baseTask).toEqual(original)
      expect(task).not.toBe(baseTask)
    })

    it('非失败迁移时 error 应被清空', () => {
      const runningTask = { ...baseTask, status: 'running' as TaskStatus, error: 'Old error' }
      const task = applyStatusTransition(runningTask, 'completed', { now })
      expect(task.error).toBeUndefined()
    })

    it('终态之间的迁移应失败', () => {
      const completedTask = { ...baseTask, status: 'completed' as TaskStatus }
      expect(() => {
        applyStatusTransition(completedTask, 'failed', { now })
      }).toThrow(InvalidTaskTransitionError)
    })
  })

  describe('taskStatusFromIncarnation', () => {
    describe('contractState=running', () => {
      it('应返回 running', () => {
        const status = taskStatusFromIncarnation('running')
        expect(status).toBe('running')
      })

      it('endReason 和 waitingInput 应被忽略', () => {
        expect(taskStatusFromIncarnation('running', 'completed')).toBe('running')
        expect(taskStatusFromIncarnation('running', 'failed', true)).toBe('running')
      })
    })

    describe('contractState=idle', () => {
      it('waitingInput=true 应返回 waiting_input', () => {
        const status = taskStatusFromIncarnation('idle', undefined, true)
        expect(status).toBe('waiting_input')
      })

      it('waitingInput=false 或 undefined 应返回 running', () => {
        expect(taskStatusFromIncarnation('idle', undefined, false)).toBe('running')
        expect(taskStatusFromIncarnation('idle')).toBe('running')
      })
    })

    describe('contractState=exited', () => {
      it('endReason=completed 应返回 completed', () => {
        const status = taskStatusFromIncarnation('exited', 'completed')
        expect(status).toBe('completed')
      })

      it('endReason=failed 应返回 failed', () => {
        const status = taskStatusFromIncarnation('exited', 'failed')
        expect(status).toBe('failed')
      })

      it('endReason=crashed 应返回 failed', () => {
        const status = taskStatusFromIncarnation('exited', 'crashed')
        expect(status).toBe('failed')
      })

      it('endReason=killed 应返回 cancelled', () => {
        const status = taskStatusFromIncarnation('exited', 'killed')
        expect(status).toBe('cancelled')
      })

      it('endReason=pre_migration 应返回 failed', () => {
        const status = taskStatusFromIncarnation('exited', 'pre_migration')
        expect(status).toBe('failed')
      })

      it('endReason=superseded 应返回 running（由调用方覆盖化身链新成员决定）', () => {
        // 当化身被取代时，task 生命周期应由新化身决定，不由本函数决定
        // 因此返回 running 作为占位值，调用方会读新化身并覆盖此状态
        const status = taskStatusFromIncarnation('exited', 'superseded')
        expect(status).toBe('running')
      })
    })

    it('6 种 endReason + idle 的 waitingInput 两态全覆盖', () => {
      // 6 种 endReason
      const endReasons: IncarnationEndReason[] = ['completed', 'failed', 'killed', 'superseded', 'crashed', 'pre_migration']
      endReasons.forEach((reason) => {
        expect(() => {
          taskStatusFromIncarnation('exited', reason)
        }).not.toThrow()
      })

      // idle 的 waitingInput 两态
      expect(() => {
        taskStatusFromIncarnation('idle', undefined, true)
      }).not.toThrow()
      expect(() => {
        taskStatusFromIncarnation('idle', undefined, false)
      }).not.toThrow()
    })
  })

  describe('迁移矩阵完整性检验', () => {
    const states: TaskStatus[] = ['queued', 'running', 'waiting_input', 'completed', 'failed', 'cancelled']

    it('6 状态两两组合 36 对，合法的按 VALID_TRANSITIONS，其余全 false', () => {
      for (const from of states) {
        for (const to of states) {
          const expected = VALID_TRANSITIONS[from].includes(to)
          const actual = canTransition(from, to)
          expect(actual).toBe(expected, `canTransition(${from}, ${to}) 应返回 ${expected}`)
        }
      }
    })

    it('终态无出边（自迁移也不行）', () => {
      const terminalStates: TaskStatus[] = ['completed', 'failed', 'cancelled']
      terminalStates.forEach((s) => {
        expect(VALID_TRANSITIONS[s].length).toBe(0)
        states.forEach((to) => {
          expect(canTransition(s, to)).toBe(false, `${s} 不能转换至 ${to}`)
        })
      })
    })
  })

  describe('InvalidTaskTransitionError', () => {
    it('应是 Error 的子类', () => {
      const err = new InvalidTaskTransitionError('queued', 'waiting_input')
      expect(err).toBeInstanceOf(Error)
    })

    it('应含 from 和 to 字段', () => {
      const err = new InvalidTaskTransitionError('queued', 'waiting_input')
      expect(err.from).toBe('queued')
      expect(err.to).toBe('waiting_input')
    })

    it('message 应包含 from 和 to 状态', () => {
      const err = new InvalidTaskTransitionError('queued', 'waiting_input')
      expect(err.message).toContain('queued')
      expect(err.message).toContain('waiting_input')
    })
  })
})
