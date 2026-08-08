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
    handler.deliverShellExitNotification = legacy

    await handler.routeShellExit(shellInfo('bg-worker', 'worker-1'))
    expect(dispatch).toHaveBeenCalledWith('worker-1', expect.objectContaining({ entity_id: 'bg-worker' }))
    expect(legacy).not.toHaveBeenCalled()

    await handler.routeShellExit(shellInfo('bg-legacy'))
    expect(legacy).toHaveBeenCalledWith(expect.objectContaining({ entity_id: 'bg-legacy' }))
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
