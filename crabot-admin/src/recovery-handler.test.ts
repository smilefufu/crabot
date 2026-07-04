import { describe, it, expect } from 'vitest'
import { buildRecoveryTask, isResumableInflightStatus, partitionResumeResults } from './recovery-handler.js'
import type { Task, TaskStatus } from './types.js'

function fakeTask(overrides: Partial<Task>): Task {
  return {
    id: 'task-x',
    status: 'executing',
    priority: 'normal',
    title: 't',
    source: { trigger_type: 'manual', origin: 'human' },
    messages: [],
    tags: [],
    created_at: '2026-05-07T01:00:00.000Z',
    updated_at: '2026-05-07T01:00:00.000Z',
    started_at: '2026-05-07T01:00:00.000Z',
    ...overrides,
  }
}

describe('buildRecoveryTask', () => {
  it('returns null when no in-flight tasks', () => {
    const r = buildRecoveryTask([], '2026-05-07T01:30:00.000Z')
    expect(r).toBeNull()
  })

  it('skips recovery tasks themselves to avoid avalanche', () => {
    const tasks = [
      fakeTask({ id: 'a', tags: ['recovery'] }),
      fakeTask({ id: 'b', tags: ['recovery'] }),
    ]
    const r = buildRecoveryTask(tasks, '2026-05-07T01:30:00.000Z')
    expect(r).toBeNull()
  })

  it('builds a CreateTaskParams when there are non-recovery in-flight tasks', () => {
    const tasks = [
      fakeTask({ id: 'aaa', title: 'first task' }),
      fakeTask({ id: 'bbb', title: 'second', tags: ['recovery'] }), // 跳过
      fakeTask({ id: 'ccc', title: 'third task' }),
    ]
    const r = buildRecoveryTask(tasks, '2026-05-07T01:30:00.000Z')
    expect(r).not.toBeNull()
    expect(r!.tags).toEqual(['recovery'])
    expect(r!.priority).toBe('high')
    expect(r!.source.origin).toBe('system')
    expect(r!.source.trigger_type).toBe('auto')
    expect(r!.title).toContain('2 条')
    expect(r!.initial_message?.content).toContain('aaa')
    expect(r!.initial_message?.content).toContain('first task')
    expect(r!.initial_message?.content).toContain('ccc')
    expect(r!.initial_message?.content).toContain('third task')
    expect(r!.initial_message?.content).not.toContain('bbb') // 防雪崩
  })
})

describe('isResumableInflightStatus', () => {
  // 任何重启后这些状态的任务都可能落过 resume checkpoint，须尝试 resume
  it('treats executing / planning / waiting / waiting_human as resumable', () => {
    expect(isResumableInflightStatus('executing')).toBe(true)
    expect(isResumableInflightStatus('planning')).toBe(true)
    expect(isResumableInflightStatus('waiting')).toBe(true)
    expect(isResumableInflightStatus('waiting_human')).toBe(true)
  })

  // pending 还没被 worker 接走、无 checkpoint，留待重新调度；终态本就不该动
  it('leaves pending / terminal states out (no checkpoint)', () => {
    expect(isResumableInflightStatus('pending')).toBe(false)
    expect(isResumableInflightStatus('completed')).toBe(false)
    expect(isResumableInflightStatus('failed')).toBe(false)
    expect(isResumableInflightStatus('cancelled')).toBe(false)
  })
})

describe('partitionResumeResults', () => {
  const t = (id: string) => ({ id, status: 'executing', tags: [] } as unknown as Task)

  it('按 resumed 分流', () => {
    const r = partitionResumeResults([
      { task: t('a'), resumed: true },
      { task: t('b'), resumed: false },
    ])
    expect(r.resumed.map((x) => x.id)).toEqual(['a'])
    expect(r.needRecovery.map((x) => x.id)).toEqual(['b'])
    expect(r.retryLater).toHaveLength(0)
  })

  it('全部 resumed', () => {
    const r = partitionResumeResults([
      { task: t('x'), resumed: true },
      { task: t('y'), resumed: true },
    ])
    expect(r.resumed.map((x) => x.id)).toEqual(['x', 'y'])
    expect(r.needRecovery).toHaveLength(0)
    expect(r.retryLater).toHaveLength(0)
  })

  it('全部 needRecovery', () => {
    const r = partitionResumeResults([
      { task: t('p'), resumed: false },
      { task: t('q'), resumed: false },
    ])
    expect(r.resumed).toHaveLength(0)
    expect(r.needRecovery.map((x) => x.id)).toEqual(['p', 'q'])
    expect(r.retryLater).toHaveLength(0)
  })

  it('not_configured 不进入 recovery，保留给下一次 sweep 重试', () => {
    const r = partitionResumeResults([
      { task: t('ready'), resumed: true },
      { task: t('early'), resumed: false, reason: 'not_configured' },
      { task: t('bad'), resumed: false, reason: 'no_checkpoint' },
    ])
    expect(r.resumed.map((x) => x.id)).toEqual(['ready'])
    expect(r.retryLater.map((x) => x.id)).toEqual(['early'])
    expect(r.needRecovery.map((x) => x.id)).toEqual(['bad'])
  })

  it('空输入返回两个空数组', () => {
    const r = partitionResumeResults([])
    expect(r.resumed).toHaveLength(0)
    expect(r.needRecovery).toHaveLength(0)
    expect(r.retryLater).toHaveLength(0)
  })

  // TaskStatus 引用，确保类型 import 不被 lint 当未用
  const _statuses: TaskStatus[] = ['executing', 'planning', 'waiting', 'waiting_human', 'pending']
  it('状态集合类型守卫', () => {
    expect(_statuses.every((s) => typeof s === 'string')).toBe(true)
  })
})
