import { describe, it, expect } from 'vitest'
import { __test_only__parseDecisionTool as parseDecisionTool } from '../../src/agent/front-loop.js'

describe('parseDecisionTool: user_attitude propagation', () => {
  it('reply with user_attitude=pass propagates to DirectReplyDecision', () => {
    const decision = parseDecisionTool('reply', {
      text: '不客气',
      user_attitude: 'pass',
    })
    expect(decision.type).toBe('direct_reply')
    expect((decision as any).user_attitude).toBe('pass')
  })

  it('reply without user_attitude leaves field undefined', () => {
    const decision = parseDecisionTool('reply', { text: '不客气' })
    expect(decision.type).toBe('direct_reply')
    expect((decision as any).user_attitude).toBeUndefined()
  })

  it('create_task with user_attitude=strong_pass propagates', () => {
    const decision = parseDecisionTool('create_task', {
      task_title: 'Do X',
      task_description: 'Do X',
      ack_text: '好的，接下来做',
      user_attitude: 'strong_pass',
    })
    expect(decision.type).toBe('create_task')
    expect((decision as any).user_attitude).toBe('strong_pass')
  })

  it('supplement_task with user_attitude=fail propagates', () => {
    const decision = parseDecisionTool('supplement_task', {
      task_id: 't_42',
      content: '应该是后天',
      ack_text: '调整为后天',
      user_attitude: 'fail',
    })
    expect(decision.type).toBe('supplement_task')
    expect((decision as any).user_attitude).toBe('fail')
  })

  it('stay_silent ignores any extra field', () => {
    const decision = parseDecisionTool('stay_silent', {})
    expect(decision.type).toBe('silent')
    expect((decision as any).user_attitude).toBeUndefined()
  })

  it('reply rejects invalid user_attitude value (treats as undefined)', () => {
    const decision = parseDecisionTool('reply', {
      text: '不客气',
      user_attitude: 'maybe',  // 非 enum 值
    })
    // 防御性：非合法 enum 值不传给下游
    expect((decision as any).user_attitude).toBeUndefined()
  })
})
