import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHandler } from '../../src/agent/agent-handler.js'
import { UnifiedAgent } from '../../src/unified-agent.js'
import { TaskCancelledError } from '../../src/workers/harness/harness.js'

const shellInfo = (entityId: string, workerId?: string) => ({
  entity_id: entityId,
  command: `echo ${entityId}`,
  status: 'completed' as const,
  exit_code: 0,
  spawned_by_task_id: workerId ?? 'legacy-task',
  owner_friend_id: 'friend-1',
  ...(workerId ? { worker_id: workerId } : {}),
})

function makeHandler(): any {
  const handler = Object.create(AgentHandler.prototype) as any
  handler.workerShellExitRoutingReady = true
  handler.queuedWorkerShellExits = []
  handler.workerShellExitRetryTimers = new Map()
  handler.workerShellExitSettlementTimers = new Map()
  handler.workerShellExitQueues = new Map()
  handler.drainingWorkerShellExitQueues = new Set()
  handler.bgRegistry = {
    get: vi.fn(async (entityId: string) => ({
      entity_id: entityId,
      type: 'shell',
      exit_notification: { status: 'pending', attempts: 0 },
    })),
    beginExitNotificationAttempt: vi.fn().mockResolvedValue(undefined),
    recordExitNotificationFailure: vi.fn().mockResolvedValue(undefined),
    settleExitNotification: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
  }
  handler.deliverShellExitNotification = vi.fn().mockResolvedValue(undefined)
  return handler
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('builtin background shell exit routing', () => {
  it('worker owner routes through dispatcher and durably settles; missing worker_id keeps legacy delivery', async () => {
    const handler = makeHandler()
    const dispatch = vi.fn(async (_workerId, _info, settle) => settle({ status: 'delivered' }))
    handler.builtinShellExitDispatcher = dispatch

    await handler.routeShellExit(shellInfo('bg-worker', 'worker-1'))
    expect(dispatch).toHaveBeenCalledWith(
      'worker-1',
      expect.objectContaining({ entity_id: 'bg-worker' }),
      expect.any(Function),
    )
    expect(handler.bgRegistry.beginExitNotificationAttempt).toHaveBeenCalledWith('bg-worker')
    expect(handler.bgRegistry.settleExitNotification).toHaveBeenCalledWith('bg-worker', 'delivered', undefined)
    expect(handler.deliverShellExitNotification).not.toHaveBeenCalled()

    await handler.routeShellExit(shellInfo('bg-legacy'))
    expect(handler.deliverShellExitNotification).toHaveBeenCalledWith(
      expect.objectContaining({ entity_id: 'bg-legacy' }),
    )
  })

  it('treats a terminal shell with a durable pending receipt as running background work', async () => {
    const handler = makeHandler()
    handler.bgRegistry.list.mockResolvedValueOnce([
      {
        entity_id: 'bg-pending',
        type: 'shell',
        status: 'completed',
        owner: { friend_id: '__system_worker-1', worker_id: 'worker-1' },
        exit_notification: { status: 'pending' },
      },
    ])
    expect(await handler.hasRunningBgForWorker('worker-1')).toBe(true)

    handler.bgRegistry.list.mockResolvedValueOnce([
      {
        entity_id: 'bg-delivered',
        type: 'shell',
        status: 'completed',
        owner: { friend_id: '__system_worker-1', worker_id: 'worker-1' },
        exit_notification: { status: 'delivered' },
      },
    ])
    expect(await handler.hasRunningBgForWorker('worker-1')).toBe(false)
  })

  it('holds recovered worker exits until reconciliation release, then dispatches without unrelated input', async () => {
    const handler = makeHandler()
    handler.workerShellExitRoutingReady = false
    const dispatch = vi.fn(async (_workerId, _info, settle) => settle({ status: 'delivered' }))
    handler.builtinShellExitDispatcher = dispatch

    await handler.routeShellExit(shellInfo('bg-recovered', 'worker-1'))
    expect(dispatch).not.toHaveBeenCalled()
    expect(handler.queuedWorkerShellExits).toHaveLength(1)

    await handler.releaseRecoveredWorkerShellExits()
    await vi.waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith(
        'worker-1',
        expect.objectContaining({ entity_id: 'bg-recovered' }),
        expect.any(Function),
      )
    })
    expect(handler.queuedWorkerShellExits).toHaveLength(0)
  })

  it('releases recovered queues independently so one hung worker does not block another or startup', async () => {
    const handler = makeHandler()
    handler.workerShellExitRoutingReady = false
    let releaseWorkerA!: () => void
    const workerAGate = new Promise<void>((resolve) => { releaseWorkerA = resolve })
    const delivered: string[] = []
    handler.builtinShellExitDispatcher = vi.fn(async (workerId, _info, settle) => {
      if (workerId === 'worker-a') await workerAGate
      await settle({ status: 'delivered' })
      delivered.push(workerId)
    })

    await handler.routeShellExit(shellInfo('bg-a', 'worker-a'))
    await handler.routeShellExit(shellInfo('bg-b', 'worker-b'))
    await expect(handler.releaseRecoveredWorkerShellExits()).resolves.toBeUndefined()

    await vi.waitFor(() => expect(delivered).toContain('worker-b'))
    expect(delivered).not.toContain('worker-a')

    releaseWorkerA()
    await vi.waitFor(() => expect(delivered).toContain('worker-a'))
  })

  it('retains a failed recovered delivery as pending, retries it, and does not block another worker', async () => {
    vi.useFakeTimers()
    const handler = makeHandler()
    handler.workerShellExitRoutingReady = false
    const dispatch = vi.fn()
      .mockRejectedValueOnce(new Error('adapter unavailable'))
      .mockImplementation(async (_workerId, _info, settle) => settle({ status: 'delivered' }))
    handler.builtinShellExitDispatcher = dispatch
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await handler.routeShellExit(shellInfo('bg-failed', 'worker-1'))
    await handler.routeShellExit(shellInfo('bg-next', 'worker-2'))
    await handler.releaseRecoveredWorkerShellExits()

    await vi.advanceTimersByTimeAsync(0)
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(handler.bgRegistry.recordExitNotificationFailure)
      .toHaveBeenCalledWith('bg-failed', 'adapter unavailable')
    expect(handler.bgRegistry.settleExitNotification)
      .toHaveBeenCalledWith('bg-next', 'delivered', undefined)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(dispatch).toHaveBeenCalledTimes(3)
    expect(handler.bgRegistry.settleExitNotification)
      .toHaveBeenCalledWith('bg-failed', 'delivered', undefined)
  })

  it('keeps a later exit behind an earlier same-worker exit while the head is retrying', async () => {
    const handler = makeHandler()
    let releaseHeadRetry!: () => void
    const headRetryGate = new Promise<void>((resolve) => { releaseHeadRetry = resolve })
    let headAttempts = 0
    const order: string[] = []
    handler.builtinShellExitDispatcher = vi.fn(async (_workerId, info, settle) => {
      order.push(info.entity_id)
      if (info.entity_id === 'bg-first') {
        headAttempts += 1
        if (headAttempts === 1) throw new Error('transient route failure')
        await headRetryGate
      }
      await settle({ status: 'delivered' })
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await handler.routeShellExit(shellInfo('bg-first', 'worker-1'))
    const second = handler.routeShellExit(shellInfo('bg-second', 'worker-1'))
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(order).toEqual(['bg-first', 'bg-first'])
    releaseHeadRetry()
    await second
    expect(order).toEqual(['bg-first', 'bg-first', 'bg-second'])
  })

  it('keeps retrying a pending delivery with a capped delay until it settles or the process stops', async () => {
    vi.useFakeTimers()
    const handler = makeHandler()
    handler.builtinShellExitDispatcher = vi.fn().mockRejectedValue(new Error('still unavailable'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await handler.routeShellExit(shellInfo('bg-long-outage', 'worker-1'))
    for (const delay of [1_000, 2_000, 4_000, 8_000, 10_000, 10_000]) {
      await vi.advanceTimersByTimeAsync(delay)
    }

    expect(handler.builtinShellExitDispatcher).toHaveBeenCalledTimes(7)
    expect(handler.workerShellExitRetryTimers.has('bg-long-outage')).toBe(true)
  })

  it('retries only the durable settlement after input delivery, without enqueueing the input again', async () => {
    vi.useFakeTimers()
    const handler = makeHandler()
    handler.bgRegistry.settleExitNotification
      .mockRejectedValueOnce(new Error('registry rename failed'))
      .mockResolvedValue(undefined)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(handler.settleWorkerShellExit('bg-settlement', { status: 'delivered' }))
      .rejects.toThrow('registry rename failed')
    expect(handler.workerShellExitSettlementTimers.has('bg-settlement')).toBe(true)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(handler.bgRegistry.settleExitNotification).toHaveBeenCalledTimes(2)
    expect(handler.workerShellExitSettlementTimers.has('bg-settlement')).toBe(false)
  })

  it('marks pending synchronously, serializes same-worker delivery, and clears only after settlement', async () => {
    const agent = Object.create(UnifiedAgent.prototype) as any
    agent.config = { moduleId: 'agent-test' }
    agent.builtinBgDeliveryTails = new Map()

    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const render = vi.fn(async (info: { entity_id: string }) => {
      if (info.entity_id === 'bg-1') await firstGate
      return `exit:${info.entity_id}`
    })
    const sent: string[] = []
    let pending = 0
    const completed: string[] = []
    const harness = {
      beginBgNotification: vi.fn((workerId: string) => {
        pending += 1
        let done = false
        return () => {
          if (done) throw new Error(`duplicate complete for ${workerId}`)
          done = true
          pending -= 1
          completed.push(workerId)
        }
      }),
      sendToWorker: vi.fn(async (_workerId: string, text: string, opts: any) => {
        sent.push(text)
        await opts.onSettled('delivered')
      }),
    }
    agent.managerStack = { harness }
    agent.agentHandler = { renderShellExitNotification: render }
    const settlements: string[] = []
    const settle = async (value: { status: string }) => { settlements.push(value.status) }

    const first = agent.deliverBuiltinShellExit('worker-1', shellInfo('bg-1'), settle)
    expect(pending).toBe(1)
    const second = agent.deliverBuiltinShellExit('worker-1', shellInfo('bg-2'), settle)
    expect(pending).toBe(2)

    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(render).toHaveBeenCalledTimes(1)
    releaseFirst()
    await Promise.all([first, second])

    expect(sent).toEqual([
      '<bg-notification>\nexit:bg-1\n</bg-notification>',
      '<bg-notification>\nexit:bg-2\n</bg-notification>',
    ])
    expect(settlements).toEqual(['delivered', 'delivered'])
    expect(completed).toEqual(['worker-1', 'worker-1'])
    expect(pending).toBe(0)
    expect(agent.builtinBgDeliveryTails.size).toBe(0)
  })

  it('held WorkerInbox delivery keeps the task pending until the item actually settles', async () => {
    const agent = Object.create(UnifiedAgent.prototype) as any
    agent.config = { moduleId: 'agent-test' }
    agent.builtinBgDeliveryTails = new Map()
    agent.agentHandler = { renderShellExitNotification: vi.fn().mockResolvedValue('exit:bg-held') }

    let pending = 0
    let heldSettlement: ((value: 'delivered') => Promise<void>) | undefined
    let sendCount = 0
    const harness = {
      beginBgNotification: () => {
        pending += 1
        return () => { pending -= 1 }
      },
      sendToWorker: vi.fn(async (_workerId: string, _text: string, opts: any) => {
        sendCount += 1
        if (sendCount === 1) {
          heldSettlement = opts.onSettled
          return
        }
        opts.onDeduplicated()
      }),
    }
    agent.managerStack = { harness }
    const settled = vi.fn().mockResolvedValue(undefined)

    await agent.deliverBuiltinShellExit('worker-1', shellInfo('bg-held'), settled)
    expect(pending).toBe(1)
    expect(settled).not.toHaveBeenCalled()

    // A process-local retry sees the durable item already held in WorkerInbox.
    // It must neither enqueue a duplicate nor settle the producer receipt early.
    await agent.deliverBuiltinShellExit('worker-1', shellInfo('bg-held'), settled)
    expect(pending).toBe(1)
    expect(settled).not.toHaveBeenCalled()

    await heldSettlement?.('delivered')
    expect(settled).toHaveBeenCalledTimes(1)
    expect(pending).toBe(0)
  })

  it('cancelled target durably dead-letters without reviving the worker', async () => {
    const agent = Object.create(UnifiedAgent.prototype) as any
    agent.config = { moduleId: 'agent-test' }
    agent.builtinBgDeliveryTails = new Map()
    agent.agentHandler = { renderShellExitNotification: vi.fn().mockResolvedValue('exit:bg-cancelled') }
    const complete = vi.fn()
    const harness = {
      beginBgNotification: () => complete,
      sendToWorker: vi.fn().mockRejectedValue(new TaskCancelledError('worker-1')),
    }
    agent.managerStack = { harness }
    const settled = vi.fn().mockResolvedValue(undefined)

    await agent.deliverBuiltinShellExit('worker-1', shellInfo('bg-cancelled'), settled)

    expect(settled).toHaveBeenCalledWith({
      status: 'dead_letter',
      reason: expect.stringContaining('cancelled'),
    })
    expect(complete).toHaveBeenCalledOnce()
  })
})
