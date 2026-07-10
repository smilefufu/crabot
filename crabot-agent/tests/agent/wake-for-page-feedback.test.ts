import { describe, it, expect, vi } from 'vitest'
import { AgentHandler } from '../../src/agent/agent-handler.js'
import { UnifiedAgent } from '../../src/unified-agent.js'
import { HumanMessageQueue } from '../../src/engine/human-message-queue.js'

describe('AgentHandler.wakeForPageFeedback', () => {
  it('push note 到指定 task 的 humanQueue 并切回 executing', () => {
    const handler = Object.create(AgentHandler.prototype) as any
    const queue = new HumanMessageQueue()
    handler.humanQueues = new Map([['t1', queue]])
    const transition = vi.fn().mockResolvedValue(true)
    handler.transitionTaskStatus = transition

    let pushed = ''
    const orig = queue.push.bind(queue)
    queue.push = (c: any) => { pushed = typeof c === 'string' ? c : JSON.stringify(c); orig(c) }

    handler.wakeForPageFeedback('t1', '[系统] 临时页面收到新反馈，读 events.jsonl')

    expect(pushed).toContain('[系统]')
    expect(pushed).toContain('临时页面收到新反馈')
    expect(transition).toHaveBeenCalledWith('t1', 'executing')
  })

  it('未知 task → 静默 no-op（不 push）但仍尝试切 executing', () => {
    const handler = Object.create(AgentHandler.prototype) as any
    handler.humanQueues = new Map()
    const transition = vi.fn().mockResolvedValue(true)
    handler.transitionTaskStatus = transition

    expect(() => handler.wakeForPageFeedback('missing', 'x')).not.toThrow()
    expect(transition).toHaveBeenCalledWith('missing', 'executing')
  })
})

describe('UnifiedAgent.handleDeliverPageFeedback (deliver_page_feedback RPC)', () => {
  it('task 活跃 → 调 wakeForPageFeedback 并返回 {delivered:true}', () => {
    const agent = Object.create(UnifiedAgent.prototype) as any
    const wake = vi.fn()
    agent.agentHandler = {
      hasActiveTask: (id: string) => id === 't1',
      wakeForPageFeedback: wake,
    }

    const result = agent.handleDeliverPageFeedback({ task_id: 't1', page_id: 'page_abcdefghijklmnop' })

    expect(result.delivered).toBe(true)
    expect(wake).toHaveBeenCalledOnce()
    const [taskId, note] = wake.mock.calls[0] as [string, string]
    expect(taskId).toBe('t1')
    expect(note).toContain('[系统]')
    expect(note).toContain('page_abcdefghijklmnop')
    expect(note).toContain('tmp_page_read_events')
    expect(note).toContain('"page_id": "page_abcdefghijklmnop"')
    expect(note).not.toContain('$DATA_DIR')
    expect(note).not.toContain('.crabot')
    expect(note).not.toContain('events.jsonl')
    expect(note).not.toContain('CRABOT_TMP_PAGE_PORT')
  })

  it('task 不活跃 → 返回 {delivered:false,reason:"not_active"}，不调 wake', () => {
    const agent = Object.create(UnifiedAgent.prototype) as any
    const wake = vi.fn()
    agent.agentHandler = {
      hasActiveTask: () => false,
      wakeForPageFeedback: wake,
    }

    const result = agent.handleDeliverPageFeedback({ task_id: 'gone', page_id: 'page_abcdefghijklmnop' })

    expect(result.delivered).toBe(false)
    expect(result.reason).toBe('not_active')
    expect(wake).not.toHaveBeenCalled()
  })

  it('worker handler 未配置 → 抛错', () => {
    const agent = Object.create(UnifiedAgent.prototype) as any
    agent.agentHandler = undefined

    expect(() => agent.handleDeliverPageFeedback({ task_id: 't1', page_id: 'page_abcdefghijklmnop' })).toThrow(
      'Worker handler not configured',
    )
  })
})
