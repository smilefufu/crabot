import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { ClientError } from 'crabot-client'
import { serverQueries, setServerScope } from '../services/server-state'
import { Workspaces } from './Workspaces'

const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), refresh: vi.fn(), update: vi.fn(), create: vi.fn(), totalUsage: vi.fn(), refreshTotalUsage: vi.fn(), maintenance: vi.fn(), previewRelocation: vi.fn(), bridge: { revealWorkspaceFolder: undefined as undefined | ReturnType<typeof vi.fn> } }))
vi.mock('crabot-client', async () => ({ ...await vi.importActual('crabot-client'), WorkspaceClient: class {
  list = mocks.list; get = mocks.get; refresh = mocks.refresh; update = mocks.update; create = mocks.create; totalUsage = mocks.totalUsage; refreshTotalUsage = mocks.refreshTotalUsage; maintenance = mocks.maintenance; previewRelocation = mocks.previewRelocation
} }))
vi.mock('../services/api', () => ({ getWebClient: () => ({}) }))
vi.mock('../services/desktop-host', () => ({ desktopBridge: mocks.bridge }))
vi.mock('../components/Layout/MainLayout', () => ({ MainLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
const id = '12345678-1234-4123-8123-123456789abc'
const workspace = { workspace_id: id, kind: 'project', name: 'Crabot', description: '桌面应用', root: '/projects/crabot', source: 'existing', created_at: '2026-10-19T00:00:00.000Z' }
const item = { workspace, directory_status: 'ready', usage: { status: 'complete', logical_bytes: 1234, file_count: 1, skipped_entries: 0 }, execution: { status: 'unknown' } }
const snapshot = { revision: 2, storage_root: '/workspaces', items: [item, { ...item, workspace: { ...workspace, workspace_id: 'default', kind: 'default', name: '默认工作区', root: '/workspaces/default', description: '' }, directory_status: 'missing', usage: { status: 'pending', file_count: 0, skipped_entries: 0 } }] }
beforeEach(() => { serverQueries.clear(); setServerScope('workspace-test'); vi.resetAllMocks(); mocks.bridge.revealWorkspaceFolder = undefined; mocks.maintenance.mockResolvedValue({ maintenance: false }); mocks.list.mockResolvedValue(structuredClone(snapshot)); mocks.totalUsage.mockResolvedValue({ status: 'pending', file_count: 0, skipped_entries: 0 }) })
afterEach(() => { serverQueries.clear() })
it('shows one row per project/default and does not invent zero space or idle execution for missing evidence', async () => {
  render(<MemoryRouter><Workspaces /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: /Crabot 桌面应用/ }))
  expect(screen.getByText(/1 个项目工作区 · 1 个默认工作区/)).toBeInTheDocument()
  expect(screen.getByText('待核实')).toBeInTheDocument()
  expect(screen.getAllByText('未知').length).toBeGreaterThan(0)
  expect(screen.queryByText('当前空闲')).toBeNull()
  expect(screen.queryByRole('button', { name: '在文件管理器打开' })).toBeNull()
  expect(screen.getByRole('link', { name: '查看关联执行器（含历史）' })).toHaveAttribute('href', `/traces?tab=workers&workspace_id=${id}`)
  fireEvent.change(screen.getByLabelText('搜索工作区'), { target: { value: '无此项目' } })
  expect(screen.getByText('没有匹配的工作区。')).toBeInTheDocument()
})
it('CAS conflict retains the draft, shows the latest metadata and requires a new explicit save', async () => {
  mocks.update.mockRejectedValueOnce(new ClientError('conflict', '版本冲突'))
  const latest = { ...workspace, name: '同事的新名称', description: '新用途' }
  mocks.get.mockResolvedValue({ revision: 3, item: { ...item, workspace: latest } })
  mocks.update.mockResolvedValueOnce({ revision: 4, workspace: { ...latest, name: '我的草稿' } })
  render(<MemoryRouter><Workspaces /></MemoryRouter>); fireEvent.click(await screen.findByRole('button', { name: /Crabot 桌面应用/ }))
  fireEvent.change(screen.getByLabelText('工作区名称'), { target: { value: '我的草稿' } })
  fireEvent.click(screen.getByRole('button', { name: '保存名称与用途' }))
  fireEvent.click(await screen.findByRole('button', { name: '读取最新信息，保留草稿' }))
  expect(await screen.findByText(/最新名称：同事的新名称/)).toBeInTheDocument()
  expect(screen.getByLabelText('工作区名称')).toHaveValue('我的草稿')
  expect(mocks.update).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: '保存名称与用途' }))
  await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2))
  expect(mocks.update.mock.calls[1][1]).toMatchObject({ expected_revision: 3, name: '我的草稿' })
})
it('a lost create response keeps a stable project identity for an explicit retry', async () => {
  mocks.create.mockRejectedValueOnce(new ClientError('unreachable', '连接中断')).mockResolvedValueOnce({ revision: 3, workspace })
  render(<MemoryRouter><Workspaces /></MemoryRouter>)
  const add = screen.getByRole('button', { name: '添加项目工作区' })
  expect(add).toBeDisabled()
  await waitFor(() => expect(add).toBeEnabled()); fireEvent.click(add)
  fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: '新项目' } })
  fireEvent.click(screen.getByRole('button', { name: '保存工作区' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('连接中断')
  fireEvent.click(screen.getByRole('button', { name: '保存工作区' }))
  await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2))
  expect(mocks.create.mock.calls[1][0].workspace_id).toBe(mocks.create.mock.calls[0][0].workspace_id)
})

