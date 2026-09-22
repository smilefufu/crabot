import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Timeline } from './WorkerDetail'
import { agentObservabilityService, type WorkerTraceEvent } from '../../services/agent-observability'

vi.mock('../../services/agent-observability')
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks() })
const runtime = {
  incarnation_id: 'inc', as_of: '2026-09-21T11:00:00Z', phase: 'retry_wait',
  request: { request_id: 'r1', call_id: 'c1', attempt: 2, purpose: 'inference', model_id: 'test-model', started_at: '2026-09-21T10:59:00Z' },
  retry: { request_id: 'r1', call_id: 'c1', retry_mode: 'bounded_retry', started_at: '2026-09-21T11:00:00Z', delay_ms: 1000, error: 'HTTP 502' },
  pending_inputs: { normal: 2, priority: 1 },
}

it('shows retry and queued inputs by default, polls incrementally and preserves stale data on failure', async () => {
  vi.useFakeTimers()
  const get = vi.mocked(agentObservabilityService.getWorkerTrace)
  get.mockResolvedValue({ events: [], next_cursor: 'cursor-1', runtime } as never)
  await act(async () => { render(<MemoryRouter><Timeline workerId="worker" seq={1} /></MemoryRouter>) })
  expect(screen.getByText('当前执行')).toBeInTheDocument()
  expect(screen.getByText(/重试等待/)).toBeInTheDocument()
  expect(screen.getByText(/待注入输入 3 条/)).toBeInTheDocument()
  get.mockRejectedValueOnce(new Error('offline'))
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(get).toHaveBeenLastCalledWith('worker', { seq: 1, cursor: 'cursor-1' })
  expect(screen.getByText(/数据已过期/)).toBeInTheDocument()
  expect(screen.getByText(/test-model/)).toBeInTheDocument()
})

it('ignores an old incarnation response after switching and pauses polling when hidden', async () => {
  vi.useFakeTimers()
  let resolveOld!: (value: unknown) => void
  const get = vi.mocked(agentObservabilityService.getWorkerTrace)
  get.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve as typeof resolveOld }))
  const view = render(<MemoryRouter><Timeline workerId="worker" seq={1} /></MemoryRouter>)
  get.mockResolvedValue({ events: [], next_cursor: 'new', runtime: { ...runtime, request: { ...runtime.request, model_id: 'new-model' } } } as never)
  await act(async () => { view.rerender(<MemoryRouter><Timeline workerId="worker" seq={2} /></MemoryRouter>) })
  await act(async () => { resolveOld({ events: [], next_cursor: 'old', runtime }) })
  expect(screen.getByText(/new-model/)).toBeInTheDocument()
  expect(screen.queryByText(/test-model/)).not.toBeInTheDocument()
  const before = get.mock.calls.length
  const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  fireEvent(document, new Event('visibilitychange'))
  await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
  expect(get).toHaveBeenCalledTimes(before)
  hidden.mockRestore()
})

it('keeps progress in the current snapshot and preserves historical errors after a successful retry', async () => {
  vi.useFakeTimers()
  const get = vi.mocked(agentObservabilityService.getWorkerTrace)
  const event = (kind: string, id: string, attempt: number): WorkerTraceEvent => ({
    ts: runtime.as_of, source: 'native', kind: kind === 'request_failed' ? 'error' : 'lifecycle', summary: kind,
    detail: { kind: 'worker_runtime', version: 1, event: kind, runtime: { ...runtime,
      request: { ...runtime.request, request_id: id, attempt, ended_at: kind === 'request_failed' ? runtime.as_of : undefined },
      error: kind === 'request_failed' ? 'HTTP 502' : undefined,
    } },
  })
  get.mockResolvedValueOnce({ events: [event('request_started', 'r1', 1), event('request_failed', 'r1', 1)], next_cursor: 'one', runtime } as never)
  await act(async () => { render(<MemoryRouter><Timeline workerId="worker" seq={1} /></MemoryRouter>) })
  expect(screen.queryByText(/请求已开始/)).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /展开/ }))
  get.mockResolvedValueOnce({ events: [event('request_started', 'r2', 2), event('first_response', 'r2', 2), event('request_completed', 'r2', 2)], next_cursor: 'two', runtime: { ...runtime, phase: 'idle', request: undefined, retry: undefined } } as never)
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(screen.getAllByRole('button', { name: /收起/ })).toHaveLength(1)
  expect(screen.queryByRole('button', { name: /展开/ })).not.toBeInTheDocument()
  expect(screen.getAllByText(/请求失败.*第 1 次尝试.*HTTP 502/).length).toBeGreaterThan(0)
  expect(screen.queryByText(/请求已开始|请求已完成|已收到响应数据/)).not.toBeInTheDocument()
  expect(within(screen.getByRole('region', { name: '当前执行' })).getByText('等输入')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '技术事件 4' }))
  expect(screen.getByText('request_completed')).toBeInTheDocument()
  expect(screen.getByText('first_response')).toBeInTheDocument()
})

