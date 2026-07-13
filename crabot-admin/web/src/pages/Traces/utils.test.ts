import { describe, it, expect } from 'vitest'
import { spanTypeLabel, spanTypeBg, detailSummary, agentLoopLabel, buildTraceEpochs } from './utils'
import type { AgentSpan, TraceIndexEntry } from '../../services/trace'

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

function trace(over: Partial<TraceIndexEntry>): TraceIndexEntry {
  return {
    trace_id: 'trace-default',
    related_task_id: 'task-1',
    trigger_type: 'task',
    trigger_summary: 'worker run',
    started_at: '2026-07-05T00:00:00.000Z',
    ended_at: '2026-07-05T00:10:00.000Z',
    duration_ms: 600_000,
    status: 'completed',
    span_count: 1,
    ...over,
  }
}

describe('buildTraceEpochs', () => {
  it('以 worker trace 为 epoch 边界，最新 epoch 排在最前面', () => {
    const epochs = buildTraceEpochs({
      currentTraceId: 'w2',
      fronts: [
        trace({ trace_id: 'd1', trigger_type: 'message', started_at: '2026-07-05T00:00:30.000Z', duration_ms: 1000 }),
        trace({ trace_id: 'd2', trigger_type: 'message', started_at: '2026-07-05T01:00:30.000Z', duration_ms: 1000 }),
      ],
      workers: [
        trace({ trace_id: 'w1', trigger_type: 'task', started_at: '2026-07-05T00:01:00.000Z', ended_at: '2026-07-05T00:40:00.000Z', status: 'completed' }),
        trace({ trace_id: 'w2', trigger_type: 'task', started_at: '2026-07-05T01:01:00.000Z', ended_at: undefined, status: 'running' }),
      ],
      subagents: [
        trace({ trace_id: 's1', trigger_type: 'sub_agent_call', started_at: '2026-07-05T01:05:00.000Z', status: 'failed' }),
      ],
    })

    expect(epochs.map((e) => e.id)).toEqual(['epoch-2', 'epoch-1'])
    expect(epochs[0]!.isLatest).toBe(true)
    expect(epochs[0]!.isCurrent).toBe(true)
    expect(epochs[0]!.traces.map((m) => m.entry.trace_id)).toEqual(['d2', 'w2', 's1'])
    expect(epochs[1]!.traces.map((m) => m.entry.trace_id)).toEqual(['d1', 'w1'])
  })

  it('当前 trace 在历史 epoch 时标记该历史 epoch，但 latest 仍只表示最新 worker epoch', () => {
    const epochs = buildTraceEpochs({
      currentTraceId: 'w1',
      fronts: [],
      workers: [
        trace({ trace_id: 'w1', trigger_type: 'task', started_at: '2026-07-05T00:01:00.000Z' }),
        trace({ trace_id: 'w2', trigger_type: 'task', started_at: '2026-07-05T01:01:00.000Z' }),
      ],
      subagents: [],
    })

    expect(epochs.map((e) => [e.id, e.isLatest, e.isCurrent])).toEqual([
      ['epoch-2', true, false],
      ['epoch-1', false, true],
    ])
  })

  it('没有 worker trace 时退化为单个当前 epoch，承载所有关联 trace', () => {
    const epochs = buildTraceEpochs({
      currentTraceId: 'd1',
      fronts: [
        trace({ trace_id: 'd1', trigger_type: 'message', started_at: '2026-07-05T00:00:30.000Z' }),
      ],
      workers: [],
      subagents: [
        trace({ trace_id: 's1', trigger_type: 'sub_agent_call', started_at: '2026-07-05T00:02:00.000Z' }),
      ],
    })

    expect(epochs).toHaveLength(1)
    expect(epochs[0]!.label).toBe('Epoch 1')
    expect(epochs[0]!.isLatest).toBe(true)
    expect(epochs[0]!.traces.map((m) => m.entry.trace_id)).toEqual(['d1', 's1'])
  })

  it('用 terminal_task_revived dispatcher 作为长 worker trace 内的复活 epoch 边界', () => {
    const epochs = buildTraceEpochs({
      currentTraceId: 'd3',
      fronts: [
        trace({ trace_id: 'd1', trigger_type: 'message', started_at: '2026-07-05T00:00:30.000Z', dispatch_actions: [{ kind: 'new_task', outcome: 'new_task_spawned' }] }),
        trace({ trace_id: 'd2', trigger_type: 'message', started_at: '2026-07-05T00:20:00.000Z', dispatch_actions: [{ kind: 'supplement', outcome: 'terminal_task_revived', target_task_completed_at: '2026-07-05T00:10:00.000Z' }] }),
        trace({ trace_id: 'd3', trigger_type: 'message', started_at: '2026-07-05T00:40:00.000Z', dispatch_actions: [{ kind: 'supplement', outcome: 'terminal_task_revived', target_task_completed_at: '2026-07-05T00:35:00.000Z' }] }),
      ],
      workers: [
        trace({ trace_id: 'w1', trigger_type: 'task', started_at: '2026-07-05T00:01:00.000Z', ended_at: '2026-07-05T01:00:00.000Z' }),
      ],
      subagents: [
        trace({ trace_id: 's2', trigger_type: 'sub_agent_call', started_at: '2026-07-05T00:25:00.000Z' }),
        trace({ trace_id: 's3', trigger_type: 'sub_agent_call', started_at: '2026-07-05T00:45:00.000Z' }),
      ],
    })

    expect(epochs.map((e) => e.id)).toEqual(['epoch-3', 'epoch-2', 'epoch-1'])
    expect(epochs[0]!.isLatest).toBe(true)
    expect(epochs[0]!.isCurrent).toBe(true)
    expect(epochs[0]!.traces.map((m) => m.entry.trace_id)).toEqual(['d3', 'w1', 's3'])
    expect(epochs[1]!.traces.map((m) => m.entry.trace_id)).toEqual(['d2', 'w1', 's2'])
    expect(epochs[2]!.traces.map((m) => m.entry.trace_id)).toEqual(['d1', 'w1'])
    expect(epochs[0]!.startedAt).toBe('2026-07-05T00:40:00.000Z')
    expect(epochs[0]!.endedAt).toBe('2026-07-05T01:00:00.000Z')
  })

  it('重复出现在多个复活 epoch 的长 worker 只让最新 epoch 标记当前', () => {
    const epochs = buildTraceEpochs({
      currentTraceId: 'w1',
      fronts: [
        trace({ trace_id: 'd1', trigger_type: 'message', started_at: '2026-07-05T00:00:30.000Z', dispatch_actions: [{ kind: 'new_task', outcome: 'new_task_spawned' }] }),
        trace({ trace_id: 'd2', trigger_type: 'message', started_at: '2026-07-05T00:20:00.000Z', dispatch_actions: [{ kind: 'supplement', outcome: 'terminal_task_revived', target_task_completed_at: '2026-07-05T00:10:00.000Z' }] }),
        trace({ trace_id: 'd3', trigger_type: 'message', started_at: '2026-07-05T00:40:00.000Z', dispatch_actions: [{ kind: 'supplement', outcome: 'terminal_task_revived', target_task_completed_at: '2026-07-05T00:35:00.000Z' }] }),
      ],
      workers: [
        trace({ trace_id: 'w1', trigger_type: 'task', started_at: '2026-07-05T00:01:00.000Z', ended_at: '2026-07-05T01:00:00.000Z' }),
      ],
      subagents: [],
    })

    expect(epochs.map((e) => [e.id, e.isLatest, e.isCurrent])).toEqual([
      ['epoch-3', true, true],
      ['epoch-2', false, false],
      ['epoch-1', false, false],
    ])
  })
})
