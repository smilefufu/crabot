import { describe, it, expect } from 'vitest'
import { VALID_TRANSITIONS, applyDerivedFields, assertTaskInvariants, repairTaskInvariants } from './task-state-machine.js'
import type { Task, TaskStatus } from './types.js'

describe('VALID_TRANSITIONS', () => {
  it('allows pending → failed (admin restart cleanup path)', () => {
    expect(VALID_TRANSITIONS.pending).toContain('failed')
  })

  it('allows pending → planning / cancelled / failed', () => {
    expect(VALID_TRANSITIONS.pending).toEqual(
      expect.arrayContaining(['planning', 'cancelled', 'failed'])
    )
  })

  it('allows waiting_human → executing / cancelled / failed', () => {
    expect(VALID_TRANSITIONS.waiting_human).toEqual(
      expect.arrayContaining(['executing', 'cancelled', 'failed'])
    )
  })

  it('forbids any transition from terminal states', () => {
    expect(VALID_TRANSITIONS.completed).toEqual([])
    expect(VALID_TRANSITIONS.failed).toEqual([])
    expect(VALID_TRANSITIONS.cancelled).toEqual([])
  })
})

function fakeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-x',
    status: 'pending',
    priority: 'normal',
    title: 't',
    source: { trigger_type: 'manual', origin: 'human' },
    messages: [],
    tags: [],
    created_at: '2026-05-07T01:00:00.000Z',
    updated_at: '2026-05-07T01:00:00.000Z',
    ...overrides,
  }
}

const NOW = '2026-06-05T10:00:00.000Z'

