import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { SlackLocalOnboarding } from './SlackLocalOnboarding'
import { channelService } from '../../services/channel'
import { friendService } from '../../services/friend'
import type { OnboardPollEvent } from '../../types'
vi.mock('../../components/Layout/MainLayout', () => ({ MainLayout: ({ children }: any) => <div>{children}</div> }))
vi.mock('../../services/channel', () => ({ channelService: { onboardBegin: vi.fn(), onboardPoll: vi.fn(), onboardSubmit: vi.fn(), onboardFinish: vi.fn(), onboardCancel: vi.fn(async () => ({})), getHealth: vi.fn(async () => ({ details: { platform_connected: true } })) } }))
vi.mock('../../services/friend', () => ({ friendService: { listFriends: vi.fn(async () => ({ items: [{ id: 'master', display_name: '已有主人', permission: 'master' }] })), linkIdentity: vi.fn(async () => ({})) } }))
let poll: (event: OnboardPollEvent) => void
afterEach(() => { vi.unstubAllGlobals() })
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(channelService.onboardBegin).mockResolvedValue({ session_id: 'session-one', ui_mode: 'challenge_code', authorization_command: '/slackauthticket fixture-ticket', expires_at: Date.now() + 600000 })
  vi.mocked(channelService.onboardPoll).mockImplementation((_impl, _method, _session, callback) => { poll = callback; return { close: vi.fn() } })
  vi.mocked(channelService.onboardSubmit).mockResolvedValue({ accepted: true })
  vi.mocked(channelService.onboardFinish).mockResolvedValue({ instance: { id: 'slack-one' } as never, authorized_identity: { platform_user_id: 'UOWNER' } })
})
async function start() {
  render(<MemoryRouter><SlackLocalOnboarding /></MemoryRouter>)
  expect(channelService.onboardBegin).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('渠道名称'), { target: { value: 'slack-one' } })
  fireEvent.click(screen.getByRole('button', { name: '开始授权' }))
  await screen.findByLabelText('一次性验证码')
}
describe('Slack local setup experience', () => {
  it('copies the exact authorization command as plain text and confirms success', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await start()
    const command = screen.getByRole('textbox', { name: '一次性授权命令' })
    expect(command).toHaveValue('/slackauthticket fixture-ticket')
    expect(command).toHaveAttribute('readonly')
    fireEvent.click(screen.getByRole('button', { name: '复制授权命令' }))
    await screen.findByText('已复制纯文本命令')
    expect(writeText).toHaveBeenCalledWith('/slackauthticket fixture-ticket')
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it.each(['denied', 'unavailable'])('selects a plain-text fallback when clipboard is %s', async state => {
    vi.stubGlobal('navigator', state === 'denied' ? { clipboard: { writeText: vi.fn(async () => { throw new Error('denied') }) } } : {})
    await start()
    fireEvent.click(screen.getByRole('button', { name: '复制授权命令' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('已选中纯文本命令')
    const command = screen.getByRole('textbox', { name: '一次性授权命令' }) as HTMLTextAreaElement
    expect(command).toHaveFocus()
    expect(command.selectionStart).toBe(0)
    expect(command.selectionEnd).toBe(command.value.length)
    const setData = vi.fn()
    fireEvent.copy(command, { clipboardData: { setData } })
    expect(setData).toHaveBeenCalledOnce()
    expect(setData).toHaveBeenCalledWith('text/plain', '/slackauthticket fixture-ticket')
  })

  it('preserves uppercase instance names when starting authorization, matching the updated contract', async () => {
    render(<MemoryRouter><SlackLocalOnboarding /></MemoryRouter>)
    fireEvent.change(screen.getByLabelText('渠道名称'), { target: { value: 'Slack-one' } })
    fireEvent.click(screen.getByRole('button', { name: '开始授权' }))
    await screen.findByLabelText('一次性验证码')
    expect(channelService.onboardBegin).toHaveBeenCalledWith('channel-slack', 'local-cli', { instance_name: 'Slack-one' })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps a newer terminal SSE result when a submit HTTP response arrives late', async () => {
    let reject!: (error: Error) => void
    vi.mocked(channelService.onboardSubmit).mockReturnValueOnce(new Promise((_resolve, r) => { reject = r }))
    await start()
    fireEvent.change(screen.getByLabelText('一次性验证码'), { target: { value: 'fixture-code' } })
    fireEvent.click(screen.getByRole('button', { name: '确认并配置 App' }))
    act(() => { poll({ type: 'success' }) })
    await screen.findByLabelText('关联对话对象')
    await act(async () => { reject(new Error('stale submit response')) })
    expect(screen.queryByText('stale submit response')).toBeNull()
    expect(screen.getByLabelText('关联对话对象')).toBeTruthy()
  })
  it('requires explicit authorization and Friend confirmation; never automatically claims Master or marks real messages verified', async () => {
    await start()
    expect(screen.getByText('/slackauthticket fixture-ticket')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('一次性验证码'), { target: { value: 'fixture-code' } })
    fireEvent.click(screen.getByRole('button', { name: '确认并配置 App' }))
    await waitFor(() => expect(channelService.onboardSubmit).toHaveBeenCalledWith('channel-slack', 'local-cli', 'session-one', 'fixture-code'))
    expect(screen.queryByLabelText('一次性验证码')).toBeNull()
    act(() => { poll({ type: 'pending' }) })
    expect(screen.queryByLabelText('一次性验证码')).toBeNull()
    act(() => { poll({ type: 'success' }); poll({ type: 'success' }) })
    const select = await screen.findByLabelText('关联对话对象')
    await screen.findByText('已有主人')
    expect(select).toHaveValue('')
    expect(friendService.linkIdentity).not.toHaveBeenCalled()
    expect(channelService.onboardFinish).toHaveBeenCalledTimes(1)
    fireEvent.change(select, { target: { value: 'master' } })
    fireEvent.click(screen.getByRole('button', { name: '确认关联' }))
    await waitFor(() => expect(friendService.linkIdentity).toHaveBeenCalledWith('master', { channel_id: 'slack-one', platform_user_id: 'UOWNER', platform_display_name: 'UOWNER' }))
    expect(screen.getByText(/真实消息收发尚未验证/)).toBeTruthy()
  })
  it('retries finish using the same session rather than creating a new App', async () => {
    vi.mocked(channelService.onboardFinish).mockRejectedValueOnce(new Error('磁盘写入失败'))
    await start()
    act(() => { poll({ type: 'success' }) })
    fireEvent.click(await screen.findByRole('button', { name: '重试完成创建' }))
    await screen.findByLabelText('关联对话对象')
    expect(channelService.onboardBegin).toHaveBeenCalledTimes(1)
    expect(channelService.onboardFinish).toHaveBeenCalledTimes(2)
  })
  it('cancels on leaving and discards delayed begin results', async () => {
    let resolve!: (value: any) => void
    vi.mocked(channelService.onboardBegin).mockReturnValue(new Promise(r => { resolve = r }))
    const view = render(<MemoryRouter><SlackLocalOnboarding /></MemoryRouter>)
    fireEvent.change(screen.getByLabelText('渠道名称'), { target: { value: 'slack-one' } })
    fireEvent.click(screen.getByRole('button', { name: '开始授权' }))
    view.unmount()
    await act(async () => { resolve({ session_id: 'late-session', ui_mode: 'challenge_code' }) })
    expect(channelService.onboardCancel).toHaveBeenCalledWith('channel-slack', 'local-cli', 'late-session')
    expect(channelService.onboardPoll).not.toHaveBeenCalled()
  })
})
