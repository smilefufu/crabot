import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import { RpcClient, createSuccessResponse, createErrorResponse, encodeVoiceFrame, pcm16Wave, VOICE_MODEL_VERSIONS, voiceSessionId, type Friend, type VoiceReplyContext, type VoiceServerControl, type VoiceTurnAuthorizedPayload } from 'crabot-shared'
import { VoiceTurnStore } from '../../crabot-admin/src/voice-turn-store.js'
import { VoiceInbox } from '../../crabot-agent/src/manager/voice-inbox.js'
import { VoiceChannel } from './voice-channel.js'

class Phone {
  readonly controls: VoiceServerControl[] = []
  readonly frames: Buffer[] = []
  constructor(readonly socket: WebSocket) { socket.on('message', (raw, binary) => { if (binary) this.frames.push(Buffer.from(raw as Buffer)); else this.controls.push(JSON.parse(raw.toString())) }) }
  send(control: unknown) { this.socket.send(JSON.stringify(control)) }
  async wait<T extends VoiceServerControl['type']>(type: T): Promise<Extract<VoiceServerControl, { type: T }>> {
    let result: VoiceServerControl | undefined
    await vi.waitFor(() => { result = this.controls.find(c => c.type === type); expect(result).toBeDefined() }, { timeout: 4000, interval: 5 })
    this.controls.splice(this.controls.indexOf(result!), 1)
    return result as Extract<VoiceServerControl, { type: T }>
  }
}
describe('Voice Channel with real WSS, service adapters and durable Admin/core stores', () => {
  let dir: string, channel: VoiceChannel, admin: http.Server, asr: WebSocketServer, port: number
  let store: VoiceTurnStore, inbox: VoiceInbox, registrations: string[], friends: Map<string, Friend>
  let accepted: VoiceTurnAuthorizedPayload[], asrCalls: number, ttsCalls: number, phones: Phone[]
  const channelId = '客厅'
  const rpc = new RpcClient(), runtime = 'isolated-voice-runtime', human = 'isolated-human-admin'
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-channel-')); phones = []; accepted = []; asrCalls = 0; ttsCalls = 0
    store = new VoiceTurnStore(dir); await store.load(); inbox = new VoiceInbox(path.join(dir, 'core-inbox')); inbox.load(); friends = new Map(); registrations = []
    for (const name of ['A', 'B']) {
      const r = await store.enroll(channelId, name, name, VOICE_MODEL_VERSIONS.embedding); registrations.push(r.registration_id)
      await store.sync({ channel_id: channelId, connection_epoch: null, foreground: false, completed_enrollment: { registration_id: r.registration_id, model_id: r.model_id, enrollment_revision: store.registrations(channelId).enrollment_revision } })
      friends.set(r.registration_id, { id: name, display_name: name, permission: name === 'A' ? 'master' : 'normal', channel_identities: [{ channel_id: channelId, platform_user_id: r.registration_id, platform_display_name: name }], created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    }
    admin = http.createServer(async (req, res) => {
      let body = ''; for await (const data of req) body += data
      if (req.url === '/v1/audio/speech') {
        ttsCalls++; const request = JSON.parse(body)
        expect(request).toMatchObject({ lang_code: 'z', stream: false, response_format: 'wav' })
        const pcm = Buffer.alloc(960); for (let i = 0; i < 480; i++) pcm.writeInt16LE(i % 32 * 400, i * 2)
        res.end(pcm16Wave(pcm, 24000)); return
      }
      const request = JSON.parse(body), bearer = req.headers.authorization
      try {
        if (bearer !== `Bearer ${request.method === 'verify_voice_admin' ? human : runtime}`) throw new Error('invalid runtime/human bearer')
        let result: unknown
        switch (request.method) {
          case 'get_voice_config': result = { config: { asr: { provider_id: 'local', model_id: 'sensevoice' }, tts: { provider_id: 'local', model_id: 'kokoro' }, wake_word: '你好螃蟹' }, ...store.registrations(channelId),
            asr_connection: { provider_id: 'local', kind: 'self_hosted', format: 'sherpa-offline-ws', endpoint: `ws://localhost:${(admin.address() as AddressInfo).port}/asr`, model_id: 'sensevoice', api_key: 'provider-secret' },
            tts_connection: { provider_id: 'local', kind: 'self_hosted', format: 'mlx-audio-http', endpoint: `http://localhost:${(admin.address() as AddressInfo).port}`, model_id: 'kokoro', voice: 'zf_xiaobei', api_key: 'provider-secret' } }; break
          case 'verify_voice_admin': result = { verified: true }; break
          case 'sync_voice_terminal': await store.sync(request.params); result = { synced: true }; break
          case 'get_voice_turn_status': result = store.status(request.params.channel_id, request.params.turn_id, request.params.payload_sha256); break
          case 'submit_voice_turn': {
            const submission = await store.submit(request.params, id => friends.get(id))
            if (submission.payload) { const record = inbox.accept(submission.payload); result = await store.confirm(channelId, record.turn_id, record.payload_sha256); inbox.confirm(record); accepted.push(submission.payload) }
            else result = submission.result
            break
          }
          default: throw new Error('unexpected test RPC')
        }
        res.end(JSON.stringify(createSuccessResponse(request.id, result)))
      } catch { res.end(JSON.stringify(createErrorResponse(request.id, 'FORBIDDEN', 'isolated request rejected'))) }
    })
    asr = new WebSocketServer({ server: admin, path: '/asr' })
    asr.on('connection', socket => {
      let length: number | undefined, received = 0
      socket.on('message', (data, binary) => {
        if (!binary) { socket.close(); return }
        const bytes = Buffer.from(data as Buffer)
        if (length === undefined) { expect(bytes.readInt32LE(0)).toBe(16000); length = bytes.readInt32LE(4) }
        else { received += bytes.length; if (received === length) { socket.send(['开灯', '别开灯', '好的'][asrCalls++ % 3]) } }
      })
    })
    await new Promise<void>(resolve => admin.listen(0, resolve))
    const reserve = net.createServer(); await new Promise<void>(resolve => reserve.listen(0, resolve)); port = (reserve.address() as AddressInfo).port; await new Promise<void>(resolve => reserve.close(() => resolve()))
    channel = new VoiceChannel({ moduleId: channelId, moduleType: 'channel', version: '0.1.0', protocolVersion: '0.2.0', port }, path.join(dir, 'terminal'), runtime)
    // Resolve only the isolated test Admin. All HTTP RPCs and terminal frames remain real.
    const client = (channel as unknown as { rpcClient: RpcClient }).rpcClient
    client.resolve = async () => [{ port: (admin.address() as AddressInfo).port }] as never
    await channel.start()
  })
  afterEach(async () => {
    for (const phone of phones) phone.socket.terminate()
    await channel?.stop(); for (const socket of asr?.clients ?? []) socket.terminate(); asr?.close()
    admin?.closeAllConnections(); await new Promise<void>(resolve => admin ? admin.close(() => resolve()) : resolve())
    await fs.rm(dir, { recursive: true, force: true })
  })
  async function connect() {
    const socket = new WebSocket(`wss://localhost:${port}/voice`, { rejectUnauthorized: false }); const phone = new Phone(socket); phones.push(phone)
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) }); return phone
  }
  async function pair() {
    const pairing = await rpc.callSensitive<any, any>(port, 'voice_admin_action', { channel_id: channelId, command: { action: 'create_pairing', host: 'localhost' } }, 'isolated-admin', { authorizationBearer: human })
    const phone = await connect(); phone.send({ type: 'pair', protocol_version: 1, nonce: pairing.pairing.nonce })
    const waiting = await phone.wait('pair_waiting'); expect(waiting.verification_code).toBe(pairing.pairing.verification_code)
    await rpc.callSensitive(port, 'voice_admin_action', { channel_id: channelId, command: { action: 'confirm_pairing', pairing_id: waiting.pairing_id } }, 'isolated-admin', { authorizationBearer: human })
    const credential = (await phone.wait('paired')).credential, live = await connect()
    live.send({ type: 'hello', protocol_version: 1, credential, models: { embedding: VOICE_MODEL_VERSIONS.embedding, segmentation: VOICE_MODEL_VERSIONS.segmentation }, aec_verified: true })
    const hello = await live.wait('hello'); expect(JSON.stringify(hello)).not.toContain('provider-secret')
    live.send({ type: 'heartbeat', foreground: true, microphone: 'closed', playback: 'idle' })
    return { phone: live, hello }
  }
  async function turn(phone: Phone, unknown = false) {
    const id = randomUUID(); phone.send({ type: 'turn_start', turn_id: id }); await phone.wait('turn_ready')
    const pcm = Buffer.alloc(320 * 9 * 2, 1)
    for (let i = 0; i < 9; i++) phone.socket.send(encodeVoiceFrame(1, id, i, pcm.subarray(i * 640, (i + 1) * 640)))
    phone.send({ type: 'turn_end', turn_id: id, audio_sample_count: 2880, sample_rate: 16000, models: VOICE_MODEL_VERSIONS, enrollment_revision: store.registrations(channelId).enrollment_revision,
      segments: [0, 1, 0].map((speaker, index) => ({ segment_index: index, start_sample: index * 960, end_sample: (index + 1) * 960, anonymous_speaker: String(speaker), identity_status: unknown && index === 1 ? 'unknown' : 'matched', ...(unknown && index === 1 ? {} : { registration_id: registrations[speaker] }) })) })
    return phone.wait('turn_status')
  }
  it('requires matching human confirmation, admits A B A atomically and keeps Provider credentials off the terminal', async () => {
    await expect(rpc.callSensitive(port, 'voice_admin_action', { channel_id: channelId, command: { action: 'create_pairing', host: 'localhost' } }, 'agent-cli', { authorizationBearer: runtime })).rejects.toThrow()
    const { phone } = await pair(), status = await turn(phone)
    expect(status.status).toBe('accepted'); expect(asrCalls).toBe(3); expect(accepted).toHaveLength(1)
    expect(accepted[0].messages.map(m => [m.friend.id, m.message.content.text, m.message.session.type])).toEqual([['A', '开灯', 'group'], ['B', '别开灯', 'group'], ['A', '好的', 'group']])
    expect(inbox.pending()[0].payload?.messages).toHaveLength(3)
  })
  it('unknown B rejects the complete turn without transcribing or executing A alone', async () => {
    const { phone } = await pair()
    expect((await turn(phone, true)).status).toBe('rejected'); expect(asrCalls).toBe(0); expect(accepted).toEqual([]); expect(inbox.pending()).toEqual([])
  })
  it('returns delivery success only after started, all audio and completed; an interrupted second attempt never replays', async () => {
    const { phone, hello } = await pair(), status = await turn(phone)
    const context: VoiceReplyContext = { channel_id: channelId, session_id: voiceSessionId(channelId), turn_id: status.turn_id, connection_epoch: hello.connection_epoch, expires_at: new Date(Date.now() + 50000).toISOString() }
    const send = () => rpc.call(port, 'send_message', { session_id: context.session_id, content: { type: 'text', text: '收到' }, voice_reply_context: context }, 'isolated-core', undefined, { timeoutMs: 30000 })
    let settled = false; const first = send().then(result => { settled = true; return result })
    const start = await phone.wait('playback_start'); await vi.waitFor(() => expect(phone.frames.length).toBeGreaterThan(0)); phone.send({ type: 'playback', playback_id: start.playback_id, status: 'started' })
    await phone.wait('playback_end'); expect(settled).toBe(false)
    phone.send({ type: 'playback', playback_id: start.playback_id, status: 'completed' }); expect(await first).toMatchObject({ platform_message_id: start.playback_id })
    const second = send(); void second.catch(() => {}); const playing = await phone.wait('playback_start')
    phone.send({ type: 'playback', playback_id: playing.playback_id, status: 'interrupted' }); await expect(second).rejects.toThrow()
    expect(ttsCalls).toBe(2)
    phone.send({ type: 'cancel' }); await new Promise(resolve => setTimeout(resolve, 10)); await expect(send()).rejects.toThrow(); expect(ttsCalls).toBe(2)
  })
})
