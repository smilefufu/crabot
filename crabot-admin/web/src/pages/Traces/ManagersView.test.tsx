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
  listWorkers: ReturnType<typeof vi.fn>
}

const runningWorker = (workerId: string, title: string) => ({
  worker_id: workerId,
  manager_key: 'wechat::sess-1',
  task: { id: `task-${workerId}`, title, status: 'running', created_at: '2026-08-01T10:00:00.000Z' },
  origin: { trigger_type: 'message' },
  report_to: { channel_id: 'wechat', session_id: 'sess-1' },
  incarnations: [],
  updated_at: '2026-08-01T10:00:00.000Z',
})

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
  beforeEach(() => {
    vi.resetAllMocks()
    mocked.listManagers = vi.fn().mockResolvedValue({
      items: [{ manager_key: 'wechat::sess-1', display_name: '微信 · 测试会话', active_worker_count: 1 }],
      pagination: { page: 1, page_size: 100, total_items: 1, total_pages: 1 },
    })
    mocked.listWorkers = vi.fn().mockResolvedValue({
      items: [],
      pagination: { page: 1, page_size: 100, total_items: 0, total_pages: 1 },
    })
  })

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
    expect(screen.getByRole('heading', { name: '微信 · 测试会话', level: 1 })).toBeInTheDocument()
    expect(screen.getByText(/还没有，我已经重新派活/)).toBeInTheDocument()
    expect(screen.getByText('派给执行器')).toBeInTheDocument()
    const workerLink = screen.getByText('部署 V6').closest('a')!
    expect(workerLink.getAttribute('href')).toBe(`/traces/workers/${encodeURIComponent('w-abc123456789')}`)
    // completed/trace id 默认隐藏，技术详情展开后才出现。
    expect(screen.queryByText('completed')).toBeNull()
    expect(screen.queryByText(/ep-12345678-abcd/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '查看技术详情' }))
    expect(screen.getByText(/ep-12345678-abcd/)).toBeInTheDocument()
  })

  it('worker 进展按 spawn worker_id 收进人类消息的因果链', async () => {
    mocked.listManagerEpisodes = vi.fn().mockResolvedValue({
      items: [
        {
          trace_id: 'ep-progress', manager_key: 'wechat::sess-1', started_at: '2026-08-01T10:01:00.000Z', status: 'completed',
          trigger: { type: 'worker_event', summary: 'worker event', source: 'worker:w-1' }, spans: [], spawned_worker_ids: [],
          worker_ref: { worker_id: 'w-1', title: '部署 V6', state_to: 'halted' },
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
    expect(screen.getAllByText('部署 V6').length).toBeGreaterThan(0)
    expect(screen.getByText('等待输入')).toBeInTheDocument()
  })

  it('带回复或操作的 worker_event 保持自己的时间线位置', async () => {
    mocked.listManagerEpisodes = vi.fn().mockResolvedValue({
      items: [
        {
          trace_id: 'ep-late-reply', manager_key: 'wechat::sess-1', started_at: '2026-08-01T10:10:00.000Z', status: 'completed',
          trigger: { type: 'worker_event', summary: 'worker event', source: 'worker:w-1' }, spans: [], spawned_worker_ids: [],
          worker_ref: { worker_id: 'w-1', title: '部署 V6', state_to: 'halted' },
          reply_excerpt: '该执行器当前无法投递，已请求中断。',
          actions: [{ kind: 'other', label: '请求中断：部署 V6', worker_id: 'w-1' }],
          causal_parent: {
            trace_id: 'ep-old-parent', started_at: '2026-08-01T10:00:00.000Z', status: 'completed',
            trigger: { type: 'human_message', summary: '人类消息 x1：开始部署' },
            actions: [{ kind: 'spawn_worker', label: '派活：部署 V6', worker_id: 'w-1' }],
          },
        },
        {
          trace_id: 'ep-old-parent', manager_key: 'wechat::sess-1', started_at: '2026-08-01T10:00:00.000Z', status: 'completed',
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
    await waitFor(() => expect(document.querySelector('.manager-detail__reply')).toHaveTextContent('该执行器当前无法投递，已请求中断。'))
    const replyCard = document.querySelector('.manager-detail__reply')?.closest('article.manager-detail__event')
    expect(replyCard).not.toBeNull()
    expect(replyCard).toHaveTextContent('请求中断：部署 V6')
    expect(replyCard?.querySelector('a[href="/traces/workers/w-1"]')).not.toBeNull()
    expect(document.querySelectorAll('article.manager-detail__event')).toHaveLength(2)
  })

  it('同一执行器的多次进展默认折叠，只展示最后状态', async () => {
    mocked.listManagerEpisodes = vi.fn().mockResolvedValue({
      items: [
        {
          trace_id: 'ep-progress-latest', manager_key: 'wechat::sess-1', started_at: '2026-08-01T10:03:00.000Z', status: 'completed',
          trigger: { type: 'worker_event', summary: 'worker event', source: 'worker:w-1' }, spans: [], spawned_worker_ids: [],
          worker_ref: { worker_id: 'w-1', title: '部署 V6', state_to: 'halted' },
        },
        {
          trace_id: 'ep-progress-running', manager_key: 'wechat::sess-1', started_at: '2026-08-01T10:02:00.000Z', status: 'completed',
          trigger: { type: 'worker_event', summary: 'worker event', source: 'worker:w-1' }, spans: [], spawned_worker_ids: [],
          worker_ref: { worker_id: 'w-1', title: '部署 V6', state_to: 'running' },
        },
        {
          trace_id: 'ep-progress-queued', manager_key: 'wechat::sess-1', started_at: '2026-08-01T10:01:00.000Z', status: 'completed',
          trigger: { type: 'worker_event', summary: 'worker event', source: 'worker:w-1' }, spans: [], spawned_worker_ids: [],
          worker_ref: { worker_id: 'w-1', title: '部署 V6', state_to: 'queued' },
        },
        {
          trace_id: 'ep-parent', manager_key: 'wechat::sess-1', started_at: '2026-08-01T10:00:00.000Z', status: 'completed',
          trigger: { type: 'human_message', summary: '人类消息 x1：开始部署' }, spans: [], spawned_worker_ids: ['w-1'],
          actions: [{ kind: 'spawn_worker', label: '派活：部署 V6', worker_id: 'w-1' }],
        },
      ],
      pagination: { page: 1, page_size: 20, total_items: 4, total_pages: 1 },
    })
    render(
      <MemoryRouter initialEntries={[`/traces/managers/${encodeURIComponent('wechat::sess-1')}`]}>
        <Routes><Route path="/traces/managers/:managerKey" element={<ManagerDetail />} /></Routes>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('你：「开始部署」')).toBeInTheDocument())
    expect(screen.getByText('等待输入')).toBeInTheDocument()
    expect(screen.queryByText('执行中')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '展开 2 次历史进展' }))
    expect(screen.getByText('执行中')).toBeInTheDocument()
    expect(screen.getByText('排队')).toBeInTheDocument()
  })

  it('同一执行器的回复事件不折叠，并按自己的时间显示', async () => {
    mocked.listManagerEpisodes = vi.fn().mockResolvedValue({
      items: [
        {
          trace_id: 'ep-progress-latest', manager_key: 'wechat::sess-1', started_at: '2026-08-01T10:03:00.000Z', status: 'completed',
          trigger: { type: 'worker_event', summary: 'worker event', source: 'worker:w-1' }, spans: [], spawned_worker_ids: [],
          worker_ref: { worker_id: 'w-1', title: '部署 V6', state_to: 'halted' },
        },
        {
          trace_id: 'ep-progress-message', manager_key: 'wechat::sess-1', started_at: '2026-08-01T10:02:00.000Z', status: 'completed',
          trigger: { type: 'worker_event', summary: 'worker event', source: 'worker:w-1' }, spans: [], spawned_worker_ids: [],
          worker_ref: { worker_id: 'w-1', title: '部署 V6', state_to: 'running' },
          reply_excerpt: '21:26 更新：已完成 44 批。',
        },
        {
          trace_id: 'ep-progress-queued', manager_key: 'wechat::sess-1', started_at: '2026-08-01T10:01:00.000Z', status: 'completed',
          trigger: { type: 'worker_event', summary: 'worker event', source: 'worker:w-1' }, spans: [], spawned_worker_ids: [],
          worker_ref: { worker_id: 'w-1', title: '部署 V6', state_to: 'queued' },
        },
        {
          trace_id: 'ep-parent', manager_key: 'wechat::sess-1', started_at: '2026-08-01T10:00:00.000Z', status: 'completed',
          trigger: { type: 'human_message', summary: '人类消息 x1：开始部署' }, spans: [], spawned_worker_ids: ['w-1'],
          actions: [{ kind: 'spawn_worker', label: '派活：部署 V6', worker_id: 'w-1' }],
        },
      ],
      pagination: { page: 1, page_size: 20, total_items: 4, total_pages: 1 },
    })
    render(
      <MemoryRouter initialEntries={[`/traces/managers/${encodeURIComponent('wechat::sess-1')}`]}>
        <Routes><Route path="/traces/managers/:managerKey" element={<ManagerDetail />} /></Routes>
      </MemoryRouter>,
    )
    await waitFor(() => expect(document.querySelector('.manager-detail__reply')).toHaveTextContent('21:26 更新：已完成 44 批。'))
    const replyCard = document.querySelector('.manager-detail__reply')?.closest('article.manager-detail__event')
    expect(replyCard).not.toBeNull()
    expect(replyCard?.querySelector('.manager-detail__event-time')).not.toBeNull()
    expect(screen.queryByText('已发送消息')).toBeNull()
    expect(screen.getByRole('button', { name: '展开 1 次历史进展' })).toBeInTheDocument()
    expect(screen.queryByText('排队')).toBeNull()
  })

  it('spawn 父 episode 不在当前分页时，用 causal_parent 仍按因果链展示', async () => {
    mocked.listManagerEpisodes = vi.fn().mockResolvedValue({
      items: [{
        trace_id: 'ep-progress-only', manager_key: 'wechat::sess-1', started_at: '2026-08-02T10:01:00.000Z', status: 'completed',
        trigger: { type: 'worker_event', summary: 'worker event', source: 'worker:w-1' }, spans: [], spawned_worker_ids: [],
        worker_ref: { worker_id: 'w-1', title: '长任务', state_to: 'running' },
        causal_parent: {
          trace_id: 'ep-old-parent', started_at: '2026-07-01T10:00:00.000Z', status: 'failed',
          trigger: { type: 'human_message', summary: '人类消息 x1：开始长任务' },
          outcome: { summary: 'failed', error: '真实父失败' },
          actions: [{ kind: 'spawn_worker', label: '派活：长任务', worker_id: 'w-1' }],
        },
      }],
      pagination: { page: 1, page_size: 20, total_items: 21, total_pages: 2 },
    })
    render(
      <MemoryRouter initialEntries={[`/traces/managers/${encodeURIComponent('wechat::sess-1')}`]}>
        <Routes><Route path="/traces/managers/:managerKey" element={<ManagerDetail />} /></Routes>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('你：「开始长任务」')).toBeInTheDocument())
    expect(screen.getByText(/失败原因：真实父失败/)).toBeInTheDocument()
    expect(screen.getAllByText('长任务').length).toBeGreaterThan(0)
    expect(screen.getByText('执行中')).toBeInTheDocument()
  })

  it('worker_event 自己派新 worker 时归到同一根链，不重复顶层卡且保留失败状态', async () => {
    mocked.listManagerEpisodes = vi.fn().mockResolvedValue({
      items: [
        {
          trace_id: 'ep-child', manager_key: 'wechat::sess-1', started_at: '2026-08-01T10:02:00.000Z', status: 'completed',
          trigger: { type: 'worker_event', summary: 'child', source: 'worker:w-b' }, spans: [], spawned_worker_ids: [],
          worker_ref: { worker_id: 'w-b', title: '子任务 B', state_to: 'completed' },
          causal_parent: { trace_id: 'ep-middle', started_at: '2026-08-01T10:01:00.000Z', status: 'failed', trigger: { type: 'worker_event', summary: 'middle', source: 'worker:w-a' } },
        },
        {
          trace_id: 'ep-middle', manager_key: 'wechat::sess-1', started_at: '2026-08-01T10:01:00.000Z', status: 'failed',
          trigger: { type: 'worker_event', summary: 'middle', source: 'worker:w-a' }, spans: [], spawned_worker_ids: ['w-b'],
          worker_ref: { worker_id: 'w-a', title: '任务 A', state_to: 'failed' }, outcome: { summary: 'failed', error: '真实失败' },
          reply_excerpt: '任务 A 失败，我已派子任务 B 接手。',
          actions: [{ kind: 'spawn_worker', label: '派活：子任务 B', worker_id: 'w-b' }],
          causal_parent: { trace_id: 'ep-root', started_at: '2026-08-01T10:00:00.000Z', status: 'completed', trigger: { type: 'human_message', summary: '人类消息 x1：开始根任务' } },
        },
        {
          trace_id: 'ep-root', manager_key: 'wechat::sess-1', started_at: '2026-08-01T10:00:00.000Z', status: 'completed',
          trigger: { type: 'human_message', summary: '人类消息 x1：开始根任务' }, spans: [], spawned_worker_ids: ['w-a'],
          actions: [{ kind: 'spawn_worker', label: '派活：任务 A', worker_id: 'w-a' }],
        },
      ],
      pagination: { page: 1, page_size: 20, total_items: 3, total_pages: 1 },
    })
    render(
      <MemoryRouter initialEntries={[`/traces/managers/${encodeURIComponent('wechat::sess-1')}`]}>
        <Routes><Route path="/traces/managers/:managerKey" element={<ManagerDetail />} /></Routes>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('你：「开始根任务」')).toBeInTheDocument())
    expect(screen.getAllByRole('button', { name: '查看技术详情' })).toHaveLength(3)
    expect(screen.getAllByText('任务 A').length).toBeGreaterThan(0)
    expect(screen.getAllByText('子任务 B').length).toBeGreaterThan(0)
    expect(screen.getByText('已完成')).toBeInTheDocument()
    expect(screen.getByText(/失败原因：真实失败/)).toBeInTheDocument()
    expect(screen.getByText(/任务 A 失败，我已派子任务 B 接手/)).toBeInTheDocument()
    expect(screen.getAllByText('派给执行器')).toHaveLength(2)
  })

  it('当前执行者来自独立 running 快照，未结束不冒充正在执行', async () => {
    mocked.listManagers = vi.fn().mockResolvedValue({
      items: [{ manager_key: 'wechat::sess-1', display_name: '微信 · 测试会话', active_worker_count: 11 }],
      pagination: { page: 1, page_size: 100, total_items: 1, total_pages: 1 },
    })
    mocked.listWorkers = vi.fn().mockResolvedValue({
      items: [runningWorker('w-running', '继续 r36 门禁')],
      pagination: { page: 1, page_size: 100, total_items: 1, total_pages: 1 },
    })
    mocked.listManagerEpisodes = vi.fn().mockResolvedValue({
      items: [{
        trace_id: 'ep-send', manager_key: 'wechat::sess-1', started_at: '2026-08-01T10:00:00.000Z', status: 'completed',
        trigger: { type: 'human_message', summary: '人类消息 x1：继续' }, spans: [], spawned_worker_ids: [],
        actions: [{ kind: 'send_to_worker', label: '跟进：继续 r36 门禁', worker_id: 'w-running' }],
      }],
      pagination: { page: 1, page_size: 20, total_items: 1, total_pages: 1 },
    })
    render(
      <MemoryRouter initialEntries={[`/traces/managers/${encodeURIComponent('wechat::sess-1')}`]}>
        <Routes><Route path="/traces/managers/:managerKey" element={<ManagerDetail />} /></Routes>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getAllByText('继续 r36 门禁')).toHaveLength(2))
    expect(mocked.listWorkers).toHaveBeenCalledWith({ manager_key: 'wechat::sess-1', status: 'running', page: 1, page_size: 100 })
    expect(screen.getByText('未结束').parentElement).toHaveTextContent('11 个')
    expect(screen.queryByText('进行中')).toBeNull()
    expect(screen.getByText('正在执行')).toBeInTheDocument()
    expect(screen.getAllByText('继续 r36 门禁')).toHaveLength(2)
    expect(screen.getByText('继续交给执行器')).toBeInTheDocument()
    expect(screen.getAllByText('w-running')).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'w-running' })).toHaveAttribute('href', '/traces/workers/w-running')
    expect(screen.getByText('当前：执行中')).toBeInTheDocument()
  })

  it('当前执行者读取所有分页结果', async () => {
    mocked.listWorkers = vi.fn()
      .mockResolvedValueOnce({
        items: [runningWorker('w-page-1', '第一页执行器')],
        pagination: { page: 1, page_size: 100, total_items: 2, total_pages: 2 },
      })
      .mockResolvedValueOnce({
        items: [runningWorker('w-page-2', '第二页执行器')],
        pagination: { page: 2, page_size: 100, total_items: 2, total_pages: 2 },
      })
    mocked.listManagerEpisodes = vi.fn().mockResolvedValue({
      items: [{
        trace_id: 'ep-paged', manager_key: 'wechat::sess-1', started_at: '2026-08-01T10:00:00.000Z', status: 'completed',
        trigger: { type: 'human_message', summary: '人类消息 x1：查看状态' }, spans: [], spawned_worker_ids: [],
      }],
      pagination: { page: 1, page_size: 20, total_items: 1, total_pages: 1 },
    })
    render(
      <MemoryRouter initialEntries={[`/traces/managers/${encodeURIComponent('wechat::sess-1')}`]}>
        <Routes><Route path="/traces/managers/:managerKey" element={<ManagerDetail />} /></Routes>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('第二页执行器')).toBeInTheDocument())
    expect(mocked.listWorkers).toHaveBeenNthCalledWith(2, { manager_key: 'wechat::sess-1', status: 'running', page: 2, page_size: 100 })
  })

  it('当前执行者完整读取分页，任一页失败则显示 unknown 而不显示部分结果', async () => {
    mocked.listWorkers = vi.fn()
      .mockResolvedValueOnce({
        items: [runningWorker('w-page-1', '第一页执行器')],
        pagination: { page: 1, page_size: 100, total_items: 2, total_pages: 2 },
      })
      .mockRejectedValueOnce(new Error('next page unavailable'))
    mocked.listManagerEpisodes = vi.fn().mockResolvedValue({
      items: [{
        trace_id: 'ep-empty', manager_key: 'wechat::sess-1', started_at: '2026-08-01T10:00:00.000Z', status: 'completed',
        trigger: { type: 'human_message', summary: '人类消息 x1：查看状态' }, spans: [], spawned_worker_ids: [],
      }],
      pagination: { page: 1, page_size: 20, total_items: 1, total_pages: 1 },
    })
    render(
      <MemoryRouter initialEntries={[`/traces/managers/${encodeURIComponent('wechat::sess-1')}`]}>
        <Routes><Route path="/traces/managers/:managerKey" element={<ManagerDetail />} /></Routes>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('暂不可用（unknown）')).toBeInTheDocument())
    expect(mocked.listWorkers).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('第一页执行器')).toBeNull()
  })

  it('在对话与操作和技术事件之间切换，不暴露内部 key 作为标题', async () => {
    mocked.listManagerEpisodes = vi.fn().mockResolvedValue({
      items: [{
        trace_id: 'ep-technical', manager_key: 'wechat::sess-1', started_at: '2026-08-01T10:00:00.000Z', status: 'completed',
        trigger: { type: 'human_message', summary: '人类消息 x1：查看记录' }, spans: [], spawned_worker_ids: [],
      }],
      pagination: { page: 1, page_size: 20, total_items: 1, total_pages: 1 },
    })
    render(
      <MemoryRouter initialEntries={[`/traces/managers/${encodeURIComponent('wechat::sess-1')}`]}>
        <Routes><Route path="/traces/managers/:managerKey" element={<ManagerDetail />} /></Routes>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByRole('tab', { name: '对话与操作' })).toHaveAttribute('aria-selected', 'true'))
    expect(screen.queryByRole('heading', { name: 'wechat::sess-1' })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: '技术事件' }))
    expect(screen.getByRole('tab', { name: '技术事件' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('第 1 / 1 页')).toBeInTheDocument()
  })
})