describe('applyDerivedFields', () => {
  it('sets status and updated_at', () => {
    const next = applyDerivedFields(fakeTask({ status: 'planning' }), 'executing', NOW)
    expect(next.status).toBe('executing')
    expect(next.updated_at).toBe(NOW)
  })

  it('sets started_at on first entry to executing', () => {
    const next = applyDerivedFields(fakeTask({ status: 'planning' }), 'executing', NOW)
    expect(next.started_at).toBe(NOW)
  })

  it('preserves started_at on re-entry to executing', () => {
    const earlier = '2026-06-04T00:00:00.000Z'
    const next = applyDerivedFields(
      fakeTask({ status: 'waiting_human', started_at: earlier, waiting_human_at: '2026-06-04T01:00:00.000Z' }),
      'executing',
      NOW,
    )
    expect(next.started_at).toBe(earlier)
  })

  it('sets completed_at on entering terminal state', () => {
    for (const s of ['completed', 'failed', 'cancelled'] as const) {
      const next = applyDerivedFields(fakeTask({ status: 'executing', started_at: NOW }), s, NOW)
      expect(next.completed_at).toBe(NOW)
    }
  })

  // spec 2026-07-16-wait-signal-targets-goal-lifecycle-design §4.2：
  // task 切终态时 still-active goal 无条件切 cleared（收尾清理），goal 生命周期闭环。
  describe('terminal transition 收尾清理 active goal（spec 2026-07-16 §4.2）', () => {
    const activeGoal = () => ({
      objective: '验证 X',
      acceptance_criteria: [{ id: 'c1', kind: 'semantic' as const, spec: '完成 X' }],
      status: 'active' as const,
      tokens_used: 0,
      audit_history: [],
      created_at: NOW,
      updated_at: NOW,
    })

    it('切终态（completed/failed/cancelled）时 active goal → cleared + completed_at', () => {
      for (const s of ['completed', 'failed', 'cancelled'] as const) {
        const next = applyDerivedFields(
          fakeTask({ status: 'executing', started_at: NOW, goal: activeGoal() }),
          s, NOW,
        )
        expect(next.goal?.status, `task→${s}`).toBe('cleared')
        expect(next.goal?.completed_at, `task→${s}`).toBe(NOW)
      }
    })

    it('goal 已终态（complete）→ 原样保留不动', () => {
      const goal = { ...activeGoal(), status: 'complete' as const, completed_at: NOW }
      const next = applyDerivedFields(
        fakeTask({ status: 'executing', started_at: NOW, goal }),
        'completed', NOW,
      )
      expect(next.goal?.status).toBe('complete')
    })

    it('非终态迁移不碰 goal', () => {
      const next = applyDerivedFields(
        fakeTask({ status: 'executing', started_at: NOW, goal: activeGoal() }),
        'waiting', NOW,
      )
      expect(next.goal?.status).toBe('active')
    })

    it('无 goal 的 task 切终态不受影响', () => {
      const next = applyDerivedFields(fakeTask({ status: 'executing', started_at: NOW }), 'completed', NOW)
      expect(next.goal).toBeUndefined()
    })
  })

  it('sets waiting_human_at on enter, clears on leave', () => {
    const entering = applyDerivedFields(fakeTask({ status: 'executing' }), 'waiting_human', NOW)
    expect(entering.waiting_human_at).toBe(NOW)

    const leaving = applyDerivedFields(
      fakeTask({ status: 'waiting_human', waiting_human_at: '2026-06-04T00:00:00.000Z' }),
      'executing',
      NOW,
    )
    expect(leaving.waiting_human_at).toBeUndefined()

    const leavingToFailed = applyDerivedFields(
      fakeTask({ status: 'waiting_human', waiting_human_at: '2026-06-04T00:00:00.000Z' }),
      'failed',
      NOW,
    )
    expect(leavingToFailed.waiting_human_at).toBeUndefined()
  })

  it('sets waiting_at on enter, clears on leave', () => {
    const entering = applyDerivedFields(fakeTask({ status: 'executing' }), 'waiting', NOW)
    expect(entering.waiting_at).toBe(NOW)

    const leaving = applyDerivedFields(
      fakeTask({ status: 'waiting', waiting_at: '2026-06-04T00:00:00.000Z' }),
      'executing',
      NOW,
    )
    expect(leaving.waiting_at).toBeUndefined()
  })

  it('writes pending_question on entering waiting_human (when provided)', () => {
    const next = applyDerivedFields(
      fakeTask({ status: 'executing' }),
      'waiting_human',
      NOW,
      { pendingQuestion: '需要 root 密码吗？' },
    )
    expect(next.pending_question).toBe('需要 root 密码吗？')
  })

  it('preserves pending_question on entering waiting_human when not provided', () => {
    // 现有语义：覆盖式但仅在传值时；不传则保留旧值（极少触发，保险起见保留）
    const next = applyDerivedFields(
      fakeTask({ status: 'executing', pending_question: 'old q' }),
      'waiting_human',
      NOW,
    )
    expect(next.pending_question).toBe('old q')
  })

  it('clears pending_question on leaving waiting_human (any direction)', () => {
    for (const target of ['executing', 'cancelled', 'failed'] as const) {
      const next = applyDerivedFields(
        fakeTask({ status: 'waiting_human', waiting_human_at: NOW, pending_question: 'q?' }),
        target,
        NOW,
      )
      expect(next.pending_question).toBeUndefined()
    }
  })

  it('clears pending_question if opts.pendingQuestion === null even when entering waiting_human', () => {
    const next = applyDerivedFields(
      fakeTask({ status: 'executing', pending_question: 'leftover' }),
      'waiting_human',
      NOW,
      { pendingQuestion: null },
    )
    expect(next.pending_question).toBeUndefined()
  })

  it('sets error from opts when provided', () => {
    const next = applyDerivedFields(fakeTask({ status: 'executing' }), 'failed', NOW, { error: 'oom' })
    expect(next.error).toBe('oom')
  })

  it('preserves existing error when opts.error not provided', () => {
    const next = applyDerivedFields(
      fakeTask({ status: 'executing', error: 'preexisting' }),
      'failed',
      NOW,
    )
    expect(next.error).toBe('preexisting')
  })

  it('does not mutate input task', () => {
    const input = fakeTask({ status: 'waiting_human', waiting_human_at: '2026-06-04T00:00:00.000Z' })
    applyDerivedFields(input, 'failed', NOW)
    expect(input.status).toBe('waiting_human')
    expect(input.waiting_human_at).toBe('2026-06-04T00:00:00.000Z')
  })

  it('output of applyDerivedFields always passes assertTaskInvariants (property check)', () => {
    // 关键不变量：派生字段维护与不变量定义必须保持同步——任何 transition 出来的 task 都该过 assert。
    // 此测试覆盖 VALID_TRANSITIONS 中所有合法转换，预先打造 from 状态需要的字段（避免输入态违规）。
    const seed = (from: TaskStatus): Task => {
      const base = fakeTask({ status: from })
      if (from === 'waiting_human') return { ...base, waiting_human_at: '2026-06-04T00:00:00.000Z' }
      if (from === 'waiting') return { ...base, waiting_at: '2026-06-04T00:00:00.000Z' }
      if (from === 'completed' || from === 'failed' || from === 'cancelled') {
        return { ...base, completed_at: '2026-06-04T00:00:00.000Z' }
      }
      return base
    }
    for (const [from, allowed] of Object.entries(VALID_TRANSITIONS) as Array<[TaskStatus, ReadonlyArray<TaskStatus>]>) {
      for (const to of allowed) {
        const next = applyDerivedFields(seed(from), to, NOW)
        expect(() => assertTaskInvariants(next), `transition ${from} → ${to}`).not.toThrow()
      }
    }
  })
})

