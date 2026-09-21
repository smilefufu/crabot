import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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

it('merges request phases, keeps separate attempts and preserves the expanded row during polling', async () => {
  vi.useFakeTimers()
  const get = vi.mocked(agentObservabilityService.getWorkerTrace)
  const event = (kind: string, id: string, attempt: number): WorkerTraceEvent => ({
    ts: runtime.as_of, source: 'native', kind: kind === 'request_failed' ? 'error' : 'lifecycle', summary: kind,
    detail: { kind: 'worker_runtime', version: 1, event: kind, runtime: { ...runtime,
      request: { ...runtime.request, request_id: id, attempt, ended_at: kind === 'request_failed' ? runtime.as_of : undefined },
      error: kind === 'request_failed' ? 'HTTP 502' : undefined,
    } },
  })
  get.mockResolvedValueOnce({ events: [event('request_started', 'r1', 1)], next_cursor: 'one', runtime } as never)
  await act(async () => { render(<MemoryRouter><Timeline workerId="worker" seq={1} /></MemoryRouter>) })
  fireEvent.click(screen.getByRole('button', { name: /展开/ }))
  get.mockResolvedValueOnce({ events: [event('request_failed', 'r1', 1), event('request_started', 'r2', 2)], next_cursor: 'two', runtime } as never)
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(screen.getAllByRole('button', { name: /收起/ })).toHaveLength(1)
  expect(screen.getAllByRole('button', { name: /展开/ })).toHaveLength(1)
  expect(screen.getAllByText(/请求失败.*第 1 次尝试.*HTTP 502/).length).toBeGreaterThan(0)
  expect(screen.getByText(/请求已开始.*第 2 次尝试/)).toBeInTheDocument()
})