it('hides normal runtime and delivery status while retaining input content, operations and all errors', async () => {
  const progress = ['preparing', 'request_started', 'first_response', 'request_completed', 'retry_wait', 'compaction_started', 'compaction_finished', 'input_queued', 'input_injected', 'idle', 'ended']
  const errors = ['request_failed', 'interrupted', 'compaction_finished', 'ended']
  const events: WorkerTraceEvent[] = progress.map((event, i) => ({
    ts: `2026-09-21T10:00:${String(i).padStart(2, '0')}Z`, source: 'native', kind: 'lifecycle', summary: event,
    detail: { kind: 'worker_runtime', version: 1, event, runtime: { ...runtime, error: event === 'input_queued' ? 'previous failure' : undefined } },
  }))
  events.push(...errors.map((event, i): WorkerTraceEvent => ({
    ts: `2026-09-21T10:01:0${i}Z`, source: 'native', kind: event === 'compaction_finished' ? 'lifecycle' : 'error', summary: event,
    detail: { kind: 'worker_runtime', version: 1, event, runtime: { ...runtime, error: `failure-${i}` } },
  })),
    { ts: runtime.as_of, source: 'harness', kind: 'lifecycle', summary: 'input_sent', detail: { text_preview: 'accepted preview' } },
    { ts: runtime.as_of, source: 'native', kind: 'message', role: 'user', summary: 'actual instruction', detail: { content: 'actual instruction' } },
    { ts: runtime.as_of, source: 'native', kind: 'message', role: 'assistant', summary: 'worker reply' },
    { ts: runtime.as_of, source: 'native', kind: 'tool_call', summary: 'Bash', detail: { name: 'Bash', call_id: 'tool-1', arguments: 'pwd' } },
    { ts: runtime.as_of, source: 'native', kind: 'tool_result', summary: 'tool output', detail: { call_id: 'tool-1', output: 'tool output' } },
    { ts: runtime.as_of, source: 'harness', kind: 'lifecycle', summary: 'input_delivery_failed', detail: { reason: 'delivery failure' } },
    { ts: runtime.as_of, source: 'native', kind: 'error', summary: 'adapter failure' },
  )
  vi.mocked(agentObservabilityService.getWorkerTrace).mockResolvedValue({ events, runtime } as never)
  render(<MemoryRouter><Timeline workerId="worker" seq={1} /></MemoryRouter>)
  expect(await screen.findByText('actual instruction')).toBeInTheDocument()
  expect(screen.getByText('输入')).toBeInTheDocument()
  expect(screen.getByText('worker reply')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /工具调用：调用 Bash · 已返回结果/ })).toBeInTheDocument()
  expect(screen.queryByText('执行进度')).not.toBeInTheDocument()
  expect(screen.queryByText('已加入上下文')).not.toBeInTheDocument()
  expect(screen.queryByText('accepted preview')).not.toBeInTheDocument()
  expect(screen.queryByText(/previous failure/)).not.toBeInTheDocument()
  errors.forEach((_, i) => expect(screen.getByRole('button', { name: new RegExp(`请求或执行错误：.*failure-${i}`) })).toBeInTheDocument())
  expect(screen.getByText('delivery failure')).toBeInTheDocument()
  expect(screen.getByText('adapter failure')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: `技术事件 ${progress.length + 1}` }))
  expect(screen.getByText('input_sent')).toBeInTheDocument()
  expect(screen.getByText('input_injected')).toBeInTheDocument()
})
