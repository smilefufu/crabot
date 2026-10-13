import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { friendService } from '../../services/friend'
import { api } from '../../services/api'
import { VoiceContacts } from './VoiceContacts'
import { voiceService } from '../../services/voice'
import { VoiceConfigCard } from './VoiceConfigCard'
import { AudioServiceEditor } from './AudioServiceEditor'

vi.mock('../../services/voice', () => ({ voiceService: { list: vi.fn(), config: vi.fn(), saveConfig: vi.fn(), action: vi.fn(), test: vi.fn(), save: vi.fn(), remove: vi.fn(), connection: vi.fn(async () => null), saveConnection: vi.fn(async (_id, value) => value) } }))
vi.mock('../../services/friend', () => ({ friendService: { linkIdentity: vi.fn(async () => ({})), unlinkIdentity: vi.fn(async () => ({})), listFriends: vi.fn(async () => ({ items: [{ id: 'fufu', display_name: 'FuFu' }] })) } }))
vi.mock('../../services/session', () => ({ sessionService: { listSessions: vi.fn(async () => ({ items: [{ id: 'group-1', platform_session_id: 'household' }] })), getGroupConfig: vi.fn(async () => ({ config: null })) } }))
vi.mock('../../services/provider', () => ({ providerService: { getGlobalConfig: vi.fn(async () => ({})) } }))
vi.mock('../../services/api', () => ({ api: { post: vi.fn(async () => ({ resolved: { tool_access: { memory: true, messaging: true, shell: false, desktop: false }, storage: null } })) } }))
vi.mock('../../services/permission-template', () => ({ permissionTemplateService: { list: vi.fn(async () => ({ items: [{ id: 'minimal', name: '最小权限', tool_access: { memory: true, messaging: true }, cli_access: {}, memory_scopes: [], storage: null }, { id: 'group_default', name: '默认群权限', tool_access: { memory: true, messaging: true }, cli_access: {}, memory_scopes: [], storage: null }] })) } }))
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,fixture') } }))
const provider = { id: 'provider', name: '自建音频', format: 'openai-audio' as const, endpoint: 'https://local.example/v1', has_api_key: true,
  models: [{ model_id: 'asr', display_name: 'ASR', capabilities: ['asr' as const] }] }
