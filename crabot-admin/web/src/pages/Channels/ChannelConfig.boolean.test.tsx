import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { ChannelConfig } from './ChannelConfig'
import { channelService } from '../../services/channel'

vi.mock('../../components/Layout/MainLayout', () => ({ MainLayout: ({ children }: any) => <div>{children}</div> }))
vi.mock('../../contexts/ToastContext', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }))
vi.mock('./VoiceConfigCard', () => ({ VoiceConfigCard: () => null }))
vi.mock('../../services/channel', () => ({ channelService: {
  listInstances: vi.fn(), listImplementations: vi.fn(), getHealth: vi.fn(), getInstanceConfig: vi.fn(),
  updateInstanceConfig: vi.fn(), getLocalConfig: vi.fn(), saveLocalConfig: vi.fn(),
} }))

const schema = { type: 'object', properties: {
  WECHAT_ONLY_RESPOND_TO_MENTIONS: {
    type: 'string', title: '群聊仅响应定向消息', enum: ['true', 'false'], default: 'false',
    'x-runtime-path': 'group.only_respond_to_mentions',
  },
} }
const config = { platform: 'wechat', credentials: { api_key: '***' }, group: { only_respond_to_mentions: false } }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(channelService.listInstances).mockResolvedValue({ items: [{
    id: 'wechat-test', name: '微信测试', platform: 'wechat', implementation_id: 'channel-wechat',
    auto_start: false, runtime_status: 'running',
  }], pagination: {} } as any)
  vi.mocked(channelService.listImplementations).mockResolvedValue({ items: [{ id: 'channel-wechat', config_schema: schema }], pagination: {} } as any)
  vi.mocked(channelService.getHealth).mockResolvedValue({ status: 'healthy', details: {} })
  vi.mocked(channelService.getInstanceConfig).mockResolvedValue({ config } as any)
  vi.mocked(channelService.updateInstanceConfig).mockResolvedValue({ config, requires_restart: false } as any)
  vi.mocked(channelService.getLocalConfig).mockResolvedValue({ config: {} })
  vi.mocked(channelService.saveLocalConfig).mockResolvedValue({ config: {} })
})

async function openConfig() {
  await act(async () => { render(<MemoryRouter><ChannelConfig /></MemoryRouter>) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^配置/ })) })
}

describe('Channel boolean fields', () => {
  it('renders a boolean enum as a switch with no unset or free-text choice', async () => {
    await openConfig()
    const field = screen.getByRole('checkbox', { name: '群聊仅响应定向消息' })
    expect(field).not.toBeChecked()
    expect(screen.queryByRole('combobox')).toBeNull()
    fireEvent.click(field)
    expect(field).toBeChecked()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存配置' })) })
    expect(channelService.updateInstanceConfig).toHaveBeenCalledWith('wechat-test', {
      ...config, group: { only_respond_to_mentions: 'true' },
    })
  })

  it('uses a typed switch for a nested boolean without a runtime schema', async () => {
    vi.mocked(channelService.listImplementations).mockResolvedValue({ items: [], pagination: {} })
    await openConfig()
    const field = screen.getByRole('checkbox', { name: 'group.only_respond_to_mentions' })
    expect(field).not.toBeChecked()
    fireEvent.click(field)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存配置' })) })
    expect(channelService.updateInstanceConfig).toHaveBeenCalledWith('wechat-test', {
      ...config, group: { only_respond_to_mentions: true },
    })
  })

  it.each([undefined, 'true', 'false'])('renders stopped configuration %s as a switch', async saved => {
    vi.mocked(channelService.listInstances).mockResolvedValue({ items: [{
      id: 'wechat-test', name: '微信测试', platform: 'wechat', implementation_id: 'channel-wechat',
      auto_start: false, runtime_status: 'stopped',
    }], pagination: {} } as any)
    vi.mocked(channelService.getLocalConfig).mockResolvedValue({ config: saved === undefined ? {} : { WECHAT_ONLY_RESPOND_TO_MENTIONS: saved } })
    await openConfig()
    const field = screen.getByRole('checkbox', { name: '群聊仅响应定向消息' })
    expect((field as HTMLInputElement).checked).toBe(saved === 'true')
    expect(screen.queryByRole('combobox')).toBeNull()
    fireEvent.click(field)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存配置' })) })
    expect(channelService.saveLocalConfig).toHaveBeenCalledWith('wechat-test', {
      WECHAT_ONLY_RESPOND_TO_MENTIONS: saved === 'true' ? 'false' : 'true',
    })
  })
})
