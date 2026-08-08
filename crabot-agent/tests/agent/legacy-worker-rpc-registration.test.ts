import { describe, expect, it, vi } from 'vitest'
import { UnifiedAgent } from '../../src/unified-agent.js'

describe('legacy worker execution RPC retirement', () => {
  it('does not register any legacy execution, recovery, or lifecycle RPC', () => {
    const agent = Object.create(UnifiedAgent.prototype) as any
    const registered: string[] = []
    agent.roles = new Set(['worker'])
    agent.registerMethod = vi.fn((name: string) => { registered.push(name) })

    agent.registerMethods()

    expect(registered).not.toContain('execute_task')
    expect(registered).not.toContain('deliver_human_response')
    expect(registered).not.toContain('start_task')
    expect(registered).not.toContain('start_recovery_task')
    expect(registered).not.toContain('create_task_from_schedule')
    expect(registered).not.toContain('resume_task')
    expect(registered).not.toContain('resume_task_with_supplement')
    expect(registered).not.toContain('cancel_task')
    expect(registered).not.toContain('abort_worker')
  })
})
