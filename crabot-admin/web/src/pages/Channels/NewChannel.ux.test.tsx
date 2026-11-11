import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { NewChannel } from './NewChannel'
import { channelService } from '../../services/channel'

vi.mock('../../components/Layout/MainLayout', () => ({ MainLayout: ({ children }: any) => <div>{children}</div> }))
vi.mock('../../services/channel', () => ({ channelService: { listImplementations: vi.fn(), listPlugins: vi.fn(), installPlugin: vi.fn(), createInstance: vi.fn(), onboardBegin: vi.fn() } }))
const feishu = { id: 'channel-feishu', name: '飞书', platform: 'feishu', onboarding_methods: [{ id: 'device_code_oauth', name: '扫码授权' }] }
const slack = { id: 'channel-slack', name: 'Slack', platform: 'slack', onboarding_methods: [{ id: 'local-cli', name: '本地授权' }] }
const telegram = { id: 'channel-telegram', name: 'Telegram', platform: 'telegram', config_schema: { type: 'object', properties: { token: { type: 'string' } } } }
const experimental = [{ id: 'channel-wechat', name: '微信', platform: 'wechat' }, { id: 'channel-voice', name: '语音', platform: 'voice' }]
const plugins = [feishu, slack, telegram, ...experimental].map(impl => ({ implementation_id: impl.id, name: impl.name, platform: impl.platform, package_name: `crabot-${impl.id}`, version: '0.1.3', installed: false }))
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(channelService.listImplementations).mockResolvedValue({ items: [feishu], pagination: {} } as any)
  vi.mocked(channelService.listPlugins).mockResolvedValue({ items: plugins.map(plugin => ({ ...plugin, installed: plugin.implementation_id === feishu.id })) })
})
function view(url = '/channels/new') {
  return render(<MemoryRouter initialEntries={[url]}><Routes>
    <Route path="/channels/new" element={<NewChannel />} />
    <Route path="/channels/new/channel-feishu/device_code_oauth" element={<div>现有飞书扫码流程</div>} />
    <Route path="/channels/new/channel-slack/local-cli" element={<div>现有 Slack 本地授权</div>} />
    <Route path="/channels/config" element={<div>现有账号配置表单</div>} />
    <Route path="/channels/new/voice" element={<div>现有语音配对流程</div>} />
  </Routes></MemoryRouter>)
}
async function openCatalog() {
  await screen.findByRole('button', { name: '扫码连接飞书' })
  fireEvent.click(screen.getByRole('button', { name: /在其他平台上与 CRABOT 协作/ }))
  return screen.getByRole('region', { name: '其他协作平台' })
}
it('使用正式名称和产品按钮，只有安装后的飞书可直接扫码', async () => {
  view()
  const scan = await screen.findByRole('button', { name: '扫码连接飞书' })
  expect(screen.getByRole('heading', { name: '在哪里与 CRABOT 协作？' })).toBeInTheDocument()
  expect(scan).toHaveClass('btn')
  expect(screen.queryByText('前往模块页安装 Channel')).toBeNull()
  expect(screen.queryByRole('button', { name: /接入 Telegram/ })).toBeNull()
  fireEvent.click(scan)
  expect(await screen.findByText('现有飞书扫码流程')).toBeInTheDocument()
})
it('零安装时直接展开平台接入，但不提供账号创建动作', async () => {
  vi.mocked(channelService.listImplementations).mockResolvedValue({ items: [], pagination: {} } as any)
  vi.mocked(channelService.listPlugins).mockResolvedValue({ items: plugins })
  view()
  expect(await screen.findByRole('button', { name: '接入飞书' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /扫码连接飞书|手动填写|继续设置/ })).toBeNull()
  expect(channelService.installPlugin).not.toHaveBeenCalled()
})
it('同页安装到原位继续，安装中不能重复提交，安装成功不是平台已连接', async () => {
  let finish!: (value: any) => void
  vi.mocked(channelService.installPlugin).mockReturnValue(new Promise(resolve => { finish = resolve }))
  view()
  const catalog = await openCatalog()
  const connect = within(catalog).getByRole('button', { name: '接入 Telegram' })
  fireEvent.click(connect)
  expect(connect).toBeDisabled()
  expect(within(catalog).getByText('正在安装所需插件，完成后继续设置')).toBeInTheDocument()
  fireEvent.click(connect)
  expect(channelService.installPlugin).toHaveBeenCalledTimes(1)
  finish({ implementation: telegram })
  const next = await within(catalog).findByRole('button', { name: '继续设置 Telegram' })
  expect(within(catalog).getByText('插件已就绪，下一步设置账号')).toBeInTheDocument()
  expect(screen.queryByText('已连接')).toBeNull()
  expect(channelService.createInstance).not.toHaveBeenCalled()
  expect(channelService.onboardBegin).not.toHaveBeenCalled()
  fireEvent.click(next)
  expect(await screen.findByText('现有账号配置表单')).toBeInTheDocument()
})
it('多种配置方式安装后由用户选择，沿用返回的真实 implementation', async () => {
  vi.mocked(channelService.installPlugin).mockResolvedValue({ implementation: slack } as any)
  view()
  const catalog = await openCatalog()
  fireEvent.click(within(catalog).getByRole('button', { name: '接入 Slack' }))
  fireEvent.click(await within(catalog).findByRole('button', { name: '继续设置 Slack' }))
  const choose = within(catalog).getByRole('group', { name: '选择 Slack 的配置方式' })
  expect(within(choose).getByRole('button', { name: '手动填写' })).toBeInTheDocument()
  fireEvent.click(within(choose).getByRole('button', { name: '本地授权' }))
  expect(await screen.findByText('现有 Slack 本地授权')).toBeInTheDocument()
})
it('安装失败可原位重试，不创建或授权账号', async () => {
  vi.mocked(channelService.installPlugin).mockRejectedValueOnce(new Error('国内源暂不可用')).mockResolvedValueOnce({ implementation: telegram } as any)
  view()
  const catalog = await openCatalog()
  fireEvent.click(within(catalog).getByRole('button', { name: '接入 Telegram' }))
  expect(await within(catalog).findByRole('alert')).toHaveTextContent('国内源暂不可用')
  fireEvent.click(within(catalog).getByRole('button', { name: '重试接入 Telegram' }))
  expect(await within(catalog).findByRole('button', { name: '继续设置 Telegram' })).toBeInTheDocument()
  expect(channelService.createInstance).not.toHaveBeenCalled()
})
it('已安装和待接入的微信语音都默认折叠，已有配置方式仍可使用', async () => {
  vi.mocked(channelService.listImplementations).mockResolvedValue({ items: [feishu, ...experimental], pagination: {} } as any)
  vi.mocked(channelService.listPlugins).mockResolvedValue({ items: plugins.map(plugin => ({ ...plugin, installed: ['channel-feishu','channel-wechat','channel-voice'].includes(plugin.implementation_id) })) })
  view()
  await screen.findByRole('button', { name: '扫码连接飞书' })
  expect(screen.queryByRole('button', { name: '设置语音协作' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /更多协作方式（2）/ }))
  fireEvent.click(screen.getByRole('button', { name: '设置语音协作' }))
  expect(await screen.findByText('现有语音配对流程')).toBeInTheDocument()
})
it('未安装的实验性入口折叠，显式展开后才能接入', async () => {
  view()
  const catalog = await openCatalog()
  expect(within(catalog).queryByRole('button', { name: '接入微信' })).toBeNull()
  fireEvent.click(within(catalog).getByRole('button', { name: /更多协作方式（2）/ }))
  expect(within(catalog).getByRole('button', { name: '接入微信' })).toBeInTheDocument()
  expect(within(catalog).getByRole('button', { name: '设置语音协作' })).toBeInTheDocument()
})
it('目录加载失败显示重试，不当作零安装，也不下载', async () => {
  vi.mocked(channelService.listPlugins).mockRejectedValueOnce(new Error('目录读取失败')).mockResolvedValueOnce({ items: plugins })
  view()
  expect(await screen.findByRole('alert')).toHaveTextContent('目录读取失败')
  expect(screen.queryByRole('button', { name: '接入飞书' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
  await screen.findByRole('button', { name: '扫码连接飞书' })
  expect(channelService.installPlugin).not.toHaveBeenCalled()
})
it('从模块页定位已安装实验性平台，无效定位不触发安装', async () => {
  vi.mocked(channelService.listImplementations).mockResolvedValue({ items: [...experimental], pagination: {} } as any)
  view('/channels/new?implementation_id=channel-voice')
  expect(await screen.findByRole('button', { name: '设置语音协作' })).toBeInTheDocument()
  expect(channelService.installPlugin).not.toHaveBeenCalled()
})
it('未安装定位参数只提示，不自动接入或创建', async () => {
  view('/channels/new?implementation_id=channel-slack')
  expect(await screen.findByRole('status')).toHaveTextContent('指定的协作插件尚未就绪')
  await waitFor(() => expect(channelService.installPlugin).not.toHaveBeenCalled())
})
