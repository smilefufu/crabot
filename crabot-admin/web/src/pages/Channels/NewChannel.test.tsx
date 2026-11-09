import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { NewChannel } from './NewChannel'
import { ChannelConfig } from './ChannelConfig'
import { channelService } from '../../services/channel'

vi.mock('../../components/Layout/MainLayout', () => ({ MainLayout: ({ children }: any) => <div>{children}</div> }))
vi.mock('../../contexts/ToastContext', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) }))
vi.mock('./VoiceConfigCard', () => ({ VoiceConfigCard: () => null }))
vi.mock('../../services/channel', () => ({ channelService: { listImplementations: vi.fn(), listInstances: vi.fn() } }))
const implementations = [
  { id: 'channel-feishu', name: '飞书', platform: 'feishu', onboarding_methods: [{ id: 'device_code_oauth', name: '扫码授权', type: 'device_code' }] },
  { id: 'channel-slack', name: 'Slack', platform: 'slack', onboarding_methods: [{ id: 'scan', name: '授权', type: 'device_code' }] },
  { id: 'channel-telegram', name: 'Telegram', platform: 'telegram' },
]
beforeEach(() => {
  vi.mocked(channelService.listImplementations).mockResolvedValue({ items: implementations, pagination: {} } as any)
  vi.mocked(channelService.listInstances).mockResolvedValue({ items: [], pagination: {} } as any)
})
function view(url = '/channels/new') {
  return render(<MemoryRouter initialEntries={[url]}><Routes>
    <Route path="/channels/new" element={<NewChannel />} />
    <Route path="/channels/config" element={<ChannelConfig />} />
    <Route path="/channels/new/channel-feishu/device_code_oauth" element={<div>现有飞书扫码流程</div>} />
  </Routes></MemoryRouter>)
}
it('飞书只提供现有扫码入口，其他平台仍可手动创建', async () => {
  view()
  const scan = await screen.findByRole('button', { name: /飞书 · 扫码授权/ })
  expect(screen.queryByRole('button', { name: /飞书 · 手动填写/ })).toBeNull()
  expect(screen.getByRole('button', { name: /Slack · 手动填写/ })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Telegram · 手动填写/ })).toBeInTheDocument()
  fireEvent.click(scan)
  expect(await screen.findByText('现有飞书扫码流程')).toBeInTheDocument()
})
it('旧飞书手动创建链接进入现有扫码流程', async () => {
  view('/channels/config?implementation_id=channel-feishu')
  expect(await screen.findByText('现有飞书扫码流程')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '创建实例' })).toBeNull()
})
it('其他平台手动创建表单不再提供飞书选项', async () => {
  view('/channels/config?implementation_id=channel-telegram')
  await screen.findByRole('button', { name: '创建实例' })
  expect(screen.queryByRole('option', { name: /飞书/ })).toBeNull()
  expect(screen.getByRole('option', { name: /Telegram/ })).toBeInTheDocument()
})
