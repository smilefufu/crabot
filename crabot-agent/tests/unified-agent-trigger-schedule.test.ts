import { describe, it, expect, vi } from 'vitest'

import { UnifiedAgent, type TriggerScheduleParams, type TriggerScheduleResult } from '../src/unified-agent.js'
import type { AgentEventPublisher } from '../src/manager/events.js'
import type { DialogObjectId, LedgerWorker } from '../src/workers/harness/ledger-types.js'

interface AgentUnderTest {
  config: { moduleId: string }
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
  const dialogObjectId = 'friend:master' as DialogObjectId

  const ledger = {
    upsertWorker: vi.fn(async (
      _dialogObjectId: DialogObjectId,
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
  agent.config = { moduleId: 'test-agent' }
  agent.managerStack = {
    ledger,
    principals: { dialogObjectIdFor: () => dialogObjectId },
    registry: { routeSchedule },
  }
  agent.memoryWriter = { runMaintenance }
  agent.managerEventPublisher = publish

  return { agent, workers, writes, ledger, routeSchedule, publish, dialogObjectId }
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
      fixture.dialogObjectId,
      result.task_id,
      expect.any(Function),
    )

    await waitUntil(() => fixture.workers.get(result.task_id!)?.task.status === 'running')
    maintenance.resolve()
    await waitUntil(() => fixture.workers.get(result.task_id!)?.task.status === 'completed')

    expect(fixture.writes.map((worker) => worker.task.status)).toEqual(['queued', 'running', 'completed'])
    expect(fixture.workers.get(result.task_id!)?.incarnations).toEqual([])
    expect(fixture.publish).toHaveBeenNthCalledWith(
      1,
      'agent.task_status_changed',
      expect.objectContaining({
        worker_id: result.task_id,
        task_id: result.task_id,
        old_status: 'queued',
        new_status: 'running',
        dialog_object_id: fixture.dialogObjectId,
      }),
    )
    expect(fixture.publish).toHaveBeenNthCalledWith(
      2,
      'agent.task_status_changed',
      expect.objectContaining({ old_status: 'running', new_status: 'completed' }),
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

    await waitUntil(() => fixture.workers.get(result.task_id!)?.task.status === 'failed')
    const task = fixture.workers.get(result.task_id!)!.task
    expect(task.error).toBe('memory unavailable')
    expect(task.outcome).toBe('记忆维护失败：memory unavailable')
    expect(fixture.writes.map((worker) => worker.task.status)).toEqual(['queued', 'running', 'failed'])
    expect(fixture.publish).toHaveBeenLastCalledWith(
      'agent.task_status_changed',
      expect.objectContaining({ old_status: 'running', new_status: 'failed' }),
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
      targetSession: undefined,
      creatorFriendId: 'friend-1',
      isBuiltin: undefined,
    })
    expect(fixture.ledger.upsertWorker).not.toHaveBeenCalled()
  })
})
