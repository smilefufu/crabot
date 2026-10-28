import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { ChannelConfig } from './ChannelConfig'
import { channelService } from '../../services/channel'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }))
vi.mock('../../components/Layout/MainLayout', () => ({ MainLayout: ({ children }: any) => <div>{children}</div> }))
vi.mock('../../contexts/ToastContext', () => ({ useToast: () => toast }))
vi.mock('./VoiceConfigCard', () => ({ VoiceConfigCard: () => null }))
vi.mock('../../services/channel', () => ({ channelService: {
  listInstances: vi.fn(), listImplementations: vi.fn(), getHealth: vi.fn(), stopInstance: vi.fn(), deleteInstance: vi.fn(),
} }))
let status = 'running'
beforeEach(() => {
  vi.clearAllMocks()
  status = 'running'
  vi.mocked(channelService.listInstances).mockImplementation(async () => ({ items: [{
    id: '飞书客服', name: '飞书客服', platform: 'feishu', implementation_id: 'channel-feishu',
    auto_start: false, runtime_status: status,
  }], pagination: {} } as any))
  vi.mocked(channelService.listImplementations).mockResolvedValue({ items: [], pagination: {} })
  vi.mocked(channelService.getHealth).mockResolvedValue({ status: 'ok', details: {} })
  vi.mocked(channelService.stopInstance).mockResolvedValue({ status: 'running' })
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
async function view() {
  await act(async () => { render(<MemoryRouter><ChannelConfig /></MemoryRouter>) })
}
describe('Channel 停止状态展示', () => {
  it('停止仍在进行时不宣称已停止，随后自动显示真实停止状态与删除按钮', async () => {
    vi.useFakeTimers()
    await view()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '停止' })))
    expect(channelService.stopInstance).toHaveBeenCalledWith('飞书客服')
    expect(toast.success).not.toHaveBeenCalledWith('Channel 已停止')
    status = 'stopped'
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(screen.getByRole('button', { name: '删除' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: '停止' })).toBeNull()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.mocked(channelService.deleteInstance).mockResolvedValue(undefined)
    vi.mocked(channelService.listInstances).mockResolvedValueOnce({ items: [], pagination: {} })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '删除' })))
    expect(channelService.deleteInstance).toHaveBeenCalledWith('飞书客服')
    expect(screen.queryByText('飞书客服')).toBeNull()
  })

  it.each(['error', 'unknown'])('停止返回 %s 时不报成功', async result => {
    vi.mocked(channelService.stopInstance).mockResolvedValue({ status: result })
    await view()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '停止' })))
    expect(toast.success).not.toHaveBeenCalledWith('Channel 已停止')
    expect(toast.error).toHaveBeenCalled()
  })

  it('仅在返回 stopped 时显示停止成功', async () => {
    vi.mocked(channelService.stopInstance).mockResolvedValue({ status: 'stopped' })
    await view()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '停止' })))
    expect(toast.success).toHaveBeenCalledWith('Channel 已停止')
  })
})
