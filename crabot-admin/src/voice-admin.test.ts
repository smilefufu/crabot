import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { RpcError, sha256CanonicalJson, voiceSessionId, type Friend, type SubmitVoiceTurnParams, type VoiceRegistration } from 'crabot-shared'
import { VoiceAdmin, type VoiceAdminDeps } from './voice-admin.js'

describe('Voice Admin human surface and durable publication responsibility', () => {
  let dir: string, admin: VoiceAdmin, server: http.Server, url: string, deps: VoiceAdminDeps
  const channel = '玄关', human = 'human-admin-test', runtime = 'current-child-test', core = 'exact-core-test'
  let bindings: Map<string, Friend>
  const friend: Friend = { id: 'fufu', display_name: 'FuFu', permission: 'master', channel_identities: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-admin-')); bindings = new Map()
    deps = { isVoice: id => id === channel, admissionReady: () => true,
      verifyRuntime: async (_, token) => { if (token !== runtime) throw new RpcError('UNAUTHORIZED', 'Current child required') },
      verifyCore: async token => { if (token !== core) throw new RpcError('UNAUTHORIZED', 'Exact core required') },
      verifyHuman: async token => { if (token !== human) throw new RpcError('FORBIDDEN', 'Human Admin required') },
      getFriend: id => id === friend.id ? friend : undefined,
      resolveFriend: (_, id) => bindings.get(id),
      bindRegistration: async (_, r) => { bindings.set(r.registration_id, { ...friend, channel_identities: [{ channel_id: channel, platform_user_id: r.registration_id, platform_display_name: r.display_name }] }) },
      channelAction: vi.fn(async () => { throw new RpcError('SERVICE_UNAVAILABLE', 'Phone offline') }),
      publish: vi.fn(async () => {}), configurationChanged: vi.fn(async () => {}), testAudio: vi.fn(async () => ({ ok: true })), enrollmentModelId: 'campplus-test' }
    admin = new VoiceAdmin(dir, deps); await admin.load()
    server = http.createServer(async (req, res) => {
      await admin.handleWeb(req, res, new URL(req.url!, 'http://local').pathname, async () => {
        let body = ''; for await (const bytes of req) body += bytes; return JSON.parse(body)
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterEach(async () => { admin.stop(); vi.useRealTimers(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(dir, { recursive: true, force: true }) })
  async function request(route: string, method = 'GET', body?: unknown, token = human) {
    return fetch(url + route, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  }
  async function turn(): Promise<SubmitVoiceTurnParams> {
    const r = await admin.turns.enroll(channel, friend.id, 'FuFu', 'campplus-test'); await deps.bindRegistration(channel, r)
    const epoch = randomUUID(); const revision = admin.turns.registrations(channel).enrollment_revision
    await admin.sync({ channel_id: channel, connection_epoch: epoch, foreground: true, completed_enrollment: { registration_id: r.registration_id, model_id: r.model_id, enrollment_revision: revision } }, runtime)
    const id = randomUUID()
    return { channel_id: channel, session_id: voiceSessionId(channel), turn_id: id, connection_epoch: epoch, enrollment_revision: revision,
      messages: [{ platform_message_id: id + ':0', session: { channel_id: channel, session_id: voiceSessionId(channel), type: 'group' }, sender: { platform_user_id: r.registration_id, platform_display_name: r.display_name }, content: { type: 'text', text: '不要开灯' }, features: { is_mention_crab: true, voice: { turn_id: id, segment_index: 0, start_sample: 0, end_sample: 32000, anonymous_speaker: 'speaker-0' } }, platform_timestamp: new Date().toISOString() }] }
  }
  it('rejects Agent CLI/unauthenticated management and returns only redacted audio references', async () => {
    expect((await request('/api/audio-services', 'GET', undefined, 'agent-cli')).status).toBe(403)
    const provider = { name: 'local', kind: 'self_hosted', format: 'openai-audio', endpoint: 'http://localhost:9099', api_key: 'private-provider-marker', models: [{ model_id: 'audio', display_name: 'Audio', capabilities: ['asr', 'tts'], voice: 'test' }] }
    const created = await request('/api/audio-services', 'POST', provider)
    expect(created.status).toBe(201); const publicData = await created.json() as { provider: { id: string; has_api_key: boolean } }
    expect(publicData.provider.has_api_key).toBe(true); expect(JSON.stringify(publicData)).not.toContain(provider.api_key)
    expect(await (await request('/api/audio-services')).text()).not.toContain(provider.api_key)
    const config = { asr: { provider_id: publicData.provider.id, model_id: 'audio' }, tts: null, wake_word: '你好螃蟹' }
    expect((await request('/api/channels/' + channel + '/voice/config', 'PUT', config)).status).toBe(200)
    await expect(admin.getConfig({ channel_id: channel }, 'stale-child')).rejects.toThrow('Current child')
    const resolved = await admin.getConfig({ channel_id: channel }, runtime)
    expect(resolved.asr_connection?.api_key).toBe(provider.api_key)
    await expect(admin.getConfig({ channel_id: channel, friend_id: 'injected' }, runtime)).rejects.toThrow('Unknown')
    expect((await request('/api/channels/not-voice/voice/config')).status).toBe(400)
  })
  it('revokes backend admission before a disconnected phone can acknowledge vector deletion', async () => {
    await expect(admin.action(channel, { action: 'enroll', friend_id: friend.id, display_name: 'FuFu' }, human)).rejects.toThrow('offline')
    const registration = admin.turns.registrations(channel).registrations[0]
    expect(registration.status).toBe('pending'); expect(bindings.has(registration.registration_id)).toBe(true)
    await expect(admin.action(channel, { action: 'delete_registration', registration_id: registration.registration_id }, human)).rejects.toThrow('offline')
    expect(admin.turns.registrations(channel).registrations[0]).toMatchObject({ status: 'revoked', terminal_cleared: false })
    await expect(admin.sync({ channel_id: channel, connection_epoch: randomUUID(), foreground: true, completed_enrollment: { registration_id: registration.registration_id, model_id: registration.model_id, enrollment_revision: admin.turns.registrations(channel).enrollment_revision } }, runtime)).rejects.toThrow()
  })
  it('keeps the whole authorized turn after publish failure and retries it with its original digest', async () => {
    const params = await turn(); const digest = sha256CanonicalJson(params)
    deps.publish = vi.fn(async () => { throw new Error('Event hub temporarily unavailable') })
    await expect(admin.submit(params, runtime)).rejects.toThrow('unavailable')
    expect(await admin.status({ channel_id: channel, turn_id: params.turn_id, payload_sha256: digest }, runtime)).toMatchObject({ status: 'pending', payload_sha256: digest })
    await expect(admin.confirm({ channel_id: channel, turn_id: params.turn_id, payload_sha256: digest }, runtime)).rejects.toThrow('Exact core')
    const restored = new VoiceAdmin(dir, deps); await restored.load()
    deps.publish = vi.fn(async payload => { expect(payload.messages[0].message.content.text).toBe('不要开灯'); await restored.confirm({ channel_id: channel, turn_id: payload.turn_id, payload_sha256: payload.payload_sha256 }, core) })
    vi.useFakeTimers(); restored.start(); await vi.advanceTimersByTimeAsync(5000); restored.stop(); vi.useRealTimers()
    // Publication involves real disk I/O; wait for its atomic acknowledgement independently of virtual time.
    await vi.waitFor(() => expect(restored.turns.status(channel, params.turn_id, digest).status).toBe('accepted'))
    expect(deps.publish).toHaveBeenCalledTimes(1); expect(restored.turns.pending()).toEqual([])
  })
})
