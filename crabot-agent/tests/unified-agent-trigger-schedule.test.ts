import { describe, it, expect, vi } from 'vitest'

import { UnifiedAgent, type TriggerScheduleParams, type TriggerScheduleResult } from '../src/unified-agent.js'
import type { AgentEventPublisher } from '../src/manager/events.js'
import type { ManagerKey, LedgerWorker } from '../src/workers/harness/ledger-types.js'

interface AgentUnderTest {
  agentConfig: { model_config: Record<string, { apikey: string; model_id: string }> }
  config: { moduleId: string }
  configAuthenticated: boolean
  configStale: boolean
  managerStack: unknown
  memoryWriter: { runMaintenance(scope: 'all'): Promise<void> }
  managerEventPublisher: AgentEventPublisher
  handleTriggerSchedule(params: TriggerScheduleParams): Promise<TriggerScheduleResult>
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('waitUntil timed out')
}

function buildAgent(runMaintenance: () => Promise<void>) {
  const workers = new Map<string, LedgerWorker>()
  const writes: LedgerWorker[] = []
  const routeSchedule = vi.fn(() => Promise.resolve())
  const publish = vi.fn<AgentEventPublisher>()
  const managerKey = 'admin-web::system-tasks' as ManagerKey

  const ledger = {
    upsertWorker: vi.fn(async (
      _managerKey: ManagerKey,
      workerId: string,
      mutator: (previous: LedgerWorker | undefined) => LedgerWorker | undefined,
    ) => {
      const next = mutator(workers.get(workerId))
      if (next) {
        workers.set(workerId, next)
        writes.push(structuredClone(next))
      }
      return next
    }),
  }

  const agent = Object.create(UnifiedAgent.prototype) as AgentUnderTest
  agent.agentConfig = { model_config: { powerful: { apikey: 'test-key', model_id: 'test-model' } } }
  agent.config = { moduleId: 'test-agent' }
  // 直接 test fixture：构造函数默认 runtime_config_authenticated=true；Object.create 绕过构造函数，这里补齐。
  agent.configAuthenticated = true
  agent.configStale = false
  agent.managerStack = {
    ledger,
    principals: { managerKeyFor: () => managerKey },
    registry: { routeSchedule },
  }
  agent.memoryWriter = { runMaintenance }
  agent.managerEventPublisher = publish

  return { agent, workers, writes, ledger, routeSchedule, publish, managerKey }
}

