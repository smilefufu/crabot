import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { ManagerDetail } from './ManagerDetail'
import { agentObservabilityService as service, type ManagerEpisodeTrace } from '../../services/agent-observability'

vi.mock('../../services/agent-observability')
vi.mock('../../components/Layout/MainLayout', () => ({ MainLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))

const pagination = { page: 1, page_size: 20, total_items: 1, total_pages: 1 }
const episode: ManagerEpisodeTrace = {
  trace_id: 'ep-stalled', manager_key: 'test::session', started_at: '2026-09-21T05:52:00Z', status: 'running',
  trigger: { type: 'worker_event', summary: '执行器进展' }, spawned_worker_ids: [],
  spans: [{ span_id: 'tool', type: 'tool_call', started_at: '2026-09-21T05:53:00Z', ended_at: '2026-09-21T05:53:32Z',
    status: 'failed', details: { name: 'get_worker_turn', error: '[interrupted: agent restarted]' } }],
}
async function open() {
  render(<MemoryRouter initialEntries={['/traces/managers/test%3A%3Asession']}><Routes>
    <Route path="/traces/managers/:managerKey" element={<ManagerDetail />} />
  </Routes></MemoryRouter>)
  await act(async () => { await Promise.resolve() })
}

describe('Manager activity evidence', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-21T06:28:32Z'))
    vi.mocked(service.listManagers).mockResolvedValue({ items: [], pagination })
    vi.mocked(service.listWorkers).mockResolvedValue({ items: [], pagination, total_active: 0, total_terminal: 0, total_legacy: 0 })
    vi.mocked(service.getManagerInboundStatus).mockResolvedValue({ manager_key: 'test::session', snapshot_at: new Date().toISOString(), items: [] })
    vi.mocked(service.listManagerEpisodes).mockResolvedValue({ items: [episode], pagination })
  })
  afterEach(() => { vi.useRealTimers() })

  it('shows unfinished episode evidence without claiming recovery or progress from a successful poll', async () => {
    await open()
    expect(screen.getByText('回合未结束')).toBeInTheDocument()
    expect(screen.getByText('最后记录：工具调用 get_worker_turn · 失败')).toBeInTheDocument()
    expect(screen.getByText('当前执行步骤未知')).toBeInTheDocument()
    expect(screen.getByText(/距最近记录 35 分 0 秒/)).toBeInTheDocument()
    expect(screen.queryByText(/刚刚更新/)).toBeNull()
    expect(screen.getByText(/回合数据刷新于/)).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(screen.getByText(/距最近记录 35 分 2 秒/)).toBeInTheDocument()
  })

  it('displays an open tool by name and falls back honestly when no step was recorded', async () => {
    vi.mocked(service.listManagerEpisodes).mockResolvedValueOnce({ items: [{ ...episode, spans: [{ ...episode.spans[0], status: 'running', ended_at: undefined }] }], pagination })
    await open()
    expect(screen.getByText('未结束步骤：工具调用 get_worker_turn')).toBeInTheDocument()
    expect(screen.getByText(/步骤已持续 35 分 32 秒/)).toBeInTheDocument()
    vi.mocked(service.listManagerEpisodes).mockResolvedValue({ items: [{ ...episode, spans: [] }], pagination })
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(screen.getByText('当前执行步骤未知')).toBeInTheDocument()
    expect(screen.getByText('最后记录：回合开始')).toBeInTheDocument()
    expect(screen.queryByText(/未结束步骤/)).toBeNull()
  })

  it('marks history refresh failure even when inbound polling succeeds, and refreshes worker state', async () => {
    await open()
    vi.mocked(service.listManagerEpisodes).mockRejectedValue(new Error('history offline'))
    vi.mocked(service.listWorkers).mockRejectedValue(new Error('worker offline'))
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(document.querySelector('.manager-detail__live-state')).toHaveTextContent('回合刷新失败')
    expect(document.querySelector('.manager-detail__live-state')).toHaveClass('is-unknown')
    expect(screen.getByText(/暂不可用（unknown）/)).toBeInTheDocument()
    expect(service.listWorkers).toHaveBeenCalledTimes(2)
    expect(screen.getByText('最后记录：工具调用 get_worker_turn · 失败')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '查看技术详情' }))
    expect(screen.getByText(/interrupted: agent restarted/)).toBeInTheDocument()
    expect(screen.getByText('失败 · 耗时未记录')).toBeInTheDocument()
    expect(screen.queryByText('进行中')).toBeNull()
  })

  it('keeps a running worker-triggered episode visible instead of hiding it in its completed parent', async () => {
    vi.mocked(service.listManagerEpisodes).mockResolvedValue({ items: [{ ...episode,
      worker_ref: { worker_id: 'w1', title: '重建服务器', state_to: 'halted' },
      causal_parent: { trace_id: 'parent', started_at: episode.started_at, status: 'completed', trigger: { type: 'human_message', summary: '重建' } },
    }], pagination })
    await open()
    expect(screen.getByText('回合未结束')).toBeInTheDocument()
    expect(screen.getByText('最后记录：工具调用 get_worker_turn · 失败')).toBeInTheDocument()
  })
})
