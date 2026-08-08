import { describe, expect, it, vi } from 'vitest'
import { UnifiedAgent } from '../../src/unified-agent.js'

describe('legacy worker lifecycle RPC compatibility', () => {
  it('registers cancel_task and abort_worker while worker role is enabled', () => {
    const agent = Object.create(UnifiedAgent.prototype) as any
    const registered: string[] = []
    agent.roles = new Set(['worker'])
    agent.registerMethod = vi.fn((name: string) => { registered.push(name) })

    agent.registerMethods()

    expect(registered).toContain('cancel_task')
    expect(registered).toContain('abort_worker')
    expect(registered).not.toContain('execute_task')
    expect(registered).not.toContain('deliver_human_response')
    expect(registered).not.toContain('start_task')
  })

  it('cancel and abort handlers delegate to the live legacy worker owner', () => {
    const cancelTask = vi.fn()
    const abortWorker = vi.fn().mockReturnValue(true)
    const agent = Object.create(UnifiedAgent.prototype) as any
    agent.agentHandler = { cancelTask, abortWorker }

    expect(agent.handleCancelTask({ task_id: 'task-1', reason: 'human cancelled' })).toEqual({ cancelled: true })
    expect(cancelTask).toHaveBeenCalledWith('task-1', 'human cancelled')

    expect(agent.handleAbortWorker({ task_id: 'task-2', reason: 'terminal sweep' })).toEqual({ aborted: true })
    expect(abortWorker).toHaveBeenCalledWith('task-2', 'terminal sweep')
  })
})