describe('assertTaskInvariants', () => {
  it('passes for a clean waiting_human task', () => {
    const t = fakeTask({ status: 'waiting_human', waiting_human_at: NOW })
    expect(() => assertTaskInvariants(t)).not.toThrow()
  })

  it('INV-1: throws when status=waiting_human but waiting_human_at missing', () => {
    const t = fakeTask({ status: 'waiting_human' })
    expect(() => assertTaskInvariants(t)).toThrow(/waiting_human_at/)
  })

  it('INV-1: throws when status≠waiting_human but waiting_human_at present', () => {
    const t = fakeTask({ status: 'failed', completed_at: NOW, waiting_human_at: NOW })
    expect(() => assertTaskInvariants(t)).toThrow(/waiting_human_at/)
  })

  it('INV-2: throws when status=waiting but waiting_at missing', () => {
    const t = fakeTask({ status: 'waiting' })
    expect(() => assertTaskInvariants(t)).toThrow(/waiting_at/)
  })

  it('INV-2: throws when status≠waiting but waiting_at present', () => {
    const t = fakeTask({ status: 'executing', waiting_at: NOW })
    expect(() => assertTaskInvariants(t)).toThrow(/waiting_at/)
  })

  it('INV-3: throws when terminal status missing completed_at', () => {
    for (const s of ['completed', 'failed', 'cancelled'] as const) {
      const t = fakeTask({ status: s })
      expect(() => assertTaskInvariants(t)).toThrow(/completed_at/)
    }
  })

  it('INV-4: throws when non-waiting_human status carries pending_question', () => {
    const t = fakeTask({ status: 'executing', pending_question: 'leftover' })
    expect(() => assertTaskInvariants(t)).toThrow(/pending_question/)
  })

  it('passes for clean terminal task without pending_question', () => {
    const t = fakeTask({ status: 'failed', completed_at: NOW, error: 'oom' })
    expect(() => assertTaskInvariants(t)).not.toThrow()
  })
})

describe('repairTaskInvariants', () => {
  it('returns original task and empty fixes when already clean', () => {
    const t = fakeTask({ status: 'waiting_human', waiting_human_at: NOW })
    const { task, fixes } = repairTaskInvariants(t)
    expect(fixes).toEqual([])
    expect(task).toBe(t)  // 同引用，不复制
  })

  it('clears stale waiting_human_at on non-waiting_human task', () => {
    const t = fakeTask({
      status: 'failed',
      completed_at: NOW,
      waiting_human_at: '2026-06-04T07:42:39.399Z',
      error: 'agent_restarted_during_execution',
    })
    const { task, fixes } = repairTaskInvariants(t)
    expect(task.waiting_human_at).toBeUndefined()
    expect(fixes).toContain('waiting_human_at')
  })

  it('clears stale waiting_at on non-waiting task', () => {
    const t = fakeTask({ status: 'completed', completed_at: NOW, waiting_at: '2026-06-03T00:00:00.000Z' })
    const { task, fixes } = repairTaskInvariants(t)
    expect(task.waiting_at).toBeUndefined()
    expect(fixes).toContain('waiting_at')
  })

  it('clears stale pending_question on non-waiting_human task', () => {
    const t = fakeTask({ status: 'cancelled', completed_at: NOW, pending_question: 'q?' })
    const { task, fixes } = repairTaskInvariants(t)
    expect(task.pending_question).toBeUndefined()
    expect(fixes).toContain('pending_question')
  })

  it('back-fills completed_at on terminal task missing it', () => {
    const t = fakeTask({ status: 'failed', updated_at: '2026-06-04T07:42:39.399Z' })
    const { task, fixes } = repairTaskInvariants(t)
    expect(task.completed_at).toBe('2026-06-04T07:42:39.399Z')
    expect(fixes).toContain('completed_at')
  })

  it('repaired task passes assertTaskInvariants', () => {
    const dirty = fakeTask({
      status: 'failed',
      completed_at: NOW,
      waiting_human_at: '2026-06-04T07:42:39.399Z',
      pending_question: 'q?',
    })
    const { task } = repairTaskInvariants(dirty)
    expect(() => assertTaskInvariants(task)).not.toThrow()
  })

  it('does not "repair" waiting_human task with missing waiting_human_at (can\'t invent timestamp)', () => {
    // 不能凭空造 waiting_human_at；这种情况留给 assert 抛错，靠手工或重启 cleanup 收尾
    const t = fakeTask({ status: 'waiting_human' })
    const { task, fixes } = repairTaskInvariants(t)
    expect(task.waiting_human_at).toBeUndefined()
    expect(fixes).toEqual([])
    expect(() => assertTaskInvariants(task)).toThrow()
  })
})
