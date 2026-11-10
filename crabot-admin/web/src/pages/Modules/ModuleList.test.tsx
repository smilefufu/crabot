import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ModuleList } from './ModuleList'
import { legacyArchiveService } from '../../services/legacy-archive'
import { channelService } from '../../services/channel'

vi.mock('../../services/legacy-archive')
vi.mock('../../services/channel')
vi.mock('../../services/api', () => ({ api: { get: vi.fn().mockResolvedValue({ modules: [] }) } }))
vi.mock('../../components/Layout/MainLayout', () => ({
  MainLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

describe('ModuleList (P6-D)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(legacyArchiveService.list).mockResolvedValue([
      {
        archive_id: 'agent_config:front-agent',
        source_kind: 'agent_config',
        archived_at: '2026-08-14T00:00:00.000Z',
        support_status: 'unsupported_legacy',
        uninstallable: true,
        display_name: 'front-agent',
      },
    ])
    vi.mocked(channelService.listPlugins).mockResolvedValue({ items: [] })
    vi.mocked(channelService.listImplementations).mockResolvedValue({ items: [] } as never)
  })

  it('唯一 live agent 是静态 core；legacy 以 unsupported 摘要呈现且不含 raw', async () => {
    render(<MemoryRouter><ModuleList /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('CRABOT Core Agent')).toBeTruthy())
    expect(screen.getByText(/不受支持的 legacy.*front-agent/)).toBeTruthy()
    // 列表页不出现动态 create/install 控件
    expect(screen.queryByText(/安装 Agent/i)).toBeNull()
    expect(screen.queryByText(/创建实例/i)).toBeNull()
  })
  it('安装成功后才进入已安装分类，安装不会创建实例', async () => {
    let installed = false
    const plugin = { implementation_id: 'channel-feishu', name: '飞书', platform: 'feishu', package_name: 'crabot-channel-feishu', version: '0.1.1' }
    vi.mocked(channelService.listPlugins).mockImplementation(async () => ({ items: [{ ...plugin, installed }] }))
    vi.mocked(channelService.listImplementations).mockImplementation(async () => ({ items: installed ? [{ id: 'channel-feishu', name: '飞书', platform: 'feishu', version: '0.1.1', type: 'installed' }] : [] }) as any)
    vi.mocked(channelService.installPlugin).mockImplementation(async () => { installed = true; return {} as any })
    render(<MemoryRouter><ModuleList /></MemoryRouter>)
    const region = await screen.findByRole('region', { name: '可安装的 Channel' })
    expect(screen.getByRole('button', { name: 'Channel (0)' })).toBeTruthy()
    fireEvent.click(within(region).getByRole('button', { name: '安装' }))
    await screen.findByRole('button', { name: 'Channel (1)' })
    expect(within(screen.getByRole('region', { name: '可安装的 Channel' })).getByRole('button', { name: '已安装' })).toBeDisabled()
    expect(channelService.installPlugin).toHaveBeenCalledWith('channel-feishu')
    expect(channelService.createInstance).not.toHaveBeenCalled()
  })
  it('安装失败保留未安装状态并允许重试', async () => {
    vi.mocked(channelService.listPlugins).mockResolvedValue({ items: [{ implementation_id: 'channel-feishu', name: '飞书', platform: 'feishu', package_name: 'crabot-channel-feishu', version: '0.1.1', installed: false }] })
    vi.mocked(channelService.installPlugin).mockRejectedValue(new Error('国内源暂不可用，请重试'))
    render(<MemoryRouter><ModuleList /></MemoryRouter>)
    const region = await screen.findByRole('region', { name: '可安装的 Channel' })
    fireEvent.click(within(region).getByRole('button', { name: '安装' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('国内源暂不可用')
    expect(screen.getByRole('button', { name: 'Channel (0)' })).toBeTruthy()
    expect(within(region).getByRole('button', { name: '安装' })).not.toBeDisabled()
  })

})
