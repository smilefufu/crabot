/**
 * P6-A §10 UI 测试：Worker 视图过滤、详情页化身链、终端画面刷新与 degraded 显示。
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
  getWorkerTerminal: ReturnType<typeof vi.fn>
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
      { seq: 2, impl: 'builtin' as const, state: 'running', workspace: '/tmp/ws', started_at: '2026-08-01T00:05:00.000Z', session_ref: 'r2', forked_from: 1 },
    ],
    updated_at: '2026-08-01T00:05:00.000Z',
  }
}

function legacyWorkerFixture() {
  const worker = workerFixture()
  return {
    ...worker,
    incarnations: [
      { seq: 1, impl: 'legacy' as const, state: 'exited', started_at: '2026-08-01T00:00:00.000Z', ended_at: '2026-08-01T00:01:00.000Z', ended_reason: 'pre_migration', session_ref: 'legacy-1' },
    ],
    legacy_source: { trace_ids: ['legacy-trace-1'] },
  }
}

function listResult() {
  return {
    items: [workerFixture()],
    total_active: 0,
    total_terminal: 1,
    total_legacy: 0,
    pagination: { page: 1, page_size: 20, total_items: 1, total_pages: 1 },
  }
}

describe('WorkersView', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('status 过滤透传 query，翻页重置', async () => {
    mocked.listWorkers = vi.fn().mockResolvedValue(listResult())
    render(
      <MemoryRouter>
        <WorkersView />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('任务标题')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('状态过滤'), { target: { value: 'failed' } })
    await waitFor(() => expect(mocked.listWorkers).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed', include_terminal: true, page: 1 })))
  })

  it('worker 链接到详情，manager 链接到 manager 详情', async () => {
    mocked.listWorkers = vi.fn().mockResolvedValue(listResult())
    render(
      <MemoryRouter>
        <WorkersView />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('任务标题')).toBeInTheDocument())
    expect(screen.getByText('任务标题').closest('a')!.getAttribute('href')).toBe(`/traces/workers/${encodeURIComponent('w-1234567890ab')}`)
    expect(screen.getByText('w-1234567890')).toBeInTheDocument()
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

  it('化身链 + 时间线增量读取 + 终端画面首次加载', async () => {
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
    mocked.getWorkerTerminal = vi.fn().mockResolvedValue({ kind: 'live_terminal', text: '当前画面', captured_at: '2026-08-01T00:00:00.000Z' })

    renderDetail()
    await waitFor(() => expect(screen.getByText('已启动')).toBeInTheDocument())
    // 化身链两行
    expect(screen.getByRole('button', { name: /#1.*主线/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /#2.*临时侧问/ })).toBeInTheDocument()

    await waitFor(() => expect(screen.getByText('当前画面')).toBeInTheDocument())
    expect(mocked.getWorkerTerminal).toHaveBeenCalledWith('w-1234567890ab', { seq: 1 })
  })

  it('native degraded 时 harness 事件仍显示，且 reason 独立呈现', async () => {
    mocked.getWorkerDetail = vi.fn().mockResolvedValue({ worker: workerFixture() })
    mocked.getWorkerTrace = vi.fn().mockResolvedValue({
      events: [{ ts: '2026-08-01T00:00:01.000Z', kind: 'lifecycle', summary: 'spawned', source: 'harness' }],
      next_cursor: 'tok-1',
      unavailable_reason: 'native unavailable: file gone',
    })
    mocked.getWorkerTerminal = vi.fn().mockResolvedValue({ kind: 'unavailable', unavailable_reason: 'terminal_capture_failed' })
    renderDetail()
    await waitFor(() => expect(screen.getByText('已启动')).toBeInTheDocument())
    expect(screen.getByText(/native unavailable/)).toBeInTheDocument()
  })

  it('legacy 化身在默认活动流回退到历史摘要', async () => {
    mocked.getWorkerDetail = vi.fn().mockResolvedValue({ worker: legacyWorkerFixture() })
    mocked.getWorkerTrace = vi.fn().mockResolvedValue({
      events: [{ ts: '2026-08-01T00:00:01.000Z', kind: 'lifecycle', summary: '旧版任务已完成', source: 'legacy' }],
      next_cursor: 'tok-1',
    })
    mocked.getWorkerTerminal = vi.fn().mockResolvedValue({ kind: 'unavailable', unavailable_reason: 'legacy_without_terminal_snapshot' })
    renderDetail()

    await waitFor(() => expect(screen.getByText('历史记录')).toBeInTheDocument())
    expect(screen.getByText('旧版任务已完成')).toBeInTheDocument()
    expect(screen.queryByText('该化身暂无可读活动。')).not.toBeInTheDocument()
  })

  it('切换临时侧问后，活动流与终端输出同步切换', async () => {
    mocked.getWorkerDetail = vi.fn().mockResolvedValue({ worker: workerFixture() })
    mocked.getWorkerTrace = vi.fn().mockResolvedValue({ events: [], next_cursor: 'tok-1' })
    mocked.getWorkerTerminal = vi.fn().mockResolvedValue({ kind: 'headless_text', text: '侧问文本' })
    renderDetail()

    await waitFor(() => expect(screen.getByRole('button', { name: /#2.*临时侧问/ })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /#2.*临时侧问/ }))
    await waitFor(() => expect(mocked.getWorkerTrace).toHaveBeenLastCalledWith('w-1234567890ab', { seq: 2 }))
    expect(mocked.getWorkerTerminal).toHaveBeenLastCalledWith('w-1234567890ab', { seq: 2 })
  })

  it('投递失败和异常退出保留在默认活动流', async () => {
    mocked.getWorkerDetail = vi.fn().mockResolvedValue({ worker: workerFixture() })
    mocked.getWorkerTrace = vi.fn().mockResolvedValue({
      events: [
        { ts: '2026-08-01T00:00:01.000Z', kind: 'lifecycle', summary: 'input_delivery_failed reason_code=delivery_deadline_exceeded', source: 'harness', detail: { reason: '投递期限已过' } },
        { ts: '2026-08-01T00:00:02.000Z', kind: 'lifecycle', summary: 'state_changed -> exited', source: 'harness', detail: { to: 'exited', reason: 'adapter crashed' } },
      ],
      next_cursor: 'tok-1',
    })
    mocked.getWorkerTerminal = vi.fn().mockResolvedValue({ kind: 'live_terminal', text: '', captured_at: '2026-08-01T00:00:00.000Z' })
    renderDetail()

    await waitFor(() => expect(screen.getByText('投递失败')).toBeInTheDocument())
    expect(screen.getByText('投递期限已过')).toBeInTheDocument()
    expect(screen.getByText('Worker 异常退出')).toBeInTheDocument()
    expect(screen.getByText('已结束：adapter crashed')).toBeInTheDocument()
  })

  it('Claude Code 的工具参数与结果内容使用已归一化 detail', async () => {
    mocked.getWorkerDetail = vi.fn().mockResolvedValue({ worker: workerFixture() })
    mocked.getWorkerTrace = vi.fn().mockResolvedValue({
      events: [
        { ts: '2026-08-01T00:00:01.000Z', kind: 'tool_call', role: 'assistant', summary: 'Read(...)', source: 'native', detail: { name: 'Read', input: { file_path: '/tmp/x.ts' } } },
        { ts: '2026-08-01T00:00:02.000Z', kind: 'tool_result', role: 'user', summary: '文件内容摘要', source: 'native', detail: { content: '文件内容摘要' } },
      ],
      next_cursor: 'tok-1',
    })
    mocked.getWorkerTerminal = vi.fn().mockResolvedValue({ kind: 'live_terminal', text: '', captured_at: '2026-08-01T00:00:00.000Z' })
    renderDetail()

    await waitFor(() => expect(screen.getByText('Read')).toBeInTheDocument())
    expect(screen.getByText('{"file_path":"/tmp/x.ts"}')).toBeInTheDocument()
    expect(screen.getByText('文件内容摘要')).toBeInTheDocument()
  })

  it('默认选择主线，并把消息、工具与技术事件分开显示', async () => {
    const instruction = '请先在隔离环境验证坐标与朝向，再比较五个非对称地标。'.repeat(20)
    mocked.getWorkerDetail = vi.fn().mockResolvedValue({ worker: workerFixture() })
    mocked.getWorkerTrace = vi.fn().mockResolvedValue({
      events: [
        { ts: '2026-08-01T00:00:01.000Z', kind: 'lifecycle', role: 'system', summary: 'item_completed', source: 'native' },
        { ts: '2026-08-01T00:00:02.000Z', kind: 'message', role: 'user', summary: instruction.slice(0, 200), source: 'native', detail: { content: [{ type: 'input_text', text: instruction }] } },
        { ts: '2026-08-01T00:00:03.000Z', kind: 'tool_call', role: 'assistant', summary: 'shell()', source: 'native', detail: { call_id: 'call-1', name: 'shell', arguments: '读取验证报告' } },
        { ts: '2026-08-01T00:00:04.000Z', kind: 'tool_result', summary: '完成', source: 'native', detail: { call_id: 'call-1', output: '已完成隔离环境读取' } },
        { ts: '2026-08-01T00:00:05.000Z', kind: 'message', role: 'assistant', summary: '正在重新验证方向', source: 'native', detail: { content: [{ type: 'output_text', text: '正在重新验证方向，正式端口尚未切换。' }] } },
      ],
      next_cursor: 'tok-1',
    })
    mocked.getWorkerTerminal = vi.fn().mockResolvedValue({ kind: 'live_terminal', text: '', captured_at: '2026-08-01T00:00:00.000Z' })

    renderDetail()

    await waitFor(() => expect(screen.getByText('Manager 指令')).toBeInTheDocument())
    expect(screen.getByText('Worker 输出')).toBeInTheDocument()
    expect(screen.getByText('工具调用')).toBeInTheDocument()
    expect(screen.getByText('工具结果')).toBeInTheDocument()
    expect(screen.queryByText('item_completed')).not.toBeInTheDocument()
    expect(screen.getByText('主线实现：').parentElement).toHaveTextContent('内置')
    expect(mocked.getWorkerTrace).toHaveBeenCalledWith('w-1234567890ab', { seq: 1 })
    expect(mocked.getWorkerTerminal).toHaveBeenCalledWith('w-1234567890ab', { seq: 1 })

    fireEvent.click(screen.getByRole('button', { name: '展开全文' }))
    expect(screen.getByRole('button', { name: '收起' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '技术事件 1' }))
    expect(screen.getByText('item_completed')).toBeInTheDocument()
  })
})
