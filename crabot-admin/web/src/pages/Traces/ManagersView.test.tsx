/**
 * P6-A §10 UI 测试：Manager/Worker 视图的路由编解码、分页、错误态与 cursor 恢复。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { ManagersView } from './ManagersView'
import { ManagerDetail } from './ManagerDetail'
import { agentObservabilityService } from '../../services/agent-observability'

vi.mock('../../services/agent-observability')
vi.mock('../../components/Layout/MainLayout', () => ({
  MainLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

const mocked = agentObservabilityService as unknown as {
  listManagers: ReturnType<typeof vi.fn>
  listManagerEpisodes: ReturnType<typeof vi.fn>
}

describe('ManagersView', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('列表渲染 + 链接按 encodeURIComponent 编码 ManagerKey', async () => {
    mocked.listManagers = vi.fn().mockResolvedValue({
      items: [{
        manager_key: 'wechat::sess-1',
        last_activity_at: '2026-08-01T10:00:00.000Z',
        episode_count: 3,
        worker_count: 2,
      }],
      pagination: { page: 1, page_size: 20, total_items: 1, total_pages: 1 },
    })
    render(
      <MemoryRouter>
        <ManagersView />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('wechat::sess-1')).toBeInTheDocument())
    const link = screen.getByText('wechat::sess-1').closest('a')!
    expect(link.getAttribute('href')).toBe(`/traces/managers/${encodeURIComponent('wechat::sess-1')}`)
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('agent 不可达显示 unknown，不缓存旧数据', async () => {
    mocked.listManagers = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'))
    render(
      <MemoryRouter>
        <ManagersView />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText(/unknown/)).toBeInTheDocument())
  })

  it('翻页触发带页码的重新拉取', async () => {
    mocked.listManagers = vi.fn().mockResolvedValue({
      items: [{ manager_key: 'wechat::sess-1', episode_count: 1, worker_count: 0 }],
      pagination: { page: 1, page_size: 20, total_items: 40, total_pages: 2 },
    })
    render(
      <MemoryRouter>
        <ManagersView />
      </MemoryRouter>,
    )
    await waitFor(() => expect(mocked.listManagers).toHaveBeenCalledWith(1, 20))
    fireEvent.click(screen.getByText('下一页'))
    await waitFor(() => expect(mocked.listManagers).toHaveBeenCalledWith(2, 20))
  })
})

describe('ManagerDetail', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('episode 渲染：trigger/状态/时间/spawned worker 链接', async () => {
    mocked.listManagerEpisodes = vi.fn().mockResolvedValue({
      items: [{
        trace_id: 'ep-12345678-abcd',
        manager_key: 'wechat::sess-1',
        started_at: '2026-08-01T10:00:00.000Z',
        status: 'completed',
        trigger: { type: 'human_message', summary: '人类消息 x1' },
        spans: [],
        spawned_worker_ids: ['w-abc123456789'],
        outcome: { summary: 'outcome=completed' },
      }],
      pagination: { page: 1, page_size: 20, total_items: 1, total_pages: 1 },
    })
    render(
      <MemoryRouter initialEntries={[`/traces/managers/${encodeURIComponent('wechat::sess-1')}`]}>
        <Routes>
          <Route path="/traces/managers/:managerKey" element={<ManagerDetail />} />
        </Routes>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('人类消息')).toBeInTheDocument())
    expect(screen.getByText('completed')).toBeInTheDocument()
    // 展开后 spawned worker 链接出现
    fireEvent.click(screen.getByText('人类消息 x1'))
    await waitFor(() => expect(screen.getByText('w-abc1234567')).toBeInTheDocument())
    const workerLink = screen.getByText('w-abc1234567').closest('a')!
    expect(workerLink.getAttribute('href')).toBe(`/traces/workers/${encodeURIComponent('w-abc123456789')}`)
  })
})
