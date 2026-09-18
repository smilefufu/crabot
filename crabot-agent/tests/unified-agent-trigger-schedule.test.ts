import { describe, it, expect, vi } from 'vitest'
import { ConfigLoader } from '../src/core/config-loader.js'

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
  const authorizeSchedule = vi.fn(async () => undefined)
  const admitSchedule = vi.fn(async () => ({
    completion: Promise.resolve({ outcome: 'completed' }),
  }))
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
    registry: { authorizeSchedule, admitSchedule },
  }
  agent.memoryWriter = { runMaintenance }
  agent.managerEventPublisher = publish

  return { agent, workers, writes, ledger, authorizeSchedule, admitSchedule, publish, managerKey }
}

const TRIGGER_CONTEXT = {
  trigger_id: 'trigger-test',
  schedule_name: 'Test Schedule',
  target_session: {
    channel_id: 'admin-web',
    session_id: 'system-tasks',
    type: 'private',
  },
} as const

describe('trigger_schedule memory_maintenance system task', () => {
  it('persists one Agent-owned task before accepted, then completes without manager or worker', async () => {
    const maintenance = deferred<void>()
    const fixture = buildAgent(() => maintenance.promise)

    const result = await fixture.agent.handleTriggerSchedule({
      ...TRIGGER_CONTEXT,
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
    expect(fixture.admitSchedule).not.toHaveBeenCalled()
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
      ...TRIGGER_CONTEXT,
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
      ...TRIGGER_CONTEXT,
      schedule_id: 'schedule-user-maintenance',
      task_type: 'memory_maintenance',
      title: '用户自建维护',
      description: 'must stay on manager route',
      is_builtin: false,
      creator_friend_id: 'friend-user',
    })

    expect(result).toEqual({ accepted: true })
    expect(fixture.admitSchedule).toHaveBeenCalledTimes(1)
    expect(fixture.ledger.upsertWorker).not.toHaveBeenCalled()
  })

  it('reports retired memory_curate schedules without rewriting their task semantics', async () => {
    const fixture = buildAgent(() => Promise.resolve())
    const reportFailure = vi.fn().mockResolvedValue(undefined)
    ;(fixture.agent as AgentUnderTest & { sendBackgroundFailLoud: typeof reportFailure }).sendBackgroundFailLoud = reportFailure

    const result = await fixture.agent.handleTriggerSchedule({
      ...TRIGGER_CONTEXT,
      schedule_id: 'schedule-user-curate',
      task_type: 'memory_curate',
      title: '用户自建记忆整理',
      description: 'legacy schedule',
      is_builtin: false,
      target_session: { channel_id: 'telegram-default', session_id: 'legacy-session', type: 'private' },
    })

    expect(result).toEqual({ accepted: true })
    await waitUntil(() => reportFailure.mock.calls.length === 1)
    expect(reportFailure).toHaveBeenCalledWith(
      { channel_id: 'telegram-default', session_id: 'legacy-session', type: 'private' },
      '定时任务「用户自建记忆整理」',
      {
        kind: 'threw',
        error: expect.objectContaining({ message: 'memory_curate 已退役，请使用每日反思' }),
      },
    )
    expect(fixture.admitSchedule).not.toHaveBeenCalled()
    expect(fixture.ledger.upsertWorker).not.toHaveBeenCalled()
  })

  it('requires a host window for builtin daily, rejects user lookalikes carrying one, and forwards the exact window', async () => {
    const fixture = buildAgent(() => Promise.resolve())
    const params = { ...TRIGGER_CONTEXT, schedule_id: 'daily', task_type: 'daily_reflection', title: 'daily', is_builtin: true }
    const window = { window_start: '2026-09-16T18:00:00.000Z', window_end: '2026-09-17T18:00:00.000Z' }
    await expect(fixture.agent.handleTriggerSchedule(params)).rejects.toThrow('trusted window')
    await expect(fixture.agent.handleTriggerSchedule({ ...params, is_builtin: false, reflection_window: window })).rejects.toThrow('builtin daily identity')
    await expect(fixture.agent.handleTriggerSchedule({ ...params, reflection_window: window })).rejects.toThrow('proof')
    const agent = fixture.agent as any
    agent.getAdminPort = async () => 9999
    const bearer = vi.spyOn(ConfigLoader, 'getRuntimeBearer').mockReturnValue('runtime')
    const callSensitive = vi.fn().mockResolvedValue({ consumed: true })
    agent.rpcClient = { callSensitive }
    const trigger = { ...params, reflection_window: window, reflection_proof: 'one-time-proof' }
    await fixture.agent.handleTriggerSchedule(trigger)
    const { sha256CanonicalJson } = await import('crabot-shared')
    const { reflection_proof, ...bound } = trigger
    expect(callSensitive).toHaveBeenCalledWith(9999, 'consume_daily_reflection_trigger',
      { proof: reflection_proof, payload_sha256: sha256CanonicalJson(bound) }, 'test-agent', { authorizationBearer: 'runtime' })
    callSensitive.mockRejectedValue(new Error('invalid trigger proof'))
    await expect(fixture.agent.handleTriggerSchedule(trigger)).rejects.toThrow('invalid trigger proof')
    expect(fixture.admitSchedule).toHaveBeenCalledTimes(1)
    bearer.mockRestore()
    expect(fixture.admitSchedule).toHaveBeenCalledWith(expect.objectContaining({ reflectionWindow: window }))
    expect(fixture.ledger.upsertWorker).not.toHaveBeenCalled()
  })

  it('keeps ordinary schedules on the fire-and-forget manager route', async () => {
    const fixture = buildAgent(() => Promise.resolve())
    fixture.admitSchedule.mockResolvedValue({ completion: new Promise<never>(() => {}) })

    const result = await fixture.agent.handleTriggerSchedule({
      ...TRIGGER_CONTEXT,
      schedule_id: 'schedule-normal',
      task_type: 'daily_reflection',
      title: '每日反思',
      description: 'reflect',
      creator_friend_id: 'friend-1',
    })

    expect(result).toEqual({ accepted: true })
    expect(fixture.admitSchedule).toHaveBeenCalledWith({
      scheduleId: 'schedule-normal',
      triggerId: 'trigger-test',
      scheduleName: 'Test Schedule',
      title: '每日反思',
      description: 'reflect',
      priority: undefined,
      input: undefined,
      tags: undefined,
      taskType: 'daily_reflection',
      targetSession: TRIGGER_CONTEXT.target_session,
      creatorFriendId: 'friend-1',
      isBuiltin: undefined,
    })
    expect(fixture.ledger.upsertWorker).not.toHaveBeenCalled()
  })
})
