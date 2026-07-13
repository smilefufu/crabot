import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ExpandedTraceRows, TraceDetailPanel } from './index'
import { traceService } from '../../services/trace'
import type { AgentSpan, AgentTrace, TraceIndexEntry } from '../../services/trace'

vi.mock('../../services/trace', async () => {
  const actual = await vi.importActual<typeof import('../../services/trace')>('../../services/trace')
  return {
    ...actual,
    traceService: {
      ...actual.traceService,
      getTraceTree: vi.fn(),
    },
  }
})

vi.mock('../../services/bg-entities', () => ({
  bgEntitiesService: { list: vi.fn().mockResolvedValue({ entities: [] }), kill: vi.fn() },
  bgStatusColor: vi.fn(() => '#10b981'),
  bgStatusLabel: vi.fn(() => '运行中'),
  bgFormatRuntime: vi.fn(() => '1m'),
}))

vi.mock('./TaskBgShells', () => ({
  TaskBgShells: () => null,
}))

function workerTrace(over: Partial<AgentTrace> = {}): AgentTrace {
  return {
    trace_id: 'wt1', status: 'completed',
    started_at: '2026-06-20T00:00:00Z', duration_ms: 1000,
    trigger: { type: 'task', summary: '做个页面' },
    spans: [],
    resume_checkpoint: {
      agent_version: 'x', system_prompt: 'SYS_PROMPT_MARKER',
      messages: [{ id: 'a1', role: 'assistant', timestamp: 0, content: [{ type: 'text', text: 'CONV_TEXT_MARKER' }] }],
      worker_state: { todo_items: [] },
    },
    ...over,
  } as unknown as AgentTrace
}

function indexTrace(over: Partial<TraceIndexEntry>): TraceIndexEntry {
  return {
    trace_id: 'w1',
    related_task_id: 'task-1',
    trigger_type: 'task',
    trigger_summary: 'worker',
    started_at: '2026-07-05T00:00:00.000Z',
    ended_at: '2026-07-05T00:10:00.000Z',
    duration_ms: 600_000,
    status: 'completed',
    span_count: 1,
    ...over,
  }
}

function span(over: Partial<AgentSpan>): AgentSpan {
  return {
    span_id: 'span-default',
    trace_id: 'wt1',
    type: 'tool_call',
    started_at: '2026-07-05T00:00:00.000Z',
    ended_at: '2026-07-05T00:00:01.000Z',
    duration_ms: 1000,
    status: 'completed',
    details: {},
    ...over,
  } as AgentSpan
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('TraceDetailPanel 完整对话', () => {
  it('worker trace 顶部有「完整对话」按钮,不再有独立「对话(N 条消息)」区块', () => {
    render(<TraceDetailPanel trace={workerTrace()} loading={false} />)
    expect(screen.getByRole('button', { name: /完整对话/ })).toBeTruthy()
    expect(screen.queryByText(/条消息）/)).toBeNull()
  })

  it('点按钮打开弹窗,含 System Prompt 与对话内容', () => {
    render(<TraceDetailPanel trace={workerTrace()} loading={false} />)
    fireEvent.click(screen.getByRole('button', { name: /完整对话/ }))
    expect(screen.getByText(/CONV_TEXT_MARKER/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /System Prompt/ }))
    expect(screen.getByText(/SYS_PROMPT_MARKER/)).toBeTruthy()
  })

  it('非 worker trace(无 resume_checkpoint)无「完整对话」按钮', () => {
    const t = workerTrace({ trigger: { type: 'dispatcher', summary: 'x' } as never, resume_checkpoint: undefined as never })
    render(<TraceDetailPanel trace={t} loading={false} />)
    expect(screen.queryByRole('button', { name: /完整对话/ })).toBeNull()
  })
})

