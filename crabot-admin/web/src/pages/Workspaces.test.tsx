import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { ClientError } from 'crabot-client'
import { serverQueries, setServerScope } from '../services/server-state'
import { Workspaces } from './Workspaces'

const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), refresh: vi.fn(), update: vi.fn(), create: vi.fn(), totalUsage: vi.fn(), refreshTotalUsage: vi.fn(), bridge: { revealWorkspaceFolder: undefined as undefined | ReturnType<typeof vi.fn> } }))
vi.mock('crabot-client', async () => ({ ...await vi.importActual('crabot-client'), WorkspaceClient: class {
  list = mocks.list; get = mocks.get; refresh = mocks.refresh; update = mocks.update; create = mocks.create; totalUsage = mocks.totalUsage; refreshTotalUsage = mocks.refreshTotalUsage
} }))
vi.mock('../services/api', () => ({ getWebClient: () => ({}) }))
vi.mock('../services/desktop-host', () => ({ desktopBridge: mocks.bridge }))
vi.mock('../components/Layout/MainLayout', () => ({ MainLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
const id = '12345678-1234-4123-8123-123456789abc'
const workspace = { workspace_id: id, kind: 'project', name: 'Crabot', description: '桌面应用', root: '/projects/crabot', source: 'existing', created_at: '2026-10-19T00:00:00.000Z' }
const item = { workspace, directory_status: 'ready', usage: { status: 'complete', logical_bytes: 1234, file_count: 1, skipped_entries: 0 }, execution: { status: 'unknown' } }
const snapshot = { revision: 2, storage_root: '/workspaces', items: [item, { ...item, workspace: { ...workspace, workspace_id: 'default', kind: 'default', name: '默认工作区', root: '/workspaces/default', description: '' }, directory_status: 'missing', usage: { status: 'pending', file_count: 0, skipped_entries: 0 } }] }
beforeEach(() => { serverQueries.clear(); setServerScope('workspace-test'); vi.resetAllMocks(); mocks.bridge.revealWorkspaceFolder = undefined; mocks.list.mockResolvedValue(structuredClone(snapshot)); mocks.totalUsage.mockResolvedValue({ status: 'pending', file_count: 0, skipped_entries: 0 }) })
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
  render(<MemoryRouter><Workspaces /></MemoryRouter>); fireEvent.click(await screen.findByRole('button', { name: '添加项目工作区' }))
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
