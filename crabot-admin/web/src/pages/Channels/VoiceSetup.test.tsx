import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { StrictMode } from 'react'
import { VoiceSetup } from './VoiceSetup'
import { voiceService } from '../../services/voice'

vi.mock('../../components/Layout/MainLayout', () => ({ MainLayout: ({ children }: any) => <div>{children}</div> }))
vi.mock('../../services/channel', () => ({ channelService: { getInstance: vi.fn(async id => ({ instance: { id, name: id, implementation_id: 'channel-voice', voice_setup: { status: 'draft', owner_activation_required: id !== 'old-phone' } } })) } }))
vi.mock('../../services/voice', () => ({ voiceService: { setup: vi.fn(), resume: vi.fn(), saveConfig: vi.fn(), pause: vi.fn(), finish: vi.fn(), test: vi.fn() } }))
vi.mock('./VoiceServices', () => ({ VoiceServices: ({ onChange }: any) => <button onClick={() => onChange({ asr: { provider_id: 'service', model_id: 'asr' }, tts: { provider_id: 'service', model_id: 'tts' }, wake_word: '你好螃蟹' })}>选择服务</button> }))
let ownerStatus = 'completed'
vi.mock('./VoiceConfigCard', async () => {
  const { useEffect } = await import('react')
  return { VoiceConfigCard: ({ stage, onState, onDirty }: any) => {
    useEffect(() => { onState({ paired: true, connected: true, foreground: true, owner_activation: { status: ownerStatus } }) }, [stage])
    return <div>阶段：{stage}{stage === 'contacts' && <><button onClick={() => onDirty(true)}>编辑群权限</button><button onClick={() => onDirty(false)}>保存群权限</button></>}</div>
  } }
})
beforeEach(() => {
  vi.clearAllMocks()
  ownerStatus = 'completed'
  vi.mocked(voiceService.setup).mockImplementation(async name => ({ instance: { id: name, name, implementation_id: 'channel-voice', voice_setup: { status: 'draft', owner_activation_required: true } } as never }))
  vi.mocked(voiceService.resume).mockResolvedValue({ instance: {} as never })
  vi.mocked(voiceService.test).mockResolvedValue({ ok: true })
  vi.mocked(voiceService.finish).mockRejectedValue(new Error('手机已断线，草稿保留'))
})
function view(url = '/channels/new/voice') {
  render(<StrictMode><MemoryRouter initialEntries={[url]}><Routes><Route path="/channels/new/voice" element={<VoiceSetup />} /><Route path="/channels/config" element={<div>渠道列表</div>} /></Routes></MemoryRouter></StrictMode>)
}
describe('Voice creation wizard', () => {
  it('retains the same draft and stays on services when the first-step ASR test fails', async () => {
    vi.mocked(voiceService.test).mockResolvedValueOnce({ ok: false })
    view()
    fireEvent.change(screen.getByLabelText('渠道名称'), { target: { value: '手机' } })
    fireEvent.click(screen.getByRole('button', { name: '选择服务' }))
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('ASR 测试未通过')
    expect(screen.queryByText('阶段：phone')).toBeNull()
    expect(voiceService.test).toHaveBeenCalledWith('手机', 'asr')
    expect(voiceService.test).not.toHaveBeenCalledWith('手机', 'tts')
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    await screen.findByText('阶段：phone')
    expect(voiceService.setup).toHaveBeenCalledTimes(1)
    expect(voiceService.test).toHaveBeenCalledWith('手机', 'tts')
  })
  it('creates once, prepares the phone automatically, blocks unsaved permissions and retains failed finish', async () => {
    view()
    fireEvent.change(screen.getByLabelText('渠道名称'), { target: { value: '手机' } })
    expect(screen.getByRole('button', { name: '下一步' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '选择服务' }))
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    await screen.findByText('阶段：phone')
    expect(voiceService.setup).toHaveBeenCalledTimes(1); expect(voiceService.resume).toHaveBeenCalledWith('手机')
    await waitFor(() => expect(screen.getByRole('button', { name: '下一步' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    await screen.findByRole('button', { name: '编辑群权限' })
    fireEvent.click(screen.getByRole('button', { name: '编辑群权限' }))
    expect(screen.getByRole('button', { name: '下一步' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '保存群权限' }))
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    fireEvent.click(await screen.findByRole('button', { name: '检查并完成创建' }))
    await screen.findByRole('alert')
    expect(screen.getByText('手机已断线，草稿保留')).toBeTruthy()
    expect(voiceService.finish).toHaveBeenCalledWith('手机'); expect(screen.queryByText('渠道列表')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '保存并退出' }))
    await waitFor(() => expect(voiceService.pause).toHaveBeenCalledWith('手机'))
  })
  it('does not pass the new phone step while owner association is pending', async () => {
    ownerStatus = 'pending'
    view()
    fireEvent.change(screen.getByLabelText('渠道名称'), { target: { value: '手机' } })
    fireEvent.click(screen.getByRole('button', { name: '选择服务' }))
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    await screen.findByText('阶段：phone')
    await waitFor(() => expect(screen.getByRole('button', { name: '下一步' })).toBeDisabled())
    expect(voiceService.finish).not.toHaveBeenCalled()
  })
  it('continues the same persisted ID without another creation', async () => {
    view('/channels/new/voice?instance_id=old-phone')
    expect(screen.getByLabelText('渠道名称')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '选择服务' }))
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    await screen.findByText('阶段：phone')
    expect(voiceService.setup).not.toHaveBeenCalled(); expect(voiceService.saveConfig).toHaveBeenCalledWith('old-phone', expect.objectContaining({ wake_word: '你好螃蟹' }))
    expect(voiceService.resume).toHaveBeenCalledWith('old-phone')
  })
})
