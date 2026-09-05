/**
 * P6-A §10 UI 测试：Worker 视图过滤、详情页化身链、终端画面刷新与 degraded 显示。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { WorkersView } from './WorkersView'
import { WorkerDetail } from './WorkerDetail'
import { SubagentDetail } from './SubagentDetail'
import { agentObservabilityService } from '../../services/agent-observability'

vi.mock('../../services/agent-observability')
vi.mock('../../components/Layout/MainLayout', () => ({
  MainLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

const mocked = agentObservabilityService as unknown as {
  listManagers: ReturnType<typeof vi.fn>
  listWorkers: ReturnType<typeof vi.fn>
  getWorkerDetail: ReturnType<typeof vi.fn>
  getWorkerTrace: ReturnType<typeof vi.fn>
  getWorkerTerminal: ReturnType<typeof vi.fn>
  listWorkerSubagents: ReturnType<typeof vi.fn>
  getWorkerSubagentDetail: ReturnType<typeof vi.fn>
  getWorkerSubagentTrace: ReturnType<typeof vi.fn>
}

function workerFixture() {
  return {
    worker_id: 'w-1234567890ab',
    manager_key: 'wechat::sess-1',
    task: {
      id: 'w-1234567890ab', title: '任务标题', status: 'halted', created_at: '2026-08-01T00:00:00.000Z',
      halt: { halted_at: '2026-08-01T02:00:00.000Z', halt_reason: 'worker_finalized', worker_self_report: { outcome: 'completed', summary: '接口契约核对完毕' } },
    },
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
    fireEvent.change(screen.getByLabelText('状态过滤'), { target: { value: 'halted' } })
    await waitFor(() => expect(mocked.listWorkers).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'halted', page: 1 })))
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
  beforeEach(() => {
    vi.resetAllMocks()
    mocked.listManagers = vi.fn().mockResolvedValue({
      items: [{ manager_key: 'wechat::sess-1', display_name: '微信 · 测试账号 · 小付', active_worker_count: 0 }],
      pagination: { page: 1, page_size: 100, total_items: 1, total_pages: 1 },
    })
    mocked.listWorkerSubagents = vi.fn().mockResolvedValue({ subagents: [] })
  })

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

  it('临时侧问化身显示 Manager 输入、执行器输出和完成状态', async () => {
    mocked.getWorkerDetail = vi.fn().mockResolvedValue({ worker: workerFixture() })
    mocked.getWorkerTrace = vi.fn().mockImplementation(async (_workerId: string, opts?: { seq?: number }) => ({
      events: opts?.seq === 2
        ? [
            { ts: '2026-08-01T00:05:01.000Z', kind: 'message' as const, role: 'user' as const, summary: '现在进展如何？', source: 'native' as const, detail: { content: '现在进展如何？' } },
            { ts: '2026-08-01T00:05:02.000Z', kind: 'message' as const, role: 'assistant' as const, summary: '已完成接口核对。', source: 'native' as const, detail: { content: '已完成接口核对。' } },
            { ts: '2026-08-01T00:05:03.000Z', kind: 'lifecycle' as const, summary: 'query_completed query_id=q-1 fork_seq=2', source: 'harness' as const, detail: { query_id: 'q-1', fork_seq: 2 } },
          ]
        : [],
      next_cursor: 'tok-1',
    }))
    mocked.getWorkerTerminal = vi.fn().mockResolvedValue({ kind: 'headless_text', text: '已完成接口核对。', captured_at: '2026-08-01T00:05:02.000Z' })
    renderDetail()

    await waitFor(() => expect(screen.getByRole('button', { name: /#2.*临时侧问/ })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /#2.*临时侧问/ }))

    expect(await screen.findByRole('button', { name: /管理会话指令：现在进展如何？/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Worker 文本：已完成接口核对。/ })).toBeInTheDocument()
    expect(screen.getByText('侧问完成')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /侧问完成：临时侧问已完成/ })).toBeInTheDocument()
  })

  it('临时侧问错误在默认活动流中显示', async () => {
    mocked.getWorkerDetail = vi.fn().mockResolvedValue({ worker: workerFixture() })
    mocked.getWorkerTrace = vi.fn().mockResolvedValue({
      events: [{
        ts: '2026-08-01T00:05:02.000Z',
        kind: 'error',
        summary: 'query fork failed',
        source: 'native',
        detail: { message: '上游模型拒绝了侧问' },
      }],
      next_cursor: 'tok-1',
    })
    mocked.getWorkerTerminal = vi.fn().mockResolvedValue({ kind: 'headless_text', text: '', captured_at: '2026-08-01T00:05:02.000Z' })
    renderDetail()

    expect(await screen.findByRole('button', { name: /执行器错误：上游模型拒绝了侧问/ })).toBeInTheDocument()
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
    expect(screen.getByText('任务异常退出')).toBeInTheDocument()
    expect(screen.getByText('已结束：adapter crashed')).toBeInTheDocument()
  })

  it('Claude Code 无关联 ID 的工具结果按原生顺序合并到调用', async () => {
    mocked.getWorkerDetail = vi.fn().mockResolvedValue({ worker: workerFixture() })
    mocked.getWorkerTrace = vi.fn().mockResolvedValue({
      events: [
        { ts: '2026-08-01T00:00:01.000Z', kind: 'tool_call', role: 'assistant', summary: 'Read(...)', source: 'native', detail: { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/x.ts' } } },
        { ts: '2026-08-01T00:00:02.000Z', kind: 'tool_result', role: 'user', summary: '文件内容摘要', source: 'native', detail: { content: '文件内容摘要' } },
      ],
      next_cursor: 'tok-1',
    })
    mocked.getWorkerTerminal = vi.fn().mockResolvedValue({ kind: 'live_terminal', text: '', captured_at: '2026-08-01T00:00:00.000Z' })
    renderDetail()

    const toolCall = await screen.findByRole('button', { name: /工具调用：调用 Read.*展开详情/ })
    expect(toolCall).toHaveAccessibleName(/已返回结果/)
    expect(screen.queryByRole('button', { name: /工具结果：工具结果/ })).not.toBeInTheDocument()
    fireEvent.click(toolCall)
    expect(screen.getByText('输入 · Read')).toBeInTheDocument()
    expect(screen.getByText(/"file_path": "\/tmp\/x\.ts"/)).toBeInTheDocument()
    expect(screen.getByText('输出')).toBeInTheDocument()
    expect(screen.getByText('文件内容摘要')).toBeInTheDocument()
  })

  it('已确认子 Agent 身份的 Worker Trace 可直接打开该子 Agent 详情', async () => {
    mocked.getWorkerDetail = vi.fn().mockResolvedValue({ worker: workerFixture() })
    mocked.getWorkerTrace = vi.fn().mockResolvedValue({
      events: [
        { ts: '2026-08-01T00:00:01.000Z', kind: 'tool_call', summary: 'delegate_task', source: 'native', detail: { call_id: 'delegate-1', name: 'delegate_task', input: { task: '核对数据' } } },
        { ts: '2026-08-01T00:00:02.000Z', kind: 'tool_result', summary: '子 Agent 已启动', source: 'native', subagent_id: 'agent-child-1', detail: { call_id: 'delegate-1', output: '子 Agent 已启动' } },
      ],
      next_cursor: 'tok-1',
    })
    mocked.getWorkerTerminal = vi.fn().mockResolvedValue({ kind: 'live_terminal', text: '', captured_at: '2026-08-01T00:00:00.000Z' })
    renderDetail()

    const toolRow = await screen.findByRole('button', { name: /工具调用：调用 delegate_task · 已返回结果.*展开详情/ })
    fireEvent.click(toolRow)
    expect(screen.getByRole('link', { name: '查看子 Agent' })).toHaveAttribute(
      'href',
      `/traces/workers/${encodeURIComponent('w-1234567890ab')}/subagents/${encodeURIComponent('agent-child-1')}`,
    )
  })

  it('未发现子 Agent 时不显示子 Agent 区块', async () => {
    mocked.getWorkerDetail = vi.fn().mockResolvedValue({ worker: workerFixture() })
    mocked.getWorkerTrace = vi.fn().mockResolvedValue({ events: [], next_cursor: 'tok-1' })
    mocked.getWorkerTerminal = vi.fn().mockResolvedValue({ kind: 'live_terminal', text: '', captured_at: '2026-08-01T00:00:00.000Z' })
    renderDetail()

    await waitFor(() => expect(mocked.listWorkerSubagents).toHaveBeenCalledWith('w-1234567890ab'))
    expect(screen.queryByRole('heading', { name: '子 Agent' })).not.toBeInTheDocument()
    expect(screen.queryByText('该 Worker 尚未启动子 Agent。')).not.toBeInTheDocument()
  })

  it('直接启动的子 Agent 显示任务、状态、时间和详情链接', async () => {
    mocked.getWorkerDetail = vi.fn().mockResolvedValue({ worker: workerFixture() })
    mocked.getWorkerTrace = vi.fn().mockResolvedValue({ events: [], next_cursor: 'tok-1' })
    mocked.getWorkerTerminal = vi.fn().mockResolvedValue({ kind: 'live_terminal', text: '', captured_at: '2026-08-01T00:00:00.000Z' })
    mocked.listWorkerSubagents = vi.fn().mockResolvedValue({
      subagents: [{
        subagent_id: 'agent-child-1', worker_id: 'w-1234567890ab', executor_impl: 'builtin', type: 'code_writer',
        name: '代码助手', task: '核对接口契约', status: 'completed',
        started_at: '2026-08-01T00:00:00.000Z', ended_at: '2026-08-01T00:02:00.000Z',
      }],
    })
    renderDetail()

    await screen.findByText('代码助手')
    expect(screen.getByText('核对接口契约')).toBeInTheDocument()
    // worker 卡片展示 evidence 人话(自报完成);子 Agent 状态仍是已完成
    expect(screen.getAllByText('已完成')).toHaveLength(1)
    expect(screen.getByText(/已停止：自报完成：接口契约核对完毕/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /代码助手.*核对接口契约.*用时 2 分钟.*已完成/ })).toHaveAttribute(
      'href',
      `/traces/workers/${encodeURIComponent('w-1234567890ab')}/subagents/${encodeURIComponent('agent-child-1')}`,
    )
  })

  it('指令投递显示 receipt 中已有的受限正文预览', async () => {
    mocked.getWorkerDetail = vi.fn().mockResolvedValue({ worker: workerFixture() })
    mocked.getWorkerTrace = vi.fn().mockResolvedValue({
      events: [{
        ts: '2026-08-01T00:00:01.000Z',
        kind: 'lifecycle',
        summary: 'input_sent delivery_id=delivery-1',
        source: 'harness',
        detail: { delivery_id: 'delivery-1', text_preview: '继续核对隔离候选，生产环境保持不动。' },
      }],
      next_cursor: 'tok-1',
    })
    mocked.getWorkerTerminal = vi.fn().mockResolvedValue({ kind: 'live_terminal', text: '', captured_at: '2026-08-01T00:00:00.000Z' })
    renderDetail()

    const delivery = await screen.findByRole('button', { name: /指令投递：继续核对隔离候选，生产环境保持不动。.*展开详情/ })
    fireEvent.click(delivery)
    expect(screen.getAllByText('继续核对隔离候选，生产环境保持不动。')).toHaveLength(2)
  })

  it('默认选择主线，并把消息、工具与技术事件分开显示', async () => {
    const instruction = '请先在隔离环境验证坐标与朝向，再比较五个非对称地标。'.repeat(20)
    mocked.getWorkerDetail = vi.fn().mockResolvedValue({ worker: workerFixture() })
    mocked.getWorkerTrace = vi.fn().mockResolvedValue({
      events: [
        { ts: '2026-08-01T00:00:01.000Z', kind: 'lifecycle', role: 'system', summary: 'item_completed', source: 'native' },
        { ts: '2026-08-01T00:00:02.000Z', kind: 'message', role: 'user', summary: instruction.slice(0, 200), source: 'native', detail: { content: [{ type: 'input_text', text: instruction }] } },
        { ts: '2026-08-01T00:00:03.000Z', kind: 'tool_call', role: 'assistant', summary: 'shell()', source: 'native', detail: { call_id: 'call-1|fc-1', name: 'shell', arguments: '读取验证报告' } },
        { ts: '2026-08-01T00:00:04.000Z', kind: 'tool_result', summary: '完成', source: 'native', detail: { call_id: 'call-1', output: '已完成隔离环境读取' } },
        { ts: '2026-08-01T00:00:05.000Z', kind: 'message', role: 'assistant', summary: '正在重新验证方向', source: 'native', detail: { content: [{ type: 'output_text', text: '正在重新验证方向，正式端口尚未切换。' }] } },
      ],
      next_cursor: 'tok-1',
    })
    mocked.getWorkerTerminal = vi.fn().mockResolvedValue({ kind: 'live_terminal', text: '', captured_at: '2026-08-01T00:00:00.000Z' })

    renderDetail()

    await waitFor(() => expect(screen.getByText('管理会话指令')).toBeInTheDocument())
    expect(screen.getByText('Worker 文本')).toBeInTheDocument()
    const toolRow = screen.getByRole('button', { name: /工具调用：调用 shell · 已返回结果.*展开详情/ })
    expect(toolRow).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('item_completed')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '任务标题', level: 1 })).toBeInTheDocument()
    expect(screen.getByLabelText('任务概览')).toHaveTextContent('主线实现内置当前化身#1 主线')
    expect(screen.getByText('微信 · 测试账号 · 小付').closest('a')).toHaveAttribute('href', `/traces/managers/${encodeURIComponent('wechat::sess-1')}`)
    expect(mocked.getWorkerTrace).toHaveBeenCalledWith('w-1234567890ab', { seq: 1 })
    expect(mocked.getWorkerTerminal).toHaveBeenCalledWith('w-1234567890ab', { seq: 1 })

    fireEvent.click(toolRow)
    expect(screen.getByText('输入 · shell')).toBeInTheDocument()
    expect(screen.getByText('读取验证报告')).toBeInTheDocument()
    expect(screen.getByText('已完成隔离环境读取')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '技术事件 1' }))
    expect(screen.getByText('item_completed')).toBeInTheDocument()
  })

  it('builtin assistant text 与模型调用分开，纯工具轮不伪造 Worker 文本', async () => {
    mocked.getWorkerDetail = vi.fn().mockResolvedValue({ worker: workerFixture() })
    mocked.getWorkerTrace = vi.fn().mockResolvedValue({
      events: [
        { ts: '2026-08-01T00:00:01.000Z', kind: 'llm_call', summary: 'llm tool_use', source: 'native', detail: { stop_reason: 'tool_use' } },
        { ts: '2026-08-01T00:00:02.000Z', kind: 'tool_call', role: 'assistant', summary: 'shell', source: 'native', detail: { name: 'shell', arguments: 'pwd' } },
      ],
      next_cursor: 'tok-1',
    })
    mocked.getWorkerTerminal = vi.fn().mockResolvedValue({ kind: 'live_terminal', text: '', captured_at: '2026-08-01T00:00:00.000Z' })

    renderDetail()

    await screen.findByRole('button', { name: /工具调用：调用 shell · 执行中.*展开详情/ })
    expect(screen.queryByText('Worker 文本')).not.toBeInTheDocument()
    expect(screen.queryByText('任务输出')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '技术事件 1' }))
    expect(await screen.findByRole('button', { name: /原生记录 · 模型调用：llm tool_use/ })).toBeInTheDocument()
  })

  it('增量工具结果按 call_id 合并到原调用，并从执行中切换为已返回结果', async () => {
    mocked.getWorkerDetail = vi.fn().mockResolvedValue({ worker: workerFixture() })
    mocked.getWorkerTrace = vi.fn()
      .mockResolvedValueOnce({
        events: [{
          ts: '2026-08-01T00:00:02.000Z', kind: 'tool_call', role: 'assistant', summary: 'delegate_task', source: 'native',
          detail: { call_id: 'engine-call-1', tool_use_id: 'provider-call-1', name: 'delegate_task', input: '{"task":"核对数据"}' },
        }],
        next_cursor: 'cursor-after-call',
      })
      .mockResolvedValueOnce({
        events: [{
          ts: '2026-08-01T00:00:03.000Z', kind: 'tool_result', role: 'user', summary: '已启动', source: 'native',
          subagent_id: 'agent-child-1',
          detail: { call_id: 'engine-call-1', tool_use_id: 'provider-call-1', output: '{"agent_id":"agent-child-1","status":"launched"}' },
        }],
        next_cursor: 'cursor-after-result',
      })
    mocked.getWorkerTerminal = vi.fn().mockResolvedValue({ kind: 'live_terminal', text: '', captured_at: '2026-08-01T00:00:00.000Z' })

    renderDetail()

    expect(await screen.findByRole('button', { name: /工具调用：调用 delegate_task · 执行中.*展开详情/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '检查新活动' }))
    expect(await screen.findByRole('button', { name: /工具调用：调用 delegate_task · 已返回结果.*展开详情/ })).toBeInTheDocument()
    expect(screen.queryByText('工具结果')).not.toBeInTheDocument()
    expect(mocked.getWorkerTrace).toHaveBeenLastCalledWith('w-1234567890ab', { seq: 1, cursor: 'cursor-after-call' })
  })

  it('builtin assistant text 在默认活动流中显示为 Worker 文本', async () => {
    mocked.getWorkerDetail = vi.fn().mockResolvedValue({ worker: workerFixture() })
    mocked.getWorkerTrace = vi.fn().mockResolvedValue({
      events: [
        { ts: '2026-08-01T00:00:01.000Z', kind: 'llm_call', summary: 'llm end_turn', source: 'native', detail: { stop_reason: 'end_turn' } },
        { ts: '2026-08-01T00:00:01.000Z', kind: 'message', role: 'assistant', summary: '已完成核对', source: 'native', detail: { content: '已完成核对，等待下一步。' } },
      ],
      next_cursor: 'tok-1',
    })
    mocked.getWorkerTerminal = vi.fn().mockResolvedValue({ kind: 'live_terminal', text: '', captured_at: '2026-08-01T00:00:00.000Z' })

    renderDetail()

    expect(await screen.findByText('Worker 文本')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Worker 文本：已完成核对，等待下一步。/ })).toBeInTheDocument()
    expect(screen.queryByText('模型调用')).not.toBeInTheDocument()
  })

  it('活动记录分页且切换页面不会保留展开状态', async () => {
    const events = Array.from({ length: 21 }, (_, index) => ({
      ts: `2026-08-01T00:00:${String(index).padStart(2, '0')}.000Z`,
      kind: 'message' as const,
      role: 'assistant' as const,
      summary: `消息 ${index}`,
      source: 'native' as const,
      detail: { content: `消息 ${index}` },
    }))
    mocked.getWorkerDetail = vi.fn().mockResolvedValue({ worker: workerFixture() })
    mocked.getWorkerTrace = vi.fn().mockResolvedValue({ events, next_cursor: 'tok-1' })
    mocked.getWorkerTerminal = vi.fn().mockResolvedValue({ kind: 'live_terminal', text: '', captured_at: '2026-08-01T00:00:00.000Z' })

    renderDetail()

    await waitFor(() => expect(screen.getByText('第 1 / 2 页')).toBeInTheDocument())
    expect(screen.getByText('消息 0')).toBeInTheDocument()
    expect(screen.queryByText('消息 20')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(screen.getByText('第 2 / 2 页')).toBeInTheDocument()
    expect(screen.getByText('消息 20')).toBeInTheDocument()
    expect(screen.queryByText('消息 0')).not.toBeInTheDocument()
  })
})

describe('SubagentDetail', () => {
  beforeEach(() => { vi.resetAllMocks() })

  function renderSubagentDetail() {
    return render(
      <MemoryRouter initialEntries={[`/traces/workers/${encodeURIComponent('w-1234567890ab')}/subagents/agent-child-1`]}>
        <Routes>
          <Route path="/traces/workers/:workerId/subagents/:subagentId" element={<SubagentDetail />} />
        </Routes>
      </MemoryRouter>,
    )
  }

  it('显示 child 自身信息，分页查看 trace，并能返回所属 Worker', async () => {
    const events = [{
      ts: '2026-08-01T00:00:00.000Z', kind: 'message' as const,
      role: 'user' as const, summary: '核对原生 child trace', source: 'native' as const,
      detail: { content: '核对原生 child trace' },
    }, ...Array.from({ length: 21 }, (_, index) => ({
      ts: `2026-08-01T00:00:${String(index).padStart(2, '0')}.000Z`, kind: 'message' as const,
      role: 'assistant' as const, summary: `子 Agent 记录 ${index}`, source: 'harness' as const,
      detail: { content: `子 Agent 记录 ${index}` },
    }))]
    mocked.getWorkerSubagentDetail = vi.fn().mockResolvedValue({
      subagent: {
        subagent_id: 'agent-child-1', worker_id: 'w-1234567890ab', executor_impl: 'codex', type: 'research',
        name: '研究助手', task: '整理原生记录', status: 'completed',
        started_at: '2026-08-01T00:00:00.000Z', ended_at: '2026-08-01T00:02:00.000Z',
      },
    })
    mocked.getWorkerSubagentTrace = vi.fn().mockResolvedValue({ events, next_cursor: 'tok-1' })
    renderSubagentDetail()

    await screen.findByRole('heading', { name: '研究助手', level: 1 })
    expect(screen.getByText('Codex')).toBeInTheDocument()
    expect(screen.getByText('research')).toBeInTheDocument()
    expect(screen.getByText('整理原生记录')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '子 Agent Trace', level: 2 })).toBeInTheDocument()
    expect(screen.getByText('子 Agent 指令')).toBeInTheDocument()
    expect(screen.queryByText('管理会话指令')).not.toBeInTheDocument()
    expect(await screen.findAllByText('子 Agent 文本')).not.toHaveLength(0)
    expect(screen.getByText('第 1 / 2 页')).toBeInTheDocument()
    expect(screen.getByText('子 Agent 记录 0')).toBeInTheDocument()
    expect(screen.queryByText('子 Agent 记录 20')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(screen.getByText('第 2 / 2 页')).toBeInTheDocument()
    expect(screen.getByText('子 Agent 记录 20')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '← 返回 Worker 详情' })).toHaveAttribute(
      'href',
      `/traces/workers/${encodeURIComponent('w-1234567890ab')}`,
    )
  })
})