it('desktop folder opening sends only the selected identity and presents a failed or stale lookup', async () => {
  mocks.bridge.revealWorkspaceFolder = vi.fn().mockResolvedValue(false)
  render(<MemoryRouter><Workspaces /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: /Crabot 桌面应用/ }))
  fireEvent.click(screen.getByRole('button', { name: '在文件管理器打开' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('目录暂时无法打开')
  expect(mocks.bridge.revealWorkspaceFolder).toHaveBeenCalledWith(id)
})

it('aggregate usage comes from the union endpoint; partial totals and missing allocation stay explicit', async () => {
  const usage = { status: 'partial', logical_bytes: 2000, file_count: 2, skipped_entries: 1 }
  mocks.refreshTotalUsage.mockResolvedValue({ ...usage, status: 'measuring' })
  render(<MemoryRouter><Workspaces /></MemoryRouter>)
  const total = await screen.findByRole('region', { name: '全部工作区空间' })
  await waitFor(() => expect(total).toHaveTextContent('尚未统计')); expect(total).toHaveTextContent('未知')
  mocks.totalUsage.mockResolvedValue(usage)
  fireEvent.click(screen.getByRole('button', { name: '刷新汇总空间' }))
  await waitFor(() => expect(total).toHaveTextContent('已统计下界'))
  expect(total).toHaveTextContent('2 KiB'); expect(total).toHaveTextContent('1 项未计入')
  expect(mocks.refreshTotalUsage).toHaveBeenCalledTimes(1)
})

it('maintenance keeps metadata drafts and read-only browsing while refusing scans, saves and folder opening', async () => {
  mocks.maintenance.mockResolvedValue({ maintenance: true })
  mocks.bridge.revealWorkspaceFolder = vi.fn()
  mocks.list.mockResolvedValue({ ...snapshot, items: [{ ...item, usage: { status: 'pending', file_count: 0, skipped_entries: 0 } }] })
  render(<MemoryRouter><Workspaces /></MemoryRouter>)
  expect(await screen.findByText(/工作目录正在维护或等待恢复/)).toBeInTheDocument()
  fireEvent.click(await screen.findByRole('button', { name: /Crabot 桌面应用/ }))
  fireEvent.change(screen.getByLabelText('工作区名称'), { target: { value: '保留我的草稿' } })
  expect(screen.getByRole('button', { name: '保存名称与用途' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '刷新空间统计' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '在文件管理器打开' })).toBeDisabled()
  fireEvent.submit(screen.getByRole('button', { name: '保存名称与用途' }).closest('form')!)
  expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.refresh).not.toHaveBeenCalled()
  mocks.maintenance.mockResolvedValue({ maintenance: false })
  fireEvent.click(screen.getByRole('button', { name: '刷新列表与执行状态' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '保存名称与用途' })).toBeEnabled())
  expect(screen.getByLabelText('工作区名称')).toHaveValue('保留我的草稿')
  expect(mocks.bridge.revealWorkspaceFolder).not.toHaveBeenCalled()
})

