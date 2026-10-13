import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { RpcError, sha256CanonicalJson, voiceSessionId, type Friend, type SubmitVoiceTurnParams } from 'crabot-shared'
import { VoiceAdmin, type VoiceAdminDeps } from './voice-admin.js'

describe('Voice Admin human surface and durable publication responsibility', () => {
  let dir: string, admin: VoiceAdmin, server: http.Server, url: string, deps: VoiceAdminDeps
  const channel = '玄关', human = 'human-admin-test', runtime = 'current-child-test', core = 'exact-core-test'
  let bindings: Map<string, Friend>
  const friend: Friend = { id: 'fufu', display_name: 'FuFu', permission: 'master', channel_identities: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-admin-')); bindings = new Map()
    deps = { isVoice: id => id === channel, instance: id => ({ id, implementation_id: 'channel-voice', auto_start: false } as never), createInstance: vi.fn(), resumeInstance: vi.fn(), pauseInstance: vi.fn(), saveSetup: vi.fn(), fingerprint: () => undefined, terminalHosts: () => [], closeGateway: vi.fn(), admissionReady: () => true,
      verifyRuntime: async (_, token) => { if (token !== runtime) throw new RpcError('UNAUTHORIZED', 'Current child required') },
      verifyCore: async token => { if (token !== core) throw new RpcError('UNAUTHORIZED', 'Exact core required') },
      verifyHuman: async token => { if (token !== human) throw new RpcError('FORBIDDEN', 'Human Admin required') },
      checkGroup: async () => true,
      resolveFriend: (_, id) => bindings.get(id),
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
  it('voice output identity requires exact current core and a real voice instance', async () => {
    expect(await admin.verifyAgent({ channel_id: channel }, core)).toEqual({ verified: true })
    for (const token of [runtime, human, undefined]) await expect(admin.verifyAgent({ channel_id: channel }, token)).rejects.toThrow('Exact core')
    await expect(admin.verifyAgent({ channel_id: 'not-voice' }, core)).rejects.toThrow('Voice instance')
    await expect(admin.verifyAgent({ channel_id: channel, source: 'crabot-agent' }, core)).rejects.toThrow('Unknown')
  })
  async function turn(): Promise<SubmitVoiceTurnParams> {
    const contact = await admin.turns.createContact(channel, 'FuFu')
    const r = await admin.turns.enroll(channel, contact.platform_user_id, 'campplus-test')
    bindings.set(contact.platform_user_id, { ...friend, channel_identities: [{ channel_id: channel, platform_user_id: contact.platform_user_id, platform_display_name: 'FuFu' }] })
    const epoch = randomUUID(); const revision = admin.turns.registrations(channel).enrollment_revision
    await admin.sync({ channel_id: channel, connection_epoch: epoch, foreground: true, completed_enrollment: { registration_id: r.registration_id, model_id: r.model_id, enrollment_revision: revision } }, runtime)
    const id = randomUUID()
    return { channel_id: channel, session_id: voiceSessionId(channel), turn_id: id, connection_epoch: epoch, enrollment_revision: revision,
      messages: [{ platform_message_id: id + ':0', session: { channel_id: channel, session_id: voiceSessionId(channel), type: 'group' }, sender: { platform_user_id: r.platform_user_id, platform_display_name: r.display_name }, content: { type: 'text', text: '不要开灯' }, features: { is_mention_crab: true, voice: { turn_id: id, segment_index: 0, start_sample: 0, end_sample: 32000, anonymous_speaker: 'speaker-0', identity_status: 'matched', registration_id: r.registration_id } }, platform_timestamp: new Date().toISOString() }] }
  }
  it('blocks a draft before durable admission even when the runtime is authenticated', async () => {
    const params = await turn()
    deps.instance = id => ({ id, implementation_id: 'channel-voice', auto_start: false, voice_setup: { status: 'draft' } } as never)
    await expect(admin.submit(params, runtime)).rejects.toThrow('向导')
    expect(admin.turns.pending()).toHaveLength(0); expect(deps.publish).not.toHaveBeenCalled()
  })
  it('returns a same-name draft without overwriting its service config', async () => {
    deps.instance = id => ({ id, implementation_id: 'channel-voice', auto_start: false, voice_setup: { status: 'draft' } } as never)
    const response = await request('/api/channels/voice/setup', 'POST', { name: channel, config: { asr: null, tts: null, wake_word: '别覆盖' } })
    expect(response.status).toBe(201); expect(deps.createInstance).not.toHaveBeenCalled()
    expect(admin.audio.getConfig(channel).wake_word).toBe('你好螃蟹')
  })
  it('finishes only after real foreground state, ordinary group checks and fixed service tests; retries are idempotent', async () => {
    let instance = { id: channel, implementation_id: 'channel-voice', auto_start: false, voice_setup: { status: 'draft', connection: { base_url: 'http://phone.test:3000', transport: 'ws' } } } as any
    deps.instance = () => instance
    deps.saveSetup = vi.fn(async (_, setup, auto_start) => { instance = { ...instance, voice_setup: setup, auto_start }; return instance })
    const provider = await admin.audio.saveProvider({ name: 'fixed-test-service', format: 'openai-audio', endpoint: 'http://test-service:9000', models: [{ model_id: 'audio', display_name: 'Audio', capabilities: ['asr', 'tts'], voice: 'test' }] })
    const ref = { provider_id: provider.id, model_id: 'audio' }
    await admin.audio.saveConfig(channel, { asr: ref, tts: ref, wake_word: '你好螃蟹' })
    const epoch = randomUUID(); await admin.sync({ channel_id: channel, connection_epoch: epoch, foreground: true }, runtime)
    deps.channelAction = vi.fn(async () => ({ action: 'status', state: { paired: true, connected: true, foreground: true, microphone: 'closed', playback: 'idle' } } as never))
    deps.testAudio = vi.fn(async (_, cap) => {
      if (cap === 'asr') await admin.sync({ channel_id: channel, connection_epoch: null, foreground: false }, runtime)
      return { ok: true }
    })
    expect((await request('/api/channels/' + channel + '/voice/setup/finish', 'POST', {})).status).toBe(400)
    expect(deps.saveSetup).not.toHaveBeenCalled(); expect(instance.voice_setup.status).toBe('draft')
    await admin.sync({ channel_id: channel, connection_epoch: epoch, foreground: true }, runtime)
    deps.testAudio = vi.fn(async () => ({ ok: true }))
    expect((await request('/api/channels/' + channel + '/voice/setup/finish', 'POST', {})).status).toBe(200)
    expect(instance).toMatchObject({ auto_start: true, voice_setup: { status: 'complete' } }); expect(deps.testAudio).toHaveBeenCalledTimes(2)
    expect((await request('/api/channels/' + channel + '/voice/setup/finish', 'POST', {})).status).toBe(200)
    expect(deps.saveSetup).toHaveBeenCalledTimes(1); expect(deps.testAudio).toHaveBeenCalledTimes(2)
  })
  it('rejects Agent CLI/unauthenticated management and returns only redacted audio references', async () => {
    expect((await request('/api/audio-services', 'GET', undefined, 'agent-cli')).status).toBe(403)
    const provider = { name: 'local', format: 'openai-audio', endpoint: 'http://localhost:9099', api_key: 'private-provider-marker', models: [{ model_id: 'audio', display_name: 'Audio', capabilities: ['asr', 'tts'], voice: 'test' }] }
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
    const contact = await admin.turns.createContact(channel, 'FuFu')
    await expect(admin.action(channel, { action: 'enroll', platform_user_id: contact.platform_user_id }, human)).rejects.toThrow('offline')
    const registration = admin.turns.registrations(channel).registrations[0]
    expect(registration.status).toBe('pending'); expect(bindings.size).toBe(0)
    await expect(admin.action(channel, { action: 'delete_registration', registration_id: registration.registration_id }, human)).rejects.toThrow('offline')
    expect(admin.turns.registrations(channel).registrations[0]).toMatchObject({ status: 'revoked', terminal_cleared: false })
    await expect(admin.sync({ channel_id: channel, connection_epoch: randomUUID(), foreground: true, completed_enrollment: { registration_id: registration.registration_id, model_id: registration.model_id, enrollment_revision: admin.turns.registrations(channel).enrollment_revision } }, runtime)).rejects.toThrow()
  })
  it('allows Admin-only contact creation offline and projects current binding without storing it', async () => {
    const created = await admin.action(channel, { action: 'create_contact', display_name: 'FuFu' }, human)
    expect(created.action).toBe('create_contact')
    if (created.action !== 'create_contact') throw new Error('unexpected result')
    expect(deps.channelAction).not.toHaveBeenCalled()
    const id = created.contact.platform_user_id
    expect((await admin.getConfig({ channel_id: channel }, runtime)).contacts[0]).not.toHaveProperty('friend_id')
    bindings.set(id, { ...friend, channel_identities: [{ channel_id: channel, platform_user_id: id }] })
    expect((await admin.getConfig({ channel_id: channel }, runtime)).contacts[0].friend_id).toBe(friend.id)
    bindings.delete(id)
    expect((await admin.getConfig({ channel_id: channel }, runtime)).contacts[0]).not.toHaveProperty('friend_id')
  })
  it('reads durable authorization only for exact core, including after confirmation', async () => {
    const params = await turn(); await admin.turns.submit(params, id => bindings.get(id), async () => true)
    const locator = { channel_id: channel, turn_id: params.turn_id, payload_sha256: sha256CanonicalJson(params) }
    await expect(admin.authorized(locator, runtime)).rejects.toThrow('Exact core')
    expect((await admin.authorized(locator, core)).messages[0].friend?.id).toBe(friend.id)
    await admin.confirm(locator, core)
    expect((await admin.authorized(locator, core)).messages[0].message.content.text).toBe('不要开灯')
    await expect(admin.authorized({ ...locator, payload_sha256: 'f'.repeat(64) }, core)).rejects.toThrow()
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
