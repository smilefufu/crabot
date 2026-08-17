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
        display_name: '微信·棉花糖 · 产品群',
        last_activity_at: '2026-08-01T10:00:00.000Z',
        recent_activity_summary: '你问：部署好了吗',
        active_worker_count: 2,
      }],
      pagination: { page: 1, page_size: 20, total_items: 1, total_pages: 1 },
    })
    render(
      <MemoryRouter>
        <ManagersView />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('微信·棉花糖 · 产品群')).toBeInTheDocument())
    const link = screen.getByText('微信·棉花糖 · 产品群').closest('a')!
    expect(link.getAttribute('href')).toBe(`/traces/managers/${encodeURIComponent('wechat::sess-1')}`)
    expect(screen.getByText('wechat::sess-1')).toBeInTheDocument()
    expect(screen.getByText('2 个')).toBeInTheDocument()
    expect(screen.getByText('你问：部署好了吗')).toBeInTheDocument()
    expect(screen.queryByText('Episodes')).toBeNull()
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
      items: [{ manager_key: 'wechat::sess-1', display_name: '微信 · 会话', active_worker_count: 0 }],
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
        trigger: { type: 'human_message', summary: '人类消息 x1：V6 部署好了吗' },
        reply_excerpt: '还没有，我已经重新派活。',
        actions: [{ kind: 'spawn_worker', label: '派活：部署 V6', worker_id: 'w-abc123456789' }],
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
    await waitFor(() => expect(screen.getByText('你：「V6 部署好了吗」')).toBeInTheDocument())
    expect(screen.getByText('→ 回复：还没有，我已经重新派活。')).toBeInTheDocument()
    const workerLink = screen.getByText('派活：部署 V6').closest('a')!
    expect(workerLink.getAttribute('href')).toBe(`/traces/workers/${encodeURIComponent('w-abc123456789')}`)
    // completed/trace id 默认隐藏，技术详情展开后才出现。
    expect(screen.queryByText('completed')).toBeNull()
    expect(screen.queryByText(/ep-12345678-abcd/)).toBeNull()
    fireEvent.click(screen.getByText('技术详情'))
    expect(screen.getByText(/ep-12345678-abcd/)).toBeInTheDocument()
  })

  it('worker 进展按 spawn worker_id 折叠到人类消息下，默认不展开', async () => {
    mocked.listManagerEpisodes = vi.fn().mockResolvedValue({
      items: [
        {
          trace_id: 'ep-progress', manager_key: 'wechat::sess-1', started_at: '2026-08-01T10:01:00.000Z', status: 'completed',
          trigger: { type: 'worker_event', summary: 'worker event', source: 'worker:w-1' }, spans: [], spawned_worker_ids: [],
          worker_ref: { worker_id: 'w-1', title: '部署 V6', state_to: 'waiting_input' },
        },
        {
          trace_id: 'ep-parent', manager_key: 'wechat::sess-1', started_at: '2026-08-01T10:00:00.000Z', status: 'completed',
          trigger: { type: 'human_message', summary: '人类消息 x1：开始部署' }, spans: [], spawned_worker_ids: ['w-1'],
          actions: [{ kind: 'spawn_worker', label: '派活：部署 V6', worker_id: 'w-1' }],
        },
      ],
      pagination: { page: 1, page_size: 20, total_items: 2, total_pages: 1 },
    })
    render(
      <MemoryRouter initialEntries={[`/traces/managers/${encodeURIComponent('wechat::sess-1')}`]}>
        <Routes><Route path="/traces/managers/:managerKey" element={<ManagerDetail />} /></Routes>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('你：「开始部署」')).toBeInTheDocument())
    expect(screen.queryByText(/部署 V6.*waiting_input/)).toBeNull()
    fireEvent.click(screen.getByText('展开 1 条 worker 进展'))
    expect(screen.getByText(/部署 V6.*waiting_input/)).toBeInTheDocument()
  })
})
