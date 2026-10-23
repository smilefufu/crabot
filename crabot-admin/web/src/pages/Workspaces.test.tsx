import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { ClientError } from 'crabot-client'
import { serverQueries, setServerScope } from '../services/server-state'
import { Workspaces } from './Workspaces'

const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), refresh: vi.fn(), update: vi.fn(), create: vi.fn(), totalUsage: vi.fn(), refreshTotalUsage: vi.fn(), maintenance: vi.fn(), previewRelocation: vi.fn(), startRelocation: vi.fn(), currentRelocation: vi.fn(), relocationStatus: vi.fn(), previewRelocationRecovery: vi.fn(), startRelocationRecovery: vi.fn(), bridge: { revealWorkspaceFolder: undefined as undefined | ReturnType<typeof vi.fn>, selectWorkspaceDirectory: undefined as undefined | ReturnType<typeof vi.fn> } }))
vi.mock('crabot-client', async () => ({ ...await vi.importActual('crabot-client'), WorkspaceClient: class {
  list = mocks.list; get = mocks.get; refresh = mocks.refresh; update = mocks.update; create = mocks.create; totalUsage = mocks.totalUsage; refreshTotalUsage = mocks.refreshTotalUsage; maintenance = mocks.maintenance; previewRelocation = mocks.previewRelocation; startRelocation = mocks.startRelocation; currentRelocation = mocks.currentRelocation; relocationStatus = mocks.relocationStatus; previewRelocationRecovery = mocks.previewRelocationRecovery; startRelocationRecovery = mocks.startRelocationRecovery
} }))
vi.mock('../services/api', () => ({ getWebClient: () => ({}) }))
vi.mock('../services/desktop-host', () => ({ desktopBridge: mocks.bridge }))
vi.mock('../components/Layout/MainLayout', () => ({ MainLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
const id = '12345678-1234-4123-8123-123456789abc'
const workspace = { workspace_id: id, kind: 'project', name: 'Crabot', description: '桌面应用', root: '/projects/crabot', source: 'existing', created_at: '2026-10-19T00:00:00.000Z' }
const item = { workspace, directory_status: 'ready', usage: { status: 'complete', logical_bytes: 1234, file_count: 1, skipped_entries: 0 }, execution: { status: 'unknown' } }
const snapshot = { revision: 2, storage_root: '/workspaces', items: [item, { ...item, workspace: { ...workspace, workspace_id: 'default', kind: 'default', name: '默认工作区', root: '/workspaces/default', description: '' }, directory_status: 'missing', usage: { status: 'pending', file_count: 0, skipped_entries: 0 } }] }
beforeEach(() => { serverQueries.clear(); setServerScope('workspace-test'); vi.resetAllMocks(); mocks.bridge.revealWorkspaceFolder = undefined; mocks.bridge.selectWorkspaceDirectory = undefined; mocks.maintenance.mockResolvedValue({ maintenance: false }); mocks.currentRelocation.mockResolvedValue({ available: true, job: null }); mocks.relocationStatus.mockResolvedValue({ available: true, job: null }); mocks.list.mockResolvedValue(structuredClone(snapshot)); mocks.totalUsage.mockResolvedValue({ status: 'pending', file_count: 0, skipped_entries: 0 }) })
afterEach(() => { serverQueries.clear() })
it('shows one row per project/default and does not invent zero space or idle execution for missing evidence', async () => {
  render(<MemoryRouter><Workspaces /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: /Crabot 桌面应用/ }))
  expect(screen.getByText(/1 个项目工作区 · 1 个默认工作区/)).toBeInTheDocument()
  expect(screen.getByText('待核实')).toBeInTheDocument()
  expect(screen.getAllByText('未知').length).toBeGreaterThan(0)
  expect(screen.queryByText('当前空闲')).toBeNull()
  expect(screen.queryByRole('button', { name: '在文件管理器打开' })).toBeNull()
  expect(screen.queryByRole('button', { name: '选择本机文件夹' })).toBeNull()
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

it('keeps actual migration progress readable during maintenance without submitting another operation', async () => {
  mocks.maintenance.mockResolvedValue({ maintenance: true })
  mocks.currentRelocation.mockResolvedValue({ available: true, job: { intent_id: id, state: 'running', stage: 'stopping', source: '/old workspaces', target: '/new workspaces' } })
  render(<MemoryRouter><Workspaces /></MemoryRouter>)
  expect(await screen.findByText('正在停止并核验执行')).toBeInTheDocument()
  expect(screen.getByText('/new workspaces')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '刷新迁移进度' })).toBeEnabled()
  expect(screen.getByRole('button', { name: '添加项目工作区' })).toBeDisabled()
  expect(mocks.previewRelocation).not.toHaveBeenCalled()
})
it('does not label a historical commit completed and retains the last paths when progress becomes unknown', async () => {
  mocks.currentRelocation.mockResolvedValue({ available: true, job: { intent_id: id, state: 'committed', stage: 'finished', source: '/old workspaces', target: '/new workspaces' } })
  render(<MemoryRouter><Workspaces /></MemoryRouter>)
  expect(await screen.findByText('目录切换已提交')).toBeInTheDocument()
  expect(screen.queryByText('迁移已完成')).toBeNull()
  mocks.currentRelocation.mockRejectedValue(new ClientError('unreachable', 'offline'))
  fireEvent.click(screen.getByRole('button', { name: '刷新迁移进度' }))
  expect(await screen.findByText(/暂时无法核实迁移进度/)).toBeInTheDocument()
  expect(screen.getByText('/new workspaces')).toBeInTheDocument()
  expect(screen.queryByText('迁移已完成')).toBeNull()
})
it('unknown stored progress is never displayed as no work and no migration is automatically retried', async () => {
  mocks.currentRelocation.mockResolvedValue({ available: false, job: null })
  render(<MemoryRouter><Workspaces /></MemoryRouter>)
  expect(await screen.findByText(/暂时无法核实迁移进度/)).toBeInTheDocument()
  expect(screen.queryByText('迁移已完成')).toBeNull()
  expect(mocks.previewRelocation).not.toHaveBeenCalled()
})

it('reopening the current view queries the same known job when the current pointer is absent, without another migration', async () => {
  const job = { intent_id: id, state: 'running', stage: 'stopping', source: '/old workspaces', target: '/new workspaces' }
  mocks.currentRelocation.mockResolvedValue({ available: true, job })
  render(<MemoryRouter><Workspaces /></MemoryRouter>)
  await screen.findByText('正在停止并核验执行')
  mocks.currentRelocation.mockResolvedValue({ available: true, job: null })
  mocks.relocationStatus.mockResolvedValue({ available: true, job: { ...job, state: 'committed', stage: 'finished' } })
  fireEvent.click(screen.getByRole('button', { name: '刷新迁移进度' }))
  expect(await screen.findByText('目录切换已提交')).toBeInTheDocument()
  expect(mocks.relocationStatus).toHaveBeenCalledWith(id, expect.objectContaining({ signal: expect.any(AbortSignal) }))
  expect(mocks.previewRelocation).not.toHaveBeenCalled()
})
it('a fresh unavailable observation keeps the known paths without claiming that an old completion is current', async () => {
  mocks.currentRelocation.mockResolvedValue({ available: true, job: { intent_id: id, state: 'completed', stage: 'finished', target: '/new workspaces' } })
  render(<MemoryRouter><Workspaces /></MemoryRouter>)
  await screen.findByText('迁移已完成')
  mocks.currentRelocation.mockResolvedValue({ available: false, job: null })
  fireEvent.click(screen.getByRole('button', { name: '刷新迁移进度' }))
  expect(await screen.findByText(/暂时无法核实迁移进度/)).toBeInTheDocument()
  expect(screen.getByText('/new workspaces')).toBeInTheDocument()
  expect(screen.queryByText('迁移已完成')).toBeNull()
  expect(mocks.relocationStatus).not.toHaveBeenCalled()
})

async function readyToRelocate() {
  mocks.previewRelocation.mockResolvedValue({ revision: 2, source: '/workspaces', target: '/canonical-moved', mode: 'rename', workspaces: [snapshot.items[1].workspace], retained_workspaces: [workspace],
    usage: { status: 'complete', logical_bytes: 1000, file_count: 1, skipped_entries: 0 }, available_bytes: '10000', issues: [], execution: { ready: true, items: { default: { worker_count: 1, status: 'idle' } } } })
  await screen.findByLabelText('目标工作目录')
  fireEvent.change(screen.getByLabelText('目标工作目录'), { target: { value: '/user-alias' } })
  await waitFor(() => expect(screen.getByRole('button', { name: '检查迁移位置' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: '检查迁移位置' }))
  return screen.findByRole('button', { name: '停止执行并迁移' })
}
it('requires an explicit complete preview and dispatches a double click once with its canonical target and revision', async () => {
  mocks.startRelocation.mockReturnValue(new Promise(() => {}))
  render(<MemoryRouter><Workspaces /></MemoryRouter>)
  const start = await readyToRelocate()
  expect(screen.getByText(/现有执行器将永久关闭/)).toBeInTheDocument()
  expect(mocks.startRelocation).not.toHaveBeenCalled()
  fireEvent.click(start); fireEvent.click(start)
  expect(mocks.startRelocation).toHaveBeenCalledTimes(1)
  expect(mocks.startRelocation.mock.calls[0][0]).toEqual({ intent_id: expect.stringMatching(/^[a-f0-9-]{36}$/), target: '/canonical-moved', expected_revision: 2, confirmed: true })
  expect(mocks.startRelocation.mock.calls[0]).toHaveLength(1)
})
function CurrentPage() { const location = useLocation(); return <output aria-label="当前页面">{location.pathname + location.search}</output> }
it('keeps an uncertain submission identity in navigation and reopening only observes that same job', async () => {
  mocks.startRelocation.mockRejectedValue(new ClientError('unreachable', '连接中断'))
  const view = render(<MemoryRouter><Workspaces /><CurrentPage /></MemoryRouter>)
  fireEvent.click(await readyToRelocate())
  expect(await screen.findByText(/提交结果待核实/)).toBeInTheDocument()
  const jobId = mocks.startRelocation.mock.calls[0][0].intent_id
  expect(screen.queryByRole('button', { name: '停止执行并迁移' })).toBeNull()
  const navigation = screen.getByLabelText('当前页面').textContent!
  expect(new URL(navigation, 'http://fixture').searchParams.get('relocation_id')).toBe(jobId)
  view.unmount(); serverQueries.clear()
  render(<MemoryRouter initialEntries={[navigation]}><Workspaces /></MemoryRouter>)
  await waitFor(() => expect(mocks.relocationStatus).toHaveBeenCalledWith(jobId, expect.objectContaining({ signal: expect.any(AbortSignal) })))
  expect(screen.getByText(/提交结果待核实/)).toBeInTheDocument()
  expect(mocks.startRelocation).toHaveBeenCalledTimes(1)
})
it('a committed job never exposes another migration confirmation', async () => {
  mocks.currentRelocation.mockResolvedValue({ available: true, job: { intent_id: id, state: 'committed', stage: 'finished' } })
  render(<MemoryRouter><Workspaces /></MemoryRouter>)
  await screen.findByText('目录切换已提交')
  fireEvent.change(screen.getByLabelText('目标工作目录'), { target: { value: '/moved' } })
  await waitFor(() => expect(screen.getByRole('button', { name: '检查迁移位置' })).toBeEnabled())
  mocks.previewRelocation.mockResolvedValue({ revision: 2, source: '/workspaces', target: '/moved', mode: 'rename', workspaces: [], retained_workspaces: [], issues: [], usage: { status: 'complete', logical_bytes: 0, file_count: 0, skipped_entries: 0 }, execution: { ready: true, items: {} } })
  fireEvent.click(screen.getByRole('button', { name: '检查迁移位置' }))
  await screen.findByText('预检通过，尚未开始迁移。')
  expect(screen.queryByRole('button', { name: '停止执行并迁移' })).toBeNull()
  expect(mocks.startRelocation).not.toHaveBeenCalled()
})

it('never submits from a malformed navigation identity and keeps progress unknown', async () => {
  render(<MemoryRouter initialEntries={['/workspaces?relocation_id=not-a-job']}><Workspaces /></MemoryRouter>)
  await screen.findByText(/暂时无法核实迁移进度/)
  expect(mocks.startRelocation).not.toHaveBeenCalled(); expect(mocks.relocationStatus).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: '停止执行并迁移' })).toBeNull()
})
it('catalog revision changes invalidate a confirmed preview before any start dispatch', async () => {
  render(<MemoryRouter><Workspaces /></MemoryRouter>)
  await readyToRelocate()
  mocks.list.mockResolvedValue({ ...snapshot, revision: 3 })
  fireEvent.click(screen.getByRole('button', { name: '刷新列表与执行状态' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: '停止执行并迁移' })).toBeNull())
  expect(screen.getByLabelText('目标工作目录')).toHaveValue('/user-alias')
  expect(mocks.startRelocation).not.toHaveBeenCalled()
})
it('an unknown execution scope or a partial preview cannot offer migration confirmation', async () => {
  render(<MemoryRouter><Workspaces /></MemoryRouter>)
  await readyToRelocate()
  fireEvent.change(screen.getByLabelText('目标工作目录'), { target: { value: '/unknown-execution' } })
  const complete = mocks.previewRelocation.mock.results[0].value
  mocks.previewRelocation.mockResolvedValue({ ...await complete, execution: { ready: false, items: {} } })
  fireEvent.click(screen.getByRole('button', { name: '检查迁移位置' }))
  await screen.findByText(/执行器数量待核实/)
  expect(screen.queryByRole('button', { name: '停止执行并迁移' })).toBeNull()
  fireEvent.change(screen.getByLabelText('目标工作目录'), { target: { value: '/partial' } })
  mocks.previewRelocation.mockResolvedValue({ ...await complete, usage: { status: 'partial' } })
  fireEvent.click(screen.getByRole('button', { name: '检查迁移位置' }))
  await screen.findByText('预检发现阻塞项，请处理后重新检查。')
  expect(screen.queryByRole('button', { name: '停止执行并迁移' })).toBeNull()
})
it('an unchanged receipt clears only this navigation hint and allows a fresh explicit preview', async () => {
  mocks.startRelocation.mockResolvedValue({ source: '/canonical-moved', unchanged: true })
  render(<MemoryRouter><Workspaces /></MemoryRouter>)
  fireEvent.click(await readyToRelocate())
  await screen.findByText('当前位置相同，无需迁移。')
  expect(screen.queryByRole('button', { name: '停止执行并迁移' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '检查迁移位置' }))
  expect(await screen.findByRole('button', { name: '停止执行并迁移' })).toBeEnabled()
  expect(mocks.startRelocation).toHaveBeenCalledTimes(1)
})