let terminal: Record<string, unknown>
beforeEach(() => {
  vi.clearAllMocks()
  terminal = { paired: false, connected: false, foreground: false, microphone: 'closed', playback: 'idle', aec_verified: false, enrollment_revision: 0, contacts: [], registrations: [], hosts: ['http://192.168.1.2:3000'] }
  vi.mocked(voiceService.list).mockResolvedValue({ items: [provider] })
  vi.mocked(voiceService.config).mockResolvedValue({ asr: null, tts: null, wake_word: '你好螃蟹' })
  vi.mocked(voiceService.action).mockImplementation(async (_id, command) => {
    if (command.action === 'create_pairing') return { action: 'create_pairing', pairing: { protocol_version: 4, channel_id: '客厅', pairing_id: 'p-1', url: 'wss://local.example:1234/voice', tls_fingerprint_sha256: 'fingerprint', nonce: 'one-time', verification_code: '123456', expires_at: new Date(Date.now() + 60000).toISOString() } }
    return { action: 'status', state: terminal as never }
  })
})
afterEach(() => { vi.useRealTimers() })
describe('native voice instance configuration', () => {
  it('saves provider/model references without any connection snapshot and displays effective group permissions', async () => {
    render(<MemoryRouter><VoiceConfigCard channelId="客厅" running /></MemoryRouter>)
    await screen.findByLabelText('语音转文字 ASR')
    fireEvent.change(screen.getByLabelText('语音转文字 ASR'), { target: { value: JSON.stringify({ provider_id: 'provider', model_id: 'asr' }) } })
    fireEvent.click(screen.getByRole('button', { name: '保存语音配置' }))
    await waitFor(() => expect(voiceService.saveConfig).toHaveBeenCalledWith('客厅', { asr: { provider_id: 'provider', model_id: 'asr' }, tts: null, wake_word: '你好螃蟹' }))
    expect(await screen.findByLabelText('群权限模板')).toBeTruthy()
    expect(screen.getByText(/所有发言者共用一个语音群/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('记忆范围'), { target: { value: 'unsaved-scope' } })
    terminal = { ...terminal, contacts: [{ platform_user_id: 'new-contact', display_name: '新联系人' }] }
    await screen.findByRole('option', { name: '新联系人' }, { timeout: 4000 })
    expect(screen.getByLabelText('记忆范围')).toHaveValue('unsaved-scope')
  })
  it('cannot confirm a QR until the phone has connected and the same verification code is present', async () => {
    render(<MemoryRouter><VoiceConfigCard channelId="客厅" running /></MemoryRouter>)
    await screen.findByLabelText('手机可访问的后台地址')
    fireEvent.change(screen.getByLabelText('手机可访问的后台地址'), { target: { value: 'http://192.168.1.2:3000' } })
    fireEvent.click(screen.getByRole('button', { name: '保存连接地址' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '生成一次性配对码' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '生成一次性配对码' }))
    const confirmation = await screen.findByRole('button', { name: '核对一致，确认配对' })
    expect(confirmation).toBeDisabled()
    terminal = { ...terminal, pairing_id: 'p-1', verification_code: '123456' }
    await waitFor(() => expect(confirmation).toBeEnabled(), { timeout: 4000 })
  })
  it('creates a contact offline and binds an existing Friend using the stable channel identity', async () => {
    vi.mocked(voiceService.action).mockResolvedValue({ action: 'create_contact', contact: { platform_user_id: 'contact-1', display_name: 'FuFu' } })
    render(<VoiceContacts channelId="voice" onChanged={async () => {}} />)
    fireEvent.change(screen.getByLabelText('联系人名称'), { target: { value: 'FuFu' } })
    fireEvent.click(screen.getByRole('button', { name: '创建渠道联系人' }))
    await screen.findByText('联系人已创建，可绑定好友或登记声纹')
    expect(screen.getByRole('button', { name: '登记声纹' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('已有好友'), { target: { value: 'fufu' } })
    fireEvent.click(screen.getByRole('button', { name: '绑定已有好友' }))
    await waitFor(() => expect(friendService.linkIdentity).toHaveBeenCalledWith('fufu', { channel_id: 'voice', platform_user_id: 'contact-1', platform_display_name: 'FuFu' }))
    expect(screen.queryByLabelText(/Friend ID/)).toBeNull()
  })
  it('creates a normal Friend with an existing template and enrolls by contact rather than Friend ID', async () => {
    const state = { ...terminal, connected: true, foreground: true, contacts: [{ platform_user_id: 'contact-2', display_name: '来宾' }] }
    vi.mocked(api.post).mockResolvedValue({ friend: { id: 'new-friend', display_name: '来宾' } })
    const refresh = vi.fn(async () => {})
    render(<VoiceContacts channelId="voice" state={state as never} onChanged={refresh} />)
    fireEvent.click(await screen.findByRole('button', { name: '登记声纹' }))
    await waitFor(() => expect(voiceService.action).toHaveBeenCalledWith('voice', { action: 'enroll', platform_user_id: 'contact-2' }))
    fireEvent.change(screen.getByLabelText('绑定的渠道联系人'), { target: { value: 'contact-2' } })
    fireEvent.change(screen.getByLabelText('新好友权限模板'), { target: { value: 'minimal' } })
    fireEvent.click(screen.getByRole('button', { name: '创建并绑定普通好友' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/friends', { display_name: '来宾', permission: 'normal', permission_template_id: 'minimal', channel_identities: [{ channel_id: 'voice', platform_user_id: 'contact-2', platform_display_name: '来宾' }] }))
  })
  it('keeps saved API keys masked and switches model capabilities with the selected native format', async () => {
    render(<AudioServiceEditor provider={provider} onSaved={async () => {}} onCancel={() => {}} />)
    expect(screen.getByLabelText('API key')).toHaveValue('')
    expect(screen.queryByLabelText('音频去向')).toBeNull()
    fireEvent.change(screen.getByLabelText('接口格式'), { target: { value: 'mlx-audio-http' } })
    expect(screen.getByLabelText('文字转语音')).toBeChecked()
    expect(screen.getByLabelText('语音转文字')).not.toBeChecked()
    fireEvent.change(screen.getByLabelText('voice'), { target: { value: 'zf_xiaobei' } })
    fireEvent.click(screen.getByRole('button', { name: '保存服务' }))
    await waitFor(() => expect(voiceService.save).toHaveBeenCalled())
    expect(vi.mocked(voiceService.save).mock.calls[0][0]).toMatchObject({ api_key: '', format: 'mlx-audio-http', models: [{ capabilities: ['tts'], voice: 'zf_xiaobei' }] })
  })
})
