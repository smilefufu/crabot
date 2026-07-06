import { describe, it, expect } from 'vitest'
import { spanTypeLabel, spanTypeBg, detailSummary, agentLoopLabel } from './utils'
import type { AgentSpan } from '../../services/trace'

describe('spanTypeLabel', () => {
  it('returns label for dispatch_call', () => {
    expect(spanTypeLabel('dispatch_call')).toBe('dispatch')
  })
  it('returns label for dispatch_action', () => {
    expect(spanTypeLabel('dispatch_action')).toBe('dispatch-act')
  })
  it('returns label for agent_loop', () => {
    expect(spanTypeLabel('agent_loop')).toBe('loop')
  })
  it('returns label for llm_call', () => {
    expect(spanTypeLabel('llm_call')).toBe('llm')
  })
  it('returns label for rpc_call', () => {
    expect(spanTypeLabel('rpc_call')).toBe('rpc')
  })
})

describe('spanTypeBg', () => {
  it('returns color for dispatch_call', () => {
    expect(spanTypeBg('dispatch_call')).toMatch(/^#[0-9a-fA-F]+/)
  })
  it('returns color for dispatch_action', () => {
    expect(spanTypeBg('dispatch_action')).toMatch(/^#[0-9a-fA-F]+/)
  })
  it('dispatch_call and dispatch_action have distinct colors', () => {
    expect(spanTypeBg('dispatch_call')).not.toBe(spanTypeBg('dispatch_action'))
  })
  it('returns fallback color for unknown type', () => {
    expect(spanTypeBg('unknown_type' as never)).toBe('#6b7280')
  })
})

describe('detailSummary for dispatch_call', () => {
  const makeSpan = (type: AgentSpan['type'], details: Record<string, unknown>): AgentSpan => ({
    span_id: 'test-span',
    trace_id: 'test-trace',
    type,
    started_at: new Date().toISOString(),
    status: 'completed',
    details: details as AgentSpan['details'],
  })

  it('shows model, message_count, action_count', () => {
    const span = makeSpan('dispatch_call', {
      model: 'claude-sonnet-4-6',
      message_count: 3,
      action_count: 2,
    })
    const summary = detailSummary(span)
    expect(summary).toContain('claude-sonnet-4-6')
    expect(summary).toContain('3 msgs')
    expect(summary).toContain('2 actions')
  })

  it('handles missing fields gracefully', () => {
    const span = makeSpan('dispatch_call', {})
    expect(detailSummary(span)).toBe('')
  })
})

describe('detailSummary for dispatch_action', () => {
  const makeSpan = (type: AgentSpan['type'], details: Record<string, unknown>): AgentSpan => ({
    span_id: 'test-span',
    trace_id: 'test-trace',
    type,
    started_at: new Date().toISOString(),
    status: 'completed',
    details: details as AgentSpan['details'],
  })

  it('shows kind and outcome for supplement', () => {
    const span = makeSpan('dispatch_action', {
      kind: 'supplement',
      text_summary: '帮你查一下',
      outcome: 'supplement_delivered',
    })
    const summary = detailSummary(span)
    expect(summary).toContain('supplement')
    expect(summary).toContain('supplement_delivered')
    expect(summary).not.toContain('帮你查一下')
  })

  it('shows kind for stay_silent', () => {
    const span = makeSpan('dispatch_action', { kind: 'stay_silent', outcome: 'silent_discard' })
    const summary = detailSummary(span)
    expect(summary).toContain('stay_silent')
    expect(summary).toContain('silent_discard')
  })

  it('shows spawned_trace_id via outcome for new_task', () => {
    const span = makeSpan('dispatch_action', {
      kind: 'new_task',
      text_summary: '创建一个新任务',
      outcome: 'new_task_spawned',
    })
    const summary = detailSummary(span)
    expect(summary).toContain('new_task')
    expect(summary).toContain('new_task_spawned')
    expect(summary).not.toContain('创建一个新任务')
  })
})

describe('agentLoopLabel', () => {
  it('legacy front label 显示 Dispatch Loop (legacy)', () => {
    expect(agentLoopLabel({ loop_label: 'front' })).toBe('Dispatch Loop (legacy)')
  })
  it('legacy worker label 兼容映射到 Task Loop', () => {
    expect(agentLoopLabel({ loop_label: 'worker' })).toBe('Task Loop')
  })
  it('task label 显示 Task Loop', () => {
    expect(agentLoopLabel({ loop_label: 'task' })).toBe('Task Loop')
  })
  it('subagent name 原样显示', () => {
    expect(agentLoopLabel({ loop_label: 'code_planner' })).toBe('code_planner')
  })
  it('空 label 显示 Agent Loop fallback', () => {
    expect(agentLoopLabel({})).toBe('Agent Loop')
  })
})
