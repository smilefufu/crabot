/**
 * P6-A §10 UI 测试：Worker 视图过滤、详情页化身链、cursor 失效恢复与 degraded 显示。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { WorkersView } from './WorkersView'
import { WorkerDetail } from './WorkerDetail'
import { agentObservabilityService } from '../../services/agent-observability'

vi.mock('../../services/agent-observability')
vi.mock('../../components/Layout/MainLayout', () => ({
  MainLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

const mocked = agentObservabilityService as unknown as {
  listWorkers: ReturnType<typeof vi.fn>
  getWorkerDetail: ReturnType<typeof vi.fn>
  getWorkerTrace: ReturnType<typeof vi.fn>
  readWorkerOutput: ReturnType<typeof vi.fn>
}

function workerFixture() {
  return {
    worker_id: 'w-1234567890ab',
    manager_key: 'wechat::sess-1',
    task: { id: 'w-1234567890ab', title: '任务标题', status: 'completed', created_at: '2026-08-01T00:00:00.000Z' },
    origin: { trigger_type: 'message' as const, spawned_by_episode: 'ep-abcd1234' },
    report_to: { channel_id: 'wechat', session_id: 'sess-1' },
    incarnations: [
      { seq: 1, impl: 'builtin' as const, state: 'exited', workspace: '/tmp/ws', started_at: '2026-08-01T00:00:00.000Z', ended_reason: 'completed', session_ref: 'r1' },
      { seq: 2, impl: 'builtin' as const, state: 'running', workspace: '/tmp/ws', started_at: '2026-08-01T00:05:00.000Z', session_ref: 'r2' },
    ],
    updated_at: '2026-08-01T00:05:00.000Z',
  }
}

describe('WorkersView', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('status 过滤透传 query，翻页重置', async () => {
    mocked.listWorkers = vi.fn().mockResolvedValue({
      items: [workerFixture()],
      pagination: { page: 1, page_size: 20, total_items: 1, total_pages: 1 },
    })
    render(
      <MemoryRouter>
        <WorkersView />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('任务标题')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('status 过滤'), { target: { value: 'failed' } })
    await waitFor(() => expect(mocked.listWorkers).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed', page: 1 })))
  })

  it('worker 链接到详情，manager 链接到 manager 详情', async () => {
    mocked.listWorkers = vi.fn().mockResolvedValue({
      items: [workerFixture()],
      pagination: { page: 1, page_size: 20, total_items: 1, total_pages: 1 },
    })
    render(
      <MemoryRouter>
        <WorkersView />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('w-1234567890')).toBeInTheDocument())
    expect(screen.getByText('w-1234567890').closest('a')!.getAttribute('href')).toBe(`/traces/workers/${encodeURIComponent('w-1234567890ab')}`)
    expect(screen.getByText('wechat::sess-1').closest('a')!.getAttribute('href')).toBe(`/traces/managers/${encodeURIComponent('wechat::sess-1')}`)
  })
})

describe('WorkerDetail', () => {
  beforeEach(() => { vi.resetAllMocks() })

  function renderDetail() {
    return render(
      <MemoryRouter initialEntries={[`/traces/workers/${encodeURIComponent('w-1234567890ab')}`]}>
        <Routes>
          <Route path="/traces/workers/:workerId" element={<WorkerDetail />} />
        </Routes>
      </MemoryRouter>,
    )
  }

  it('化身链 + 时间线增量读取 + cursor 失效显式恢复', async () => {
    mocked.getWorkerDetail = vi.fn().mockResolvedValue({ worker: workerFixture() })
    mocked.getWorkerTrace = vi.fn()
      .mockResolvedValueOnce({
        events: [{ ts: '2026-08-01T00:00:01.000Z', kind: 'lifecycle', summary: 'spawned', source: 'harness' }],
        next_cursor: 'tok-1',
      })
      .mockRejectedValueOnce(Object.assign(new Error('INVALID_PARAMS: unknown or expired trace cursor'), { code: 'INVALID_PARAMS' }))
      .mockResolvedValueOnce({
        events: [{ ts: '2026-08-01T00:00:01.000Z', kind: 'lifecycle', summary: 'spawned', source: 'harness' }],
        next_cursor: 'tok-1',
      })
    mocked.readWorkerOutput = vi.fn().mockResolvedValue({ chunk: '', next_cursor: '0' })

    renderDetail()
    await waitFor(() => expect(screen.getByText('spawned')).toBeInTheDocument())
    // 化身链两行
    expect(screen.getByText('#1')).toBeInTheDocument()
    expect(screen.getByText((content) => content.startsWith('#2'))).toBeInTheDocument()

    // 加载更多 → cursor 失效 → 显式提示
    fireEvent.click(screen.getByText('加载更多'))
    await waitFor(() => expect(screen.getByText(/游标已失效/)).toBeInTheDocument())
    // 从头重载
    fireEvent.click(screen.getByText('从头重新加载'))
    await waitFor(() => expect(screen.getAllByText('spawned').length).toBeGreaterThan(0))
  })

  it('native degraded 时 harness 事件仍显示，且 reason 独立呈现', async () => {
    mocked.getWorkerDetail = vi.fn().mockResolvedValue({ worker: workerFixture() })
    mocked.getWorkerTrace = vi.fn().mockResolvedValue({
      events: [{ ts: '2026-08-01T00:00:01.000Z', kind: 'lifecycle', summary: 'spawned', source: 'harness' }],
      next_cursor: 'tok-1',
      unavailable_reason: 'native unavailable: file gone',
    })
    mocked.readWorkerOutput = vi.fn().mockResolvedValue({ chunk: '', next_cursor: '0' })
    renderDetail()
    await waitFor(() => expect(screen.getByText('spawned')).toBeInTheDocument())
    expect(screen.getByText(/native unavailable/)).toBeInTheDocument()
  })
})