describe('TraceDetailPanel epoch 关联链路', () => {
  it('按 epoch 展示关联 trace，最新 epoch 默认展开，历史 epoch 默认折叠', async () => {
    ;(traceService.getTraceTree as ReturnType<typeof vi.fn>).mockResolvedValue({
      tree: {
        fronts: [
          indexTrace({ trace_id: 'd1', trigger_type: 'message', started_at: '2026-07-05T00:00:30.000Z' }),
          indexTrace({ trace_id: 'd2', trigger_type: 'message', started_at: '2026-07-05T01:00:30.000Z' }),
        ],
        workers: [
          indexTrace({ trace_id: 'w1', started_at: '2026-07-05T00:01:00.000Z', ended_at: '2026-07-05T00:40:00.000Z' }),
          indexTrace({ trace_id: 'w2', started_at: '2026-07-05T01:01:00.000Z', ended_at: undefined, status: 'running' }),
        ],
        subagents: [
          indexTrace({ trace_id: 's2', trigger_type: 'sub_agent_call', started_at: '2026-07-05T01:05:00.000Z' }),
        ],
      },
    })

    render(<TraceDetailPanel trace={workerTrace({ trace_id: 'w2', related_task_id: 'task-1', status: 'running' })} loading={false} />)

    await waitFor(() => expect(screen.getByText(/2 epoch \/ 共 5 trace/)).toBeInTheDocument())
    expect(screen.getByText(/Epoch 2 · 最新/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /历史 epoch \(1\)/ })).toBeInTheDocument()
    expect(screen.getByText('d2')).toBeInTheDocument()
    expect(screen.getByTitle('worker · 状态 running · w2')).toBeInTheDocument()
    expect(screen.getByText('s2')).toBeInTheDocument()
    expect(screen.queryByText('d1')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /历史 epoch \(1\)/ }))
    expect(screen.getByText(/Epoch 1/)).toBeInTheDocument()
    expect(screen.queryByText('d1')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Epoch 1/ }))
    expect(screen.getByText('d1')).toBeInTheDocument()
    expect(screen.getByText('w1')).toBeInTheDocument()
  })

  it('worker trace 详情按 focusWindow 只展示当前 epoch 内的 span 和祖先 span', () => {
    render(
      <TraceDetailPanel
        trace={workerTrace({
          spans: [
            span({
              span_id: 'root',
              type: 'agent_loop',
              started_at: '2026-07-05T00:00:00.000Z',
              ended_at: '2026-07-05T02:00:00.000Z',
              duration_ms: 7_200_000,
              details: { loop_label: 'task' },
            }),
            span({
              span_id: 'old-tool',
              parent_span_id: 'root',
              type: 'tool_call',
              started_at: '2026-07-05T00:05:00.000Z',
              ended_at: '2026-07-05T00:06:00.000Z',
              details: { tool_name: 'old_tool' },
            }),
            span({
              span_id: 'new-tool',
              parent_span_id: 'root',
              type: 'tool_call',
              started_at: '2026-07-05T01:05:00.000Z',
              ended_at: '2026-07-05T01:06:00.000Z',
              details: { tool_name: 'new_tool' },
            }),
          ],
        })}
        loading={false}
        focusWindow={{
          epochLabel: 'Epoch 2',
          startedAt: '2026-07-05T01:00:00.000Z',
          endedAt: '2026-07-05T01:30:00.000Z',
        }}
      />,
    )

    expect(screen.getByText(/Span 已按 Epoch 2 切片/)).toBeInTheDocument()
    expect(screen.getByText(/2 \/ 3/)).toBeInTheDocument()
    expect(screen.getByText(/Task Loop/)).toBeInTheDocument()
    expect(screen.getByText(/new_tool/)).toBeInTheDocument()
    expect(screen.queryByText(/old_tool/)).toBeNull()
  })
})

describe('ExpandedTraceRows epoch 展开行', () => {
  it('左侧 task 展开后只默认展开最新 epoch，历史 epoch 折叠', () => {
    render(
      <table>
        <tbody>
          <ExpandedTraceRows
            selectedTraceId={null}
            onSelectTrace={() => {}}
            tree={{
              task_id: 'task-1',
              tree: {
                fronts: [
                  indexTrace({ trace_id: 'd1', trigger_type: 'message', started_at: '2026-07-05T00:00:30.000Z', dispatch_actions: [{ kind: 'new_task', outcome: 'new_task_spawned' }] }),
                  indexTrace({ trace_id: 'd2', trigger_type: 'message', started_at: '2026-07-05T01:00:30.000Z', dispatch_actions: [{ kind: 'supplement', outcome: 'terminal_task_revived' }] }),
                ],
                workers: [
                  indexTrace({ trace_id: 'w1', started_at: '2026-07-05T00:01:00.000Z' }),
                ],
                subagents: [],
              },
            }}
          />
        </tbody>
      </table>,
    )

    expect(screen.getByText(/Epoch 2/)).toBeInTheDocument()
    expect(screen.getByText(/历史 epoch \(1\)/)).toBeInTheDocument()
    expect(screen.getByText('d2')).toBeInTheDocument()
    expect(screen.queryByText('d1')).toBeNull()

    fireEvent.click(screen.getByText(/历史 epoch \(1\)/).closest('tr')!)
    expect(screen.getByText(/Epoch 1/)).toBeInTheDocument()
    expect(screen.queryByText('d1')).toBeNull()

    fireEvent.click(screen.getByText(/Epoch 1/).closest('tr')!)
    expect(screen.getByText('d1')).toBeInTheDocument()
    expect(screen.getByText('w1')).toBeInTheDocument()
  })
})
