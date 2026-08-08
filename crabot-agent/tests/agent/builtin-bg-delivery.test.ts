import { describe, expect, it, vi } from 'vitest'
import { AgentHandler } from '../../src/agent/agent-handler.js'
import { UnifiedAgent } from '../../src/unified-agent.js'

const shellInfo = (entityId: string, workerId?: string) => ({
  entity_id: entityId,
  command: `echo ${entityId}`,
  status: 'completed' as const,
  exit_code: 0,
  spawned_by_task_id: 'legacy-task',
  owner_friend_id: 'friend-1',
  ...(workerId ? { worker_id: workerId } : {}),
})

describe('builtin background shell exit routing', () => {
  it('worker owner routes through dispatcher; missing worker_id keeps legacy delivery', async () => {
    const handler = Object.create(AgentHandler.prototype) as any
    const dispatch = vi.fn().mockResolvedValue(undefined)
    const legacy = vi.fn().mockResolvedValue(undefined)
    handler.builtinShellExitDispatcher = dispatch
    handler.workerShellExitRoutingReady = true
    handler.deliverShellExitNotification = legacy

    await handler.routeShellExit(shellInfo('bg-worker', 'worker-1'))
    expect(dispatch).toHaveBeenCalledWith('worker-1', expect.objectContaining({ entity_id: 'bg-worker' }))
    expect(legacy).not.toHaveBeenCalled()

    await handler.routeShellExit(shellInfo('bg-legacy'))
    expect(legacy).toHaveBeenCalledWith(expect.objectContaining({ entity_id: 'bg-legacy' }))
  })

  it('holds recovered worker exits until reconciliation release, then dispatches without unrelated input', async () => {
    const handler = Object.create(AgentHandler.prototype) as any
    handler.workerShellExitRoutingReady = false
    handler.queuedWorkerShellExits = []
    const dispatch = vi.fn().mockResolvedValue(undefined)
    handler.builtinShellExitDispatcher = dispatch
    handler.deliverShellExitNotification = vi.fn()

    await handler.routeShellExit(shellInfo('bg-recovered', 'worker-1'))
    expect(dispatch).not.toHaveBeenCalled()
    expect(handler.queuedWorkerShellExits).toHaveLength(1)

    await handler.releaseRecoveredWorkerShellExits()
    expect(dispatch).toHaveBeenCalledWith('worker-1', expect.objectContaining({ entity_id: 'bg-recovered' }))
    expect(handler.queuedWorkerShellExits).toHaveLength(0)
  })

  it('one recovered delivery failure is logged without blocking later queued exits', async () => {
    const handler = Object.create(AgentHandler.prototype) as any
    handler.workerShellExitRoutingReady = false
    handler.queuedWorkerShellExits = []
    const dispatch = vi.fn()
      .mockRejectedValueOnce(new Error('worker cancelled'))
      .mockResolvedValueOnce(undefined)
    handler.builtinShellExitDispatcher = dispatch
    handler.deliverShellExitNotification = vi.fn()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})

    await handler.routeShellExit(shellInfo('bg-failed', 'worker-1'))
    await handler.routeShellExit(shellInfo('bg-next', 'worker-2'))
    await expect(handler.releaseRecoveredWorkerShellExits()).resolves.toBeUndefined()

    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(dispatch).toHaveBeenLastCalledWith('worker-2', expect.objectContaining({ entity_id: 'bg-next' }))
    expect(handler.queuedWorkerShellExits).toHaveLength(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('bg-failed'), expect.any(Error))
    log.mockRestore()
  })

  it('marks pending synchronously, serializes same-worker delivery, and clears each mark exactly once', async () => {
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
      sendToWorker: vi.fn(async (_workerId: string, text: string) => { sent.push(text) }),
    }
    agent.managerStack = { harness }
    agent.agentHandler = { renderShellExitNotification: render }

    const first = agent.deliverBuiltinShellExit('worker-1', shellInfo('bg-1'))
    expect(pending).toBe(1)
    const second = agent.deliverBuiltinShellExit('worker-1', shellInfo('bg-2'))
    expect(pending).toBe(2)

    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(render).toHaveBeenCalledTimes(1)
    releaseFirst()
    await Promise.all([first, second])

    expect(sent).toEqual([
      '<bg-notification>\nexit:bg-1\n</bg-notification>',
      '<bg-notification>\nexit:bg-2\n</bg-notification>',
    ])
    expect(completed).toEqual(['worker-1', 'worker-1'])
    expect(pending).toBe(0)
    expect(agent.builtinBgDeliveryTails.size).toBe(0)
  })
})
