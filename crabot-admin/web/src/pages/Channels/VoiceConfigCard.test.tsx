import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { voiceService } from '../../services/voice'
import { VoiceConfigCard } from './VoiceConfigCard'
import { AudioServiceEditor } from './AudioServiceEditor'

vi.mock('../../services/voice', () => ({ voiceService: { list: vi.fn(), config: vi.fn(), saveConfig: vi.fn(), action: vi.fn(), test: vi.fn(), save: vi.fn(), remove: vi.fn() } }))
vi.mock('../../services/friend', () => ({ friendService: { listFriends: vi.fn(async () => ({ items: [{ id: 'fufu', display_name: 'FuFu' }] })) } }))
vi.mock('../../services/session', () => ({ sessionService: { listSessions: vi.fn(async () => ({ items: [{ id: 'group-1', platform_session_id: 'household' }] })), getGroupConfig: vi.fn(async () => ({ config: null })) } }))
vi.mock('../../services/api', () => ({ api: { post: vi.fn(async () => ({ resolved: { tool_access: { memory: true, messaging: true, shell: false, desktop: false }, storage: null } })) } }))
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,fixture') } }))
const provider = { id: 'provider', name: '自建音频', kind: 'self_hosted' as const, format: 'openai-audio' as const, endpoint: 'https://local.example/v1', has_api_key: true,
  models: [{ model_id: 'asr', display_name: 'ASR', capabilities: ['asr' as const] }] }
let terminal: Record<string, unknown>
beforeEach(() => {
  vi.clearAllMocks()
  terminal = { paired: false, connected: false, foreground: false, microphone: 'closed', playback: 'idle', aec_verified: false, enrollment_revision: 0, registrations: [], hosts: ['192.168.1.2'] }
  vi.mocked(voiceService.list).mockResolvedValue({ items: [provider] })
  vi.mocked(voiceService.config).mockResolvedValue({ asr: null, tts: null, wake_word: '你好螃蟹' })
  vi.mocked(voiceService.action).mockImplementation(async (_id, command) => {
    if (command.action === 'create_pairing') return { action: 'create_pairing', pairing: { protocol_version: 1, channel_id: '客厅', pairing_id: 'p-1', url: 'wss://local.example:1234/voice', tls_fingerprint_sha256: 'fingerprint', nonce: 'one-time', verification_code: '123456', expires_at: new Date(Date.now() + 60000).toISOString() } }
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
    expect(await screen.findByText(/当前允许：记忆、消息/)).toBeTruthy()
    expect(screen.getByText(/Master 的语音不会获得私聊权限/)).toBeTruthy()
  })
  it('cannot confirm a QR until the phone has connected and the same verification code is present', async () => {
    render(<MemoryRouter><VoiceConfigCard channelId="客厅" running /></MemoryRouter>)
    await screen.findByLabelText('手机可访问的主机地址')
    fireEvent.change(screen.getByLabelText('手机可访问的主机地址'), { target: { value: '192.168.1.2' } })
    fireEvent.click(screen.getByRole('button', { name: '生成一次性配对码' }))
    const confirmation = await screen.findByRole('button', { name: '核对一致，确认配对' })
    expect(confirmation).toBeDisabled()
    terminal = { ...terminal, pairing_id: 'p-1', verification_code: '123456' }
    await waitFor(() => expect(confirmation).toBeEnabled(), { timeout: 4000 })
  })
  it('keeps saved API keys masked and switches model capabilities with the selected native format', async () => {
    render(<AudioServiceEditor provider={provider} onSaved={async () => {}} onCancel={() => {}} />)
    expect(screen.getByLabelText('API key')).toHaveValue('')
    fireEvent.change(screen.getByLabelText('接口格式'), { target: { value: 'mlx-audio-http' } })
    expect(screen.getByLabelText('文字转语音')).toBeChecked()
    expect(screen.getByLabelText('语音转文字')).not.toBeChecked()
    fireEvent.change(screen.getByLabelText('voice'), { target: { value: 'zf_xiaobei' } })
    fireEvent.click(screen.getByRole('button', { name: '保存服务' }))
    await waitFor(() => expect(voiceService.save).toHaveBeenCalled())
    expect(vi.mocked(voiceService.save).mock.calls[0][0]).toMatchObject({ api_key: '', format: 'mlx-audio-http', models: [{ capabilities: ['tts'], voice: 'zf_xiaobei' }] })
  })
})