it('a new accepted identity is not replaced by the previous completed job during handoff', async () => {
  mocks.currentRelocation.mockResolvedValue({ available: true, job: { intent_id: id, state: 'completed', stage: 'finished' } })
  let accept!: (value: unknown) => void
  mocks.startRelocation.mockReturnValue(new Promise(resolve => { accept = resolve }))
  render(<MemoryRouter><Workspaces /><CurrentPage /></MemoryRouter>)
  fireEvent.click(await readyToRelocate())
  const request = mocks.startRelocation.mock.calls[0][0]
  expect(request.intent_id).not.toBe(id)
  await waitFor(() => expect(mocks.relocationStatus).toHaveBeenCalledWith(request.intent_id, expect.anything()))
  mocks.relocationStatus.mockResolvedValue({ available: true, job: { intent_id: request.intent_id, state: 'running', stage: 'stopping', target: request.target } })
  accept({ intent_id: request.intent_id, accepted: true })
  await screen.findByText('正在停止并核验执行')
  expect(new URL(screen.getByLabelText('当前页面').textContent!, 'http://fixture').searchParams.get('relocation_id')).toBe(request.intent_id)
  expect(screen.queryByText('迁移已完成')).toBeNull()
  expect(mocks.startRelocation).toHaveBeenCalledTimes(1)
})

