import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import { ToastProvider } from '../../contexts/ToastContext'
import { agentObservabilityService } from '../../services/agent-observability'
import { ManagerWorkboard } from './ManagerWorkboard'

vi.mock('../../services/agent-observability')
vi.mock('../../components/Layout/MainLayout', () => ({
  MainLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

const mocked = agentObservabilityService as unknown as {
  listManagers: ReturnType<typeof vi.fn>
  getManagerWorkboard: ReturnType<typeof vi.fn>
  changeManagerWorkboard: ReturnType<typeof vi.fn>
}

const KEY = 'feishu::cotton-candy'
const UPDATED_AT = '2026-09-05T00:00:00.000Z'
const OBJECTIVE_A = {
  title: '让 Manager 准确回顾上下文',
  completion_criteria: ['连续追问时结论前后一致', '任务切换后仍能说清当前目标'],
  updated_at: UPDATED_AT,
  work_items: [
    {
      title: '核查上下文请求',
      status: 'in_progress' as const,
      project_root: '/workspace/crabot',
      current_judgement: '请求中混入了无关历史',
      next_action: '核对上下文装配边界',
      updated_at: UPDATED_AT,
    },
    {
      title: '验证多任务切换',
      status: 'blocked' as const,
      current_judgement: '仍缺少真实模型结果',
      next_action: '取得凭证后重跑',
      blocker: '等待可用的模型凭证',
      updated_at: UPDATED_AT,
    },
  ],
}
const OBJECTIVE_B = {
  title: '让人类能共管任务板',
  completion_criteria: ['页面能清楚区分目标和事项'],
  updated_at: UPDATED_AT,
  work_items: [],
}

const COUNTS = {
  current_objectives: 2,
  current_work_items: 2,
  blocked_work_items: 1,
  archive_entries: 0,
}

function board(overrides: Record<string, unknown> = {}) {
  return {
    manager_key: KEY,
    revision: 1,
    view: 'active' as const,
    objectives: [OBJECTIVE_A, OBJECTIVE_B],
    counts: COUNTS,
    pagination: { page: 1, page_size: 100, total_items: 2, total_pages: 1 },
    ...overrides,
  }
}

function renderPage() {
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={[`/traces/managers/${encodeURIComponent(KEY)}/workboard`]}>
        <Routes><Route path="/traces/managers/:managerKey/workboard" element={<ManagerWorkboard />} /></Routes>
      </MemoryRouter>
    </ToastProvider>,
  )
}

function objectiveSection(title: string): HTMLElement {
  return screen.getByRole('heading', { name: title }).closest('.manager-workboard__objective') as HTMLElement
}

describe('ManagerWorkboard', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocked.listManagers = vi.fn().mockResolvedValue({
      items: [{
        manager_key: KEY,
        display_name: '飞书 · 棉花糖',
        active_worker_count: 0,
        workboard: {
          status: 'ready',
          current_objective_count: 2,
          current_work_item_count: 2,
          blocked_work_item_count: 1,
        },
      }],
      pagination: { page: 1, page_size: 100, total_items: 1, total_pages: 1 },
    })
    mocked.getManagerWorkboard = vi.fn().mockResolvedValue(board())
  })

  it('按目标分区展示完成条件和紧凑事项卡，不在事项中重复目标内容', async () => {
    renderPage()

    await screen.findByRole('heading', { name: OBJECTIVE_A.title })
    const first = objectiveSection(OBJECTIVE_A.title)
    expect(within(first).getByRole('heading', { name: /待开始/ })).toBeInTheDocument()
    expect(within(first).getByRole('heading', { name: /进行中/ })).toBeInTheDocument()
    expect(within(first).getByRole('heading', { name: /已阻塞/ })).toBeInTheDocument()
    expect(screen.getAllByText(OBJECTIVE_A.completion_criteria[0])).toHaveLength(1)
    expect(screen.getAllByText('当前判断')).toHaveLength(2)
    expect(screen.getByText('主要阻塞')).toBeInTheDocument()
    expect(screen.getByText('crabot')).toHaveAttribute('title', '/workspace/crabot')
    expect(screen.queryByText('/workspace/crabot')).toBeNull()
  })

  it('项目名重名时显示末两级路径，并保留完整路径供悬停查看', async () => {
    mocked.getManagerWorkboard.mockResolvedValue(board({
      objectives: [
        OBJECTIVE_A,
        {
          ...OBJECTIVE_B,
          work_items: [{
            title: '核查另一个同名项目',
            status: 'ready',
            project_root: '/srv/crabot',
            next_action: '确认项目范围',
            updated_at: UPDATED_AT,
          }],
        },
      ],
      counts: { ...COUNTS, current_work_items: 3 },
    }))
    renderPage()

    expect(await screen.findByText('workspace/crabot')).toHaveAttribute('title', '/workspace/crabot')
    expect(screen.getByText('srv/crabot')).toHaveAttribute('title', '/srv/crabot')
    expect(screen.queryByText('/workspace/crabot')).toBeNull()
    expect(screen.queryByText('/srv/crabot')).toBeNull()
  })

  it('目标和事项表单提供面向管理摘要的简短示例', async () => {
    renderPage()

    await screen.findByRole('heading', { name: OBJECTIVE_A.title })
    fireEvent.click(screen.getByRole('button', { name: '新建目标' }))
    expect(screen.getByPlaceholderText('例如：让棉花糖会话能准确回顾已发生事件')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('例如：连续三轮追问时，事件回顾前后一致')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    fireEvent.click(within(objectiveSection(OBJECTIVE_A.title)).getByRole('button', { name: '新建事项' }))
    expect(screen.getByPlaceholderText('例如：核查消息进入模型前的上下文')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('例如：已确认历史输入存在缺口')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('例如：核对缺口是否影响用户可见结论')).toBeInTheDocument()
  })

  it('完整编辑事项时可清空项目根目录并原子移动到另一个目标', async () => {
    const revised = {
      ...OBJECTIVE_A.work_items[0],
      title: '核查上下文请求新版',
      project_root: undefined,
      current_judgement: '已确认只需保留管理结论',
      updated_at: '2026-09-05T01:00:00.000Z',
    }
    mocked.changeManagerWorkboard = vi.fn().mockResolvedValue({
      manager_key: KEY,
      revision: 2,
      action: 'work_item_revised',
      objective_title: OBJECTIVE_B.title,
      work_item: revised,
      counts: COUNTS,
      manager_notification: 'pending',
    })
    renderPage()

    const item = await screen.findByRole('heading', { name: '核查上下文请求' })
    fireEvent.click(within(item.closest('article') as HTMLElement).getByRole('button', { name: '编辑' }))
    expect((screen.getByLabelText('项目根目录（可选）') as HTMLInputElement).value).toBe('/workspace/crabot')
    fireEvent.change(screen.getByLabelText('项目根目录（可选）'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('所属目标'), { target: { value: OBJECTIVE_B.title } })
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: revised.title } })
    fireEvent.change(screen.getByLabelText('当前判断'), { target: { value: revised.current_judgement } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mocked.changeManagerWorkboard).toHaveBeenCalledWith(KEY, 1, {
      action: 'revise_work_item',
      current_objective_title: OBJECTIVE_A.title,
      current_work_item_title: '核查上下文请求',
      target_objective_title: OBJECTIVE_B.title,
      work_item: expect.objectContaining({ title: revised.title, current_judgement: revised.current_judgement }),
    }))
    const mutation = mocked.changeManagerWorkboard.mock.calls[0][2] as { work_item: Record<string, unknown> }
    expect(mutation.work_item).not.toHaveProperty('project_root')
    expect(within(objectiveSection(OBJECTIVE_B.title)).getByRole('heading', { name: revised.title })).toBeInTheDocument()
  })

  it('目标弹窗单独修改目标和完成条件，不携带事项正文', async () => {
    const revisedTitle = '让 Manager 稳定回顾上下文'
    mocked.changeManagerWorkboard = vi.fn().mockResolvedValue({
      manager_key: KEY,
      revision: 2,
      action: 'objective_revised',
      objective: {
        title: revisedTitle,
        completion_criteria: ['三轮追问结论一致'],
        updated_at: '2026-09-05T01:00:00.000Z',
      },
      counts: COUNTS,
      manager_notification: 'pending',
    })
    renderPage()

    await screen.findByRole('heading', { name: OBJECTIVE_A.title })
    fireEvent.click(within(objectiveSection(OBJECTIVE_A.title)).getByRole('button', { name: '编辑目标' }))
    fireEvent.change(screen.getByLabelText('目标'), { target: { value: revisedTitle } })
    fireEvent.change(screen.getByLabelText(/完成条件/), { target: { value: '三轮追问结论一致' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mocked.changeManagerWorkboard).toHaveBeenCalledWith(KEY, 1, {
      action: 'revise_objective',
      current_objective_title: OBJECTIVE_A.title,
      objective: { title: revisedTitle, completion_criteria: ['三轮追问结论一致'] },
    }))
    expect(await screen.findByRole('heading', { name: revisedTitle })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '核查上下文请求' })).toBeInTheDocument()
  })

  it('归档分别展示目标和事项的最终快照，不提供恢复入口', async () => {
    mocked.getManagerWorkboard.mockImplementation(async (_key: string, view: string) => view === 'archive'
      ? {
          manager_key: KEY,
          revision: 2,
          view: 'archive',
          entries: [
            {
              title: OBJECTIVE_B.title,
              completion_criteria: OBJECTIVE_B.completion_criteria,
              archived_as: 'completed',
              archived_at: '2026-09-05T02:00:00.000Z',
            },
            {
              ...OBJECTIVE_A.work_items[0],
              objective: { title: OBJECTIVE_A.title, completion_criteria: OBJECTIVE_A.completion_criteria },
              archived_as: 'abandoned',
              archived_at: '2026-09-05T03:00:00.000Z',
            },
          ],
          counts: { ...COUNTS, archive_entries: 2 },
          pagination: { page: 1, page_size: 100, total_items: 2, total_pages: 1 },
        }
      : board())
    renderPage()

    await screen.findByRole('heading', { name: OBJECTIVE_A.title })
    fireEvent.click(screen.getByRole('tab', { name: /归档/ }))
    expect(await screen.findByRole('heading', { name: /已归档目标/ })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /已归档事项/ })).toBeInTheDocument()
    expect(screen.getByText('原目标')).toBeInTheDocument()
    expect(screen.getByText(OBJECTIVE_A.title)).toBeInTheDocument()
    expect(screen.getByText('原目标完成条件')).toBeInTheDocument()
    expect(screen.getByText(OBJECTIVE_A.completion_criteria[0])).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '恢复' })).toBeNull()
  })

  it('409 后读取服务端新板但保留本地目标草稿', async () => {
    const conflict = Object.assign(new Error('任务板 revision 冲突'), { status: 409 })
    mocked.changeManagerWorkboard = vi.fn().mockRejectedValue(conflict)
    mocked.getManagerWorkboard
      .mockResolvedValueOnce(board())
      .mockResolvedValue(board({ revision: 2, objectives: [{ ...OBJECTIVE_A, title: '管理员已更新目标' }, OBJECTIVE_B] }))
    renderPage()

    await screen.findByRole('heading', { name: OBJECTIVE_A.title })
    fireEvent.click(within(objectiveSection(OBJECTIVE_A.title)).getByRole('button', { name: '编辑目标' }))
    fireEvent.change(screen.getByLabelText('目标'), { target: { value: '本地草稿目标' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await screen.findByText('任务板已更新，当前草稿未被覆盖。')
    expect((screen.getByLabelText('目标') as HTMLInputElement).value).toBe('本地草稿目标')
  })

  it('切换视图后忽略晚到的旧视图响应', async () => {
    let resolveActive!: (value: ReturnType<typeof board>) => void
    const activeRequest = new Promise<ReturnType<typeof board>>((resolve) => { resolveActive = resolve })
    const archived = {
      manager_key: KEY,
      revision: 2,
      view: 'archive' as const,
      entries: [{
        title: '已完成的上下文核查',
        completion_criteria: ['已给出请求级证据'],
        archived_as: 'completed' as const,
        archived_at: UPDATED_AT,
      }],
      counts: { ...COUNTS, archive_entries: 1 },
      pagination: { page: 1, page_size: 100, total_items: 1, total_pages: 1 },
    }
    mocked.getManagerWorkboard = vi.fn().mockImplementation((_key: string, view: string) => (
      view === 'active' ? activeRequest : Promise.resolve(archived)
    ))
    renderPage()

    fireEvent.click(screen.getByRole('tab', { name: '归档' }))
    await screen.findByRole('heading', { name: '已完成的上下文核查' })

    resolveActive(board())
    await waitFor(() => expect(screen.getByRole('heading', { name: '已完成的上下文核查' })).toBeInTheDocument())
    expect(screen.queryByText('归档中没有内容。')).toBeNull()
  })

  it('保存成功后忽略保存前发出的晚到轮询响应', async () => {
    let resolvePoll!: (value: ReturnType<typeof board>) => void
    const pendingPoll = new Promise<ReturnType<typeof board>>((resolve) => { resolvePoll = resolve })
    const revisedTitle = '本地保存后的目标'
    mocked.changeManagerWorkboard = vi.fn().mockResolvedValue({
      manager_key: KEY,
      revision: 2,
      action: 'objective_revised',
      objective: {
        title: revisedTitle,
        completion_criteria: OBJECTIVE_A.completion_criteria,
        updated_at: '2026-09-05T01:00:00.000Z',
      },
      counts: COUNTS,
      manager_notification: 'pending',
    })
    renderPage()

    await screen.findByRole('heading', { name: OBJECTIVE_A.title })
    fireEvent.click(within(objectiveSection(OBJECTIVE_A.title)).getByRole('button', { name: '编辑目标' }))
    fireEvent.change(screen.getByLabelText('目标'), { target: { value: revisedTitle } })
    mocked.getManagerWorkboard.mockImplementationOnce(() => pendingPoll)
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => expect(mocked.getManagerWorkboard).toHaveBeenCalledTimes(2))

    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByRole('heading', { name: revisedTitle })
    await act(async () => {
      resolvePoll(board())
      await pendingPoll
    })

    expect(screen.getByRole('heading', { name: revisedTitle })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: OBJECTIVE_A.title })).toBeNull()
  })

  it('保存成功后忽略保存期间发出的晚到轮询响应', async () => {
    let resolveSave!: (value: unknown) => void
    let resolvePoll!: (value: ReturnType<typeof board>) => void
    const pendingSave = new Promise((resolve) => { resolveSave = resolve })
    const pendingPoll = new Promise<ReturnType<typeof board>>((resolve) => { resolvePoll = resolve })
    const revisedTitle = '保存期间轮询后的目标'
    mocked.changeManagerWorkboard = vi.fn().mockReturnValue(pendingSave)
    renderPage()

    await screen.findByRole('heading', { name: OBJECTIVE_A.title })
    fireEvent.click(within(objectiveSection(OBJECTIVE_A.title)).getByRole('button', { name: '编辑目标' }))
    fireEvent.change(screen.getByLabelText('目标'), { target: { value: revisedTitle } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(mocked.changeManagerWorkboard).toHaveBeenCalledTimes(1))

    mocked.getManagerWorkboard.mockImplementationOnce(() => pendingPoll)
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => expect(mocked.getManagerWorkboard).toHaveBeenCalledTimes(2))

    await act(async () => {
      resolveSave({
        manager_key: KEY,
        revision: 2,
        action: 'objective_revised',
        objective: {
          title: revisedTitle,
          completion_criteria: OBJECTIVE_A.completion_criteria,
          updated_at: '2026-09-05T01:00:00.000Z',
        },
        counts: COUNTS,
        manager_notification: 'pending',
      })
      await pendingSave
    })
    await screen.findByRole('heading', { name: revisedTitle })

    await act(async () => {
      resolvePoll(board())
      await pendingPoll
    })

    expect(screen.getByRole('heading', { name: revisedTitle })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: OBJECTIVE_A.title })).toBeNull()
  })
})