it('a relocated project can request statistics again at its new root without repeating the old root', async () => {
  const pending = { ...item, usage: { status: 'pending', file_count: 0, skipped_entries: 0 } }
  mocks.list.mockResolvedValue({ ...snapshot, items: [pending] })
  render(<MemoryRouter><Workspaces /></MemoryRouter>)
  await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1))
  mocks.list.mockResolvedValue({ ...snapshot, revision: 3, items: [{ ...pending, workspace: { ...workspace, root: '/moved/crabot' } }] })
  fireEvent.click(screen.getByRole('button', { name: '刷新列表与执行状态' }))
  await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(2))
  expect(mocks.refresh.mock.calls.map(args => args[0])).toEqual([id, id])
})

it('a failed maintenance refresh locks a previously available page and preserves its draft until verified again', async () => {
  render(<MemoryRouter><Workspaces /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: /Crabot 桌面应用/ }))
  const save = screen.getByRole('button', { name: '保存名称与用途' })
  await waitFor(() => expect(save).toBeEnabled())
  fireEvent.change(screen.getByLabelText('工作区名称'), { target: { value: '等待核验的草稿' } })
  mocks.maintenance.mockRejectedValue(new ClientError('unreachable', '连接中断'))
  fireEvent.click(screen.getByRole('button', { name: '刷新列表与执行状态' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('暂时无法核实工作区维护状态')
  expect(save).toBeDisabled()
  expect(screen.getByRole('button', { name: '刷新空间统计' })).toBeDisabled()
  fireEvent.submit(save.closest('form')!)
  expect(mocks.update).not.toHaveBeenCalled()
  expect(screen.getByLabelText('工作区名称')).toHaveValue('等待核验的草稿')
  fireEvent.change(screen.getByLabelText('搜索工作区'), { target: { value: '无此项目' } })
  expect(screen.getByText('没有匹配的工作区。')).toBeInTheDocument()
  mocks.maintenance.mockResolvedValue({ maintenance: false })
  fireEvent.click(screen.getByRole('button', { name: '重新核验维护状态' }))
  await waitFor(() => expect(save).toBeEnabled())
  expect(screen.getByLabelText('工作区名称')).toHaveValue('等待核验的草稿')
})


it('previews the actual storage scope and external projects without starting migration', async () => {
  mocks.previewRelocation.mockResolvedValue({ revision: 2, source: '/workspaces', target: '/moved', mode: 'rename', workspaces: [snapshot.items[1].workspace], retained_workspaces: [workspace],
    usage: { status: 'complete', logical_bytes: 1000, file_count: 1, skipped_entries: 0 }, available_bytes: '9007199254740993', issues: [], execution: { ready: false, items: {} } })
  render(<MemoryRouter><Workspaces /></MemoryRouter>)
  const check = await screen.findByRole('button', { name: '检查迁移位置' })
  await waitFor(() => expect(screen.getByRole('button', { name: '添加项目工作区' })).toBeEnabled())
  fireEvent.change(screen.getByLabelText('目标工作目录'), { target: { value: '/moved' } })
  fireEvent.click(check)
  expect(await screen.findByText('预检通过，尚未开始迁移。')).toBeInTheDocument()
  expect(screen.getByText(/1 个工作区随迁，1 个根外项目保留原位/)).toBeInTheDocument()
  expect(screen.getByText(/执行器数量待核实/)).toBeInTheDocument()
  expect(mocks.previewRelocation).toHaveBeenCalledWith({ target: '/moved' }, expect.objectContaining({ signal: expect.any(AbortSignal) }))
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('目标工作目录'), { target: { value: '/another' } })
  expect(screen.queryByText('预检通过，尚未开始迁移。')).toBeNull()
})