it('the native directory chooser only fills the preview draft and cancel preserves it', async () => {
  mocks.bridge.selectWorkspaceDirectory = vi.fn().mockResolvedValue('/native chosen')
  render(<MemoryRouter><Workspaces /></MemoryRouter>)
  const choose = await screen.findByRole('button', { name: '选择本机文件夹' })
  await waitFor(() => expect(choose).toBeEnabled()); fireEvent.click(choose)
  await waitFor(() => expect(screen.getByLabelText('目标工作目录')).toHaveValue('/native chosen'))
  expect(mocks.previewRelocation).not.toHaveBeenCalled(); expect(mocks.startRelocation).not.toHaveBeenCalled()
  mocks.bridge.selectWorkspaceDirectory.mockResolvedValue(null)
  fireEvent.click(choose)
  await waitFor(() => expect(choose).toBeEnabled())
  expect(screen.getByLabelText('目标工作目录')).toHaveValue('/native chosen')
  expect(mocks.startRelocation).not.toHaveBeenCalled()
})
it('a late native selection cannot overwrite an edited draft or a different catalog generation', async () => {
  let finish!: (value: string) => void
  mocks.bridge.selectWorkspaceDirectory = vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve }))
  render(<MemoryRouter><Workspaces /></MemoryRouter>)
  const choose = await screen.findByRole('button', { name: '选择本机文件夹' })
  await waitFor(() => expect(choose).toBeEnabled()); fireEvent.click(choose)
  fireEvent.change(screen.getByLabelText('目标工作目录'), { target: { value: '/typed-later' } })
  finish('/old-native-choice')
  await waitFor(() => expect(choose).toBeEnabled())
  expect(screen.getByLabelText('目标工作目录')).toHaveValue('/typed-later')
  fireEvent.click(choose)
  mocks.list.mockResolvedValue({ ...snapshot, revision: 3 })
  fireEvent.click(screen.getByRole('button', { name: '刷新列表与执行状态' }))
  await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(choose).toBeEnabled())
  finish('/old-catalog-choice')
  await waitFor(() => expect(screen.getByLabelText('目标工作目录')).toHaveValue('/typed-later'))
  expect(mocks.previewRelocation).not.toHaveBeenCalled(); expect(mocks.startRelocation).not.toHaveBeenCalled()
})


