import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { NewChannelOnboarding } from './NewChannelOnboarding'
import { channelService } from '../../services/channel'

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))
vi.mock('../../components/Layout/MainLayout', () => ({ MainLayout: ({ children }: any) => <div>{children}</div> }))
vi.mock('../../contexts/ToastContext', () => ({ useToast: () => toast }))
vi.mock('../../services/channel', () => ({ channelService: {
  getImplementation: vi.fn(), onboardBegin: vi.fn(), onboardPoll: vi.fn(), onboardFinish: vi.fn(), onboardCancel: vi.fn(),
} }))
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(channelService.getImplementation).mockResolvedValue({ implementation: {
    id: 'channel-feishu', name: 'Feishu', onboarding_methods: [{ id: 'scan', name: '扫码授权', type: 'device_code' }],
  } } as any)
  vi.mocked(channelService.onboardBegin).mockResolvedValue({ session_id: 'session', ui_mode: 'pending' } as any)
  vi.mocked(channelService.onboardPoll).mockReturnValue({ close: vi.fn() })
  vi.mocked(channelService.onboardFinish).mockResolvedValue({ instance: { id: 'AI客服bot' } } as any)
  vi.mocked(channelService.onboardCancel).mockResolvedValue({} as any)
})
function view() {
  render(<MemoryRouter initialEntries={['/channels/new/channel-feishu/scan']}><Routes>
    <Route path="/channels/new/:implId/:methodId" element={<NewChannelOnboarding />} />
    <Route path="/channels/config" element={<div>渠道配置</div>} />
  </Routes></MemoryRouter>)
}
describe('扫码实例名称校验', () => {
  it('允许 AI客服bot，授权完成后原样提交名称', async () => {
    view()
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'AI客服bot' } })
    fireEvent.click(screen.getByRole('button', { name: '开始 扫码' }))
    await waitFor(() => expect(channelService.onboardPoll).toHaveBeenCalledTimes(1))
    expect(toast.error).not.toHaveBeenCalled()
    const onEvent = vi.mocked(channelService.onboardPoll).mock.calls[0][3]
    await act(async () => onEvent({ type: 'success' } as any))
    await screen.findByText('渠道配置')
    expect(channelService.onboardFinish).toHaveBeenCalledWith('channel-feishu', 'scan', 'session', 'AI客服bot')
  })

  it('仍在开始授权前拒绝非法字符', async () => {
    view()
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'AI 客服bot' } })
    fireEvent.click(screen.getByRole('button', { name: '开始 扫码' }))
    expect(toast.error).toHaveBeenCalled()
    expect(channelService.onboardBegin).not.toHaveBeenCalled()
  })
})