it('a late preview cannot replace the edited target or imply that a migration has started', async () => {
  let finish!: (value: unknown) => void
  mocks.previewRelocation.mockReturnValue(new Promise(resolve => { finish = resolve }))
  render(<MemoryRouter><Workspaces /></MemoryRouter>)
  await screen.findByLabelText('目标工作目录')
  await waitFor(() => expect(screen.getByRole('button', { name: '添加项目工作区' })).toBeEnabled())
  fireEvent.change(screen.getByLabelText('目标工作目录'), { target: { value: '/first' } })
  fireEvent.click(screen.getByRole('button', { name: '检查迁移位置' }))
  await waitFor(() => expect(mocks.previewRelocation).toHaveBeenCalledTimes(1))
  fireEvent.change(screen.getByLabelText('目标工作目录'), { target: { value: '/second' } })
  expect(mocks.previewRelocation.mock.calls[0][1].signal.aborted).toBe(true)
  finish({ revision: 2, source: '/workspaces', target: '/first', mode: 'unchanged', workspaces: [], retained_workspaces: [], issues: [], execution: { ready: false, items: {} } })
  await waitFor(() => expect(screen.getByRole('button', { name: '检查迁移位置' })).toBeEnabled())
  expect(screen.getByLabelText('目标工作目录')).toHaveValue('/second')
  expect(screen.queryByText('当前位置相同，无需迁移。')).toBeNull()
})


it('incompatible bindings and incomplete size remain visible as blockers rather than a passed preview', async () => {
  mocks.previewRelocation.mockResolvedValue({ revision: 2, source: '/workspaces', target: '/moved', mode: 'copy', workspaces: [], retained_workspaces: [],
    usage: { status: 'partial', logical_bytes: 1000, file_count: 1, skipped_entries: 1 }, available_bytes: '100', issues: [{ path: 'env/pyvenv.cfg', reason: 'python_environment' }], execution: { ready: false, items: {} } })
  render(<MemoryRouter><Workspaces /></MemoryRouter>)
  await screen.findByLabelText('目标工作目录')
  await waitFor(() => expect(screen.getByRole('button', { name: '添加项目工作区' })).toBeEnabled())
  fireEvent.change(screen.getByLabelText('目标工作目录'), { target: { value: '/moved' } })
  fireEvent.click(screen.getByRole('button', { name: '检查迁移位置' }))
  expect(await screen.findByText('预检发现阻塞项，请处理后重新检查。')).toBeInTheDocument()
  expect(screen.getByText(/Python 环境绑定原位置/)).toBeInTheDocument()
  expect(screen.getByRole('alert')).toHaveTextContent('目标空间不足')
  expect(screen.queryByText('预检通过，尚未开始迁移。')).toBeNull()
})


it('cancels a pending read-only preview while preserving the target for an explicit new check', async () => {
  mocks.previewRelocation.mockReturnValue(new Promise(() => {}))
  render(<MemoryRouter><Workspaces /></MemoryRouter>)
  await screen.findByLabelText('目标工作目录')
  await waitFor(() => expect(screen.getByRole('button', { name: '添加项目工作区' })).toBeEnabled())
  fireEvent.change(screen.getByLabelText('目标工作目录'), { target: { value: '/moved' } })
  fireEvent.click(screen.getByRole('button', { name: '检查迁移位置' }))
  fireEvent.click(await screen.findByRole('button', { name: '取消检查' }))
  expect(mocks.previewRelocation.mock.calls[0][1].signal.aborted).toBe(true)
  expect(screen.getByLabelText('目标工作目录')).toHaveValue('/moved')
  expect(screen.getByRole('button', { name: '检查迁移位置' })).toBeEnabled()
  expect(mocks.previewRelocation).toHaveBeenCalledTimes(1)
})