const recoveryOffer = { intent_id: id, completion_sha256: 'a'.repeat(64), finalizing_sha256: 'b'.repeat(64) }
function pendingRecovery() {
  const result = { available: true, job: { intent_id: id, state: 'needs_attention', stage: 'finalizing' } }
  mocks.currentRelocation.mockResolvedValue(result); mocks.relocationStatus.mockResolvedValue(result)
  mocks.previewRelocationRecovery.mockResolvedValue({ available: true, recovery: recoveryOffer })
  render(<MemoryRouter><Workspaces /></MemoryRouter>)
  return screen.findByRole('button', { name: '核验恢复条件' })
}
it('recovery requires separate verification and explicit confirmation, submits once and retains original intent', async () => {
  let resolve!: (value: unknown) => void
  mocks.startRelocationRecovery.mockImplementation(() => new Promise(done => { resolve = done }))
  const verify = await pendingRecovery()
  expect(mocks.previewRelocationRecovery).not.toHaveBeenCalled(); expect(mocks.startRelocationRecovery).not.toHaveBeenCalled()
  fireEvent.click(verify)
  const start = await screen.findByRole('button', { name: '继续恢复服务' })
  expect(mocks.previewRelocationRecovery).toHaveBeenCalledWith(id, expect.objectContaining({ signal: expect.any(AbortSignal) }))
  fireEvent.click(start); fireEvent.click(start)
  await waitFor(() => expect(mocks.startRelocationRecovery).toHaveBeenCalledTimes(1))
  const request = mocks.startRelocationRecovery.mock.calls[0][0]
  expect(request).toEqual({ ...recoveryOffer, recovery_id: expect.stringMatching(/^[a-f0-9-]{36}$/), confirmed: true })
  expect(screen.getByText(/旧执行器永久保持关闭/)).toBeInTheDocument()
  resolve({ intent_id: id, recovery_id: request.recovery_id, accepted: true })
  expect(await screen.findByText(/恢复已接纳，正在后台继续/)).toBeInTheDocument()
  expect(screen.queryByText('迁移已完成')).toBeNull()
  expect(mocks.startRelocationRecovery).toHaveBeenCalledTimes(1)
  expect(mocks.relocationStatus).toHaveBeenCalledWith(id, expect.anything())
})
it('unknown recovery admission retains both identities without automatically retrying', async () => {
  mocks.startRelocationRecovery.mockRejectedValue(new ClientError('timeout', 'timeout'))
  fireEvent.click(await pendingRecovery()); fireEvent.click(await screen.findByRole('button', { name: '继续恢复服务' }))
  expect(await screen.findByText(/恢复接纳结果待核实/)).toBeInTheDocument()
  const request = mocks.startRelocationRecovery.mock.calls[0][0]
  expect(screen.getByText('恢复编号：' + request.recovery_id)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '核验恢复条件' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '刷新迁移进度' }))
  await waitFor(() => expect(mocks.relocationStatus).toHaveBeenCalled())
  expect(mocks.startRelocationRecovery).toHaveBeenCalledTimes(1)
})
it('a late recovery preview cannot enable recovery after current status has changed', async () => {
  let resolve!: (value: unknown) => void
  const verify = await pendingRecovery()
  mocks.previewRelocationRecovery.mockImplementation(() => new Promise(done => { resolve = done }))
  fireEvent.click(verify)
  const previous = mocks.currentRelocation.mock.calls.length
  mocks.currentRelocation.mockResolvedValue({ available: true, job: { intent_id: id, state: 'running', stage: 'restoring' } })
  fireEvent.click(screen.getByRole('button', { name: '刷新迁移进度' }))
  await waitFor(() => expect(mocks.currentRelocation.mock.calls.length).toBeGreaterThan(previous))
  await screen.findByText('正在恢复业务')
  resolve({ available: true, recovery: recoveryOffer })
  await waitFor(() => expect(screen.queryByRole('button', { name: '继续恢复服务' })).toBeNull())
  expect(mocks.startRelocationRecovery).not.toHaveBeenCalled()
})
it('unverifiable recovery conditions leave the original diagnostic and never show an action', async () => {
  const verify = await pendingRecovery()
  mocks.previewRelocationRecovery.mockResolvedValue({ available: false, recovery: null })
  fireEvent.click(verify)
  expect(await screen.findByText(/恢复条件暂时无法核实/)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '继续恢复服务' })).toBeNull()
  expect(mocks.startRelocationRecovery).not.toHaveBeenCalled()
})

it.each(['job', 'server'])('a late recovery offer cannot cross a changed %s', async mode => {
  const verify = await pendingRecovery()
  let resolve!: (value: unknown) => void
  mocks.previewRelocationRecovery.mockImplementation(() => new Promise(done => { resolve = done }))
  fireEvent.click(verify)
  const signal = mocks.previewRelocationRecovery.mock.calls[0][1].signal
  const next = '87654321-4321-4321-8321-cba987654321'
  mocks.currentRelocation.mockResolvedValue({ available: true, job: { intent_id: next, state: 'needs_attention', stage: 'finalizing' } })
  if (mode === 'job') fireEvent.click(screen.getByRole('button', { name: '刷新迁移进度' }))
  else act(() => setServerScope('different-recovery-server'))
  await screen.findByText('作业编号：' + next)
  expect(signal.aborted).toBe(true)
  await act(async () => resolve({ available: true, recovery: recoveryOffer }))
  expect(screen.queryByRole('button', { name: '继续恢复服务' })).toBeNull()
  expect(mocks.startRelocationRecovery).not.toHaveBeenCalled()
})
