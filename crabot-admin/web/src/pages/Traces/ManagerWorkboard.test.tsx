import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
const ITEM = {
  title: '核查上下文',
  status: 'in_progress' as const,
  project_root: '/workspace/crabot',
  objective: '确认 Manager 的上下文状态',
  acceptance: ['能说明发生过的事情'],
  current_state: '等待核查',
  next_action: '读取调用记录',
  blockers: [],
  updated_at: '2026-09-05T00:00:00.000Z',
}

function board(overrides: Record<string, unknown> = {}) {
  return {
    manager_key: KEY,
    revision: 1,
    view: 'active' as const,
    items: [ITEM],
    active_count: 1,
    archive_count: 0,
    pagination: { page: 1, page_size: 100, total_items: 1, total_pages: 1 },
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

describe('ManagerWorkboard', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocked.listManagers = vi.fn().mockResolvedValue({
      items: [{ manager_key: KEY, display_name: '飞书 · 棉花糖', active_worker_count: 0, workboard: { status: 'ready', active_count: 1, blocked_count: 0 } }],
      pagination: { page: 1, page_size: 100, total_items: 1, total_pages: 1 },
    })
    mocked.getManagerWorkboard = vi.fn().mockResolvedValue(board())
  })

  it('按状态显示三列，完整编辑可清空项目根目录并在保存后立即更新', async () => {
    mocked.changeManagerWorkboard = vi.fn().mockResolvedValue({
      manager_key: KEY,
      revision: 2,
      item: { ...ITEM, title: '核查上下文新版', updated_at: '2026-09-05T01:00:00.000Z' },
      active_count: 1,
      archive_count: 0,
      manager_notification: 'pending',
    })
    renderPage()

    await screen.findByText('核查上下文')
    expect(screen.getByRole('heading', { name: /待开始/ })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /进行中/ })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /已阻塞/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    expect((screen.getByLabelText('项目根目录（可选）') as HTMLInputElement).value).toBe('/workspace/crabot')
    fireEvent.change(screen.getByLabelText('项目根目录（可选）'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '核查上下文新版' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mocked.changeManagerWorkboard).toHaveBeenCalledWith(KEY, 1, expect.objectContaining({
      action: 'revise', current_title: '核查上下文', item: expect.objectContaining({ title: '核查上下文新版' }),
    })))
    const mutation = mocked.changeManagerWorkboard.mock.calls[0][2] as { item: Record<string, unknown> }
    expect(mutation.item).not.toHaveProperty('project_root')
    expect(await screen.findByText('核查上下文新版')).toBeInTheDocument()
  })

  it('archive 切换只展示最终快照，不提供恢复入口', async () => {
    mocked.getManagerWorkboard.mockImplementation(async (_key: string, view: string) => view === 'archive'
      ? board({
          revision: 2,
          view: 'archive',
          items: [{ ...ITEM, archived_as: 'completed', archived_at: '2026-09-05T02:00:00.000Z' }],
          active_count: 0,
          archive_count: 1,
          pagination: { page: 1, page_size: 100, total_items: 1, total_pages: 1 },
        })
      : board())
    renderPage()

    await screen.findByText('核查上下文')
    fireEvent.click(screen.getByRole('tab', { name: /Archive/ }))
    expect(await screen.findByText('已完成')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '恢复' })).toBeNull()
  })

  it('409 后保留编辑草稿并提示远端已更新', async () => {
    const conflict = Object.assign(new Error('任务板 revision 冲突'), { status: 409 })
    mocked.changeManagerWorkboard = vi.fn().mockRejectedValue(conflict)
    mocked.getManagerWorkboard.mockResolvedValue(board({ revision: 2, items: [{ ...ITEM, current_state: '管理员已更新' }] }))
    renderPage()

    await screen.findByText('核查上下文')
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.change(screen.getByLabelText('目标'), { target: { value: '本地草稿目标' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await screen.findByText('任务板已更新，当前草稿未被覆盖。')
    expect((screen.getByLabelText('目标') as HTMLTextAreaElement).value).toBe('本地草稿目标')
  })
})