describe('trigger_schedule memory_maintenance system task', () => {
  it('persists one Agent-owned task before accepted, then completes without manager or worker', async () => {
    const maintenance = deferred<void>()
    const fixture = buildAgent(() => maintenance.promise)

    const result = await fixture.agent.handleTriggerSchedule({
      schedule_id: 'schedule-maintenance',
      task_type: 'memory_maintenance',
      title: '记忆维护',
      description: 'run maintenance',
      priority: 'low',
      input: { scope: 'all' },
      tags: ['memory_maintenance', 'builtin'],
      is_builtin: true,
    })

    expect(result.accepted).toBe(true)
    expect(result.task_id).toBeTypeOf('string')
    expect(fixture.routeSchedule).not.toHaveBeenCalled()
    expect(fixture.writes[0]).toMatchObject({
      worker_id: result.task_id,
      manager_key: 'admin-web::system-tasks',
      task: {
        id: result.task_id,
        type: 'memory_maintenance',
        title: '记忆维护',
        status: 'queued',
        priority: 'low',
        input: { scope: 'all' },
        tags: ['memory_maintenance', 'builtin'],
      },
      origin: { trigger_type: 'system' },
      incarnations: [],
    })
    expect(fixture.ledger.upsertWorker).toHaveBeenNthCalledWith(
      1,
      fixture.managerKey,
      result.task_id,
      expect.any(Function),
    )

    await waitUntil(() => fixture.workers.get(result.task_id!)?.task.status === 'running')
    maintenance.resolve()
    await waitUntil(() => fixture.workers.get(result.task_id!)?.task.status === 'closed')

    expect(fixture.writes.map((worker) => worker.task.status)).toEqual(['queued', 'running', 'closed'])
    expect(fixture.workers.get(result.task_id!)?.incarnations).toEqual([])
    expect(fixture.publish).toHaveBeenNthCalledWith(
      1,
      'agent.task_status_changed',
      expect.objectContaining({
        worker_id: result.task_id,
        task_id: result.task_id,
        old_status: 'queued',
        new_status: 'running',
        manager_key: fixture.managerKey,
      }),
    )
    expect(fixture.publish).toHaveBeenNthCalledWith(
      2,
      'agent.task_status_changed',
      expect.objectContaining({ old_status: 'running', new_status: 'closed' }),
    )
  })

  it('marks the same task failed when Memory RPC rejects', async () => {
    const error = new Error('memory unavailable')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fixture = buildAgent(() => Promise.reject(error))

    const result = await fixture.agent.handleTriggerSchedule({
      schedule_id: 'schedule-maintenance',
      task_type: 'memory_maintenance',
      title: '记忆维护',
      description: 'run maintenance',
      is_builtin: true,
    })

    await waitUntil(() => fixture.workers.get(result.task_id!)?.task.status === 'closed')
    const task = fixture.workers.get(result.task_id!)!.task
    expect(task.closed?.note).toBe('记忆维护失败：memory unavailable')
    expect(fixture.writes.map((worker) => worker.task.status)).toEqual(['queued', 'running', 'closed'])
    expect(fixture.publish).toHaveBeenLastCalledWith(
      'agent.task_status_changed',
      expect.objectContaining({ old_status: 'running', new_status: 'closed' }),
    )
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('does not grant direct maintenance to a user schedule with the reserved type', async () => {
    const fixture = buildAgent(() => Promise.resolve())

    const result = await fixture.agent.handleTriggerSchedule({
      schedule_id: 'schedule-user-maintenance',
      task_type: 'memory_maintenance',
      title: '用户自建维护',
      description: 'must stay on manager route',
      is_builtin: false,
      creator_friend_id: 'friend-user',
    })

    expect(result).toEqual({ accepted: true })
    expect(fixture.routeSchedule).toHaveBeenCalledTimes(1)
    expect(fixture.ledger.upsertWorker).not.toHaveBeenCalled()
  })

  it('reports retired memory_curate schedules without rewriting their task semantics', async () => {
    const fixture = buildAgent(() => Promise.resolve())
    const reportFailure = vi.fn().mockResolvedValue(undefined)
    ;(fixture.agent as AgentUnderTest & { sendBackgroundFailLoud: typeof reportFailure }).sendBackgroundFailLoud = reportFailure

    const result = await fixture.agent.handleTriggerSchedule({
      schedule_id: 'schedule-user-curate',
      task_type: 'memory_curate',
      title: '用户自建记忆整理',
      description: 'legacy schedule',
      is_builtin: false,
      target_session: { channel_id: 'telegram-default', session_id: 'legacy-session' },
    })

    expect(result).toEqual({ accepted: true })
    await waitUntil(() => reportFailure.mock.calls.length === 1)
    expect(reportFailure).toHaveBeenCalledWith(
      { channel_id: 'telegram-default', session_id: 'legacy-session' },
      '定时任务「用户自建记忆整理」',
      {
        kind: 'threw',
        error: expect.objectContaining({ message: 'memory_curate 已退役，请使用每日反思' }),
      },
    )
    expect(fixture.routeSchedule).not.toHaveBeenCalled()
    expect(fixture.ledger.upsertWorker).not.toHaveBeenCalled()
  })

  it('keeps ordinary schedules on the fire-and-forget manager route', async () => {
    const fixture = buildAgent(() => Promise.resolve())
    fixture.routeSchedule.mockImplementation(() => new Promise<never>(() => {}))

    const result = await fixture.agent.handleTriggerSchedule({
      schedule_id: 'schedule-normal',
      task_type: 'daily_reflection',
      title: '每日反思',
      description: 'reflect',
      creator_friend_id: 'friend-1',
    })

    expect(result).toEqual({ accepted: true })
    expect(fixture.routeSchedule).toHaveBeenCalledWith({
      scheduleId: 'schedule-normal',
      title: '每日反思',
      description: 'reflect',
      taskType: 'daily_reflection',
      targetSession: undefined,
      creatorFriendId: 'friend-1',
      isBuiltin: undefined,
    })
    expect(fixture.ledger.upsertWorker).not.toHaveBeenCalled()
  })
})
