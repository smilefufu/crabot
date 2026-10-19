import { expect, it, vi } from 'vitest'
import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { RpcClient, RpcError, VOICE_MODEL_VERSIONS, createSuccessResponse, createErrorResponse, type Friend, type VoiceOwnerActivation } from 'crabot-shared'
import { VoiceAdmin } from '../../crabot-admin/src/voice-admin.js'
import { VoiceChannel } from './voice-channel.js'

it('initial human pairing through real RPC/WS requires phone save before one durable Master/contact becomes usable', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-owner-ws-'))
  const channelId = 'owner-ws', human = 'fixture-human', runtime = 'fixture-child', rpc = new RpcClient()
  const friends = new Map<string, Friend>(), sockets: WebSocket[] = []
  let channel: VoiceChannel | undefined, channelPort = 0, admin!: VoiceAdmin
  const verify = (actual: string | undefined, expected: string) => { if (actual !== expected) throw new RpcError('FORBIDDEN', 'Wrong fixture identity') }
  const server = http.createServer(async (req, res) => {
    let data = ''; for await (const chunk of req) data += chunk
    const request = JSON.parse(data), bearer = req.headers.authorization?.replace(/^Bearer /, '')
    try {
      let result: unknown
      switch (request.method) {
        case 'get_voice_config': result = await admin.getConfig(request.params, bearer); break
        case 'verify_voice_admin': result = await admin.verifyHuman(request.params, bearer); break
        case 'sync_voice_terminal': result = await admin.sync(request.params, bearer); break
        default: throw new Error('Unexpected owner fixture RPC')
      }
      res.end(JSON.stringify(createSuccessResponse(request.id, result)))
    } catch (error) { res.end(JSON.stringify(createErrorResponse(request.id, 'FORBIDDEN', (error as Error).message))) }
  })
  async function phone(hello: Record<string, unknown>) {
    const socket = new WebSocket(`ws://127.0.0.1:${channelPort}/voice`), controls: any[] = []
    sockets.push(socket)
    socket.on('message', (raw, binary) => { expect(binary).toBe(false); controls.push(JSON.parse(raw.toString())) })
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
    socket.send(JSON.stringify(hello))
    return { socket, controls, wait: async (type: string) => {
      await vi.waitFor(() => expect(controls.find(value => value.type === type)).toBeDefined(), { timeout: 3000, interval: 10 })
      return controls.find(value => value.type === type)
    } }
  }
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const adminPort = (server.address() as AddressInfo).port
    const reserve = net.createServer(); await new Promise<void>(resolve => reserve.listen(0, '127.0.0.1', resolve)); channelPort = (reserve.address() as AddressInfo).port
    await new Promise<void>(resolve => reserve.close(() => resolve()))
    const instance: any = { id: channelId, implementation_id: 'channel-voice', auto_start: false, voice_setup: { status: 'draft', owner_activation_required: true, connection: { base_url: `http://127.0.0.1:${adminPort}`, transport: 'ws' } } }
    admin = new VoiceAdmin(directory, {
      isVoice: id => id === channelId, instance: () => instance, createInstance: async () => instance, resumeInstance: async () => instance, pauseInstance: async () => instance, saveSetup: async () => instance,
      fingerprint: () => undefined, terminalHosts: () => [], closeGateway: () => {}, admissionReady: () => true, ownerReady: () => true,
      friends: () => [...friends.values()], persistFriend: async friend => { friends.set(friend.id, structuredClone(friend)); await fs.writeFile(path.join(directory, 'friends-fixture.json'), JSON.stringify([...friends.values()])) },
      verifyRuntime: async (_, bearer) => verify(bearer, runtime), verifyHuman: async bearer => verify(bearer, human), verifyCore: async () => { throw new Error('No core in this fixture') },
      resolveFriend: (id, contact) => [...friends.values()].find(friend => friend.channel_identities.some(identity => identity.channel_id === id && identity.platform_user_id === contact)), checkGroup: async () => true,
      channelAction: (id, command, bearer, activation) => rpc.callSensitive(channelPort, 'voice_admin_action', { channel_id: id, command, ...(activation ? { owner_activation: activation } : {}) }, 'fixture-admin', { authorizationBearer: bearer }),
      publish: async () => { throw new Error('No business input in activation fixture') }, configurationChanged: async () => {}, testAudio: async () => { throw new Error('No audio provider in activation fixture') }, enrollmentModelId: VOICE_MODEL_VERSIONS.embedding,
    })
    await admin.load()
    channel = new VoiceChannel({ moduleId: channelId, moduleType: 'channel', version: '0.1.0', protocolVersion: '0.9.0', port: channelPort }, path.join(directory, 'terminal'), runtime)
    const client = (channel as unknown as { rpcClient: RpcClient }).rpcClient
    client.resolve = async () => [{ port: adminPort }] as never
    await channel.start()
    const created = await admin.action(channelId, { action: 'create_pairing' }, human)
    if (created.action !== 'create_pairing') throw new Error('No QR')
    const owner = { profile_id: randomUUID(), display_name: 'Owner fixture', model_id: VOICE_MODEL_VERSIONS.embedding }
    const pair = await phone({ type: 'pair', protocol_version: 9, nonce: created.pairing.nonce, owner })
    const waiting = await pair.wait('pair_waiting')
    expect(waiting.verification_code).toBe(created.pairing.verification_code)
    await admin.action(channelId, { action: 'confirm_pairing', pairing_id: waiting.pairing_id }, human)
    const paired = await pair.wait('paired'), activation = paired.owner_activation as VoiceOwnerActivation
    expect(activation.status).toBe('pending'); expect(friends.size).toBe(0)
    expect((await admin.getConfig({ channel_id: channelId }, runtime)).contacts).toEqual([])
    const live = await phone({ type: 'hello', protocol_version: 9, credential: paired.credential, models: VOICE_MODEL_VERSIONS, aec_verified: false, owner })
    expect((await live.wait('hello')).setup_status).toBe('draft')
    live.socket.send(JSON.stringify({ type: 'heartbeat', foreground: true, microphone: 'closed', playback: 'idle', enrollment_revision: 0, speech_enabled: false, activity: 'idle' }))
    // Phone persistence is simulated here; actual Keystore save-before-ack is covered by Android isolated storage tests.
    live.socket.send(JSON.stringify({ type: 'owner_saved', saved: { operation_id: activation.operation_id, profile_id: owner.profile_id, registration_id: activation.registration_id, model_id: owner.model_id } }))
    const completed = await live.wait('owner_activation')
    expect(completed.activation).toEqual({ ...activation, status: 'completed' })
    expect(friends.size).toBe(1)
    const config = await admin.getConfig({ channel_id: channelId }, runtime)
    const persisted = JSON.parse(await fs.readFile(path.join(directory, 'friends-fixture.json'), 'utf8'))
    expect(config.contacts[0]).toMatchObject({ platform_user_id: activation.platform_user_id, friend_id: persisted[0].id })
    expect(persisted[0].permission).toBe('master')
    const status = await admin.action(channelId, { action: 'status' }, human)
    expect(status).toMatchObject({ action: 'status', state: { paired: true, owner_activation: { status: 'completed' }, microphone: 'closed' } })
    expect(JSON.stringify(config)).not.toContain(paired.credential)
    expect(live.controls.some(value => value.type === 'playback_start')).toBe(false)
    instance.voice_setup.status = 'complete'
    live.socket.send(JSON.stringify({ type: 'heartbeat', foreground: true, microphone: 'closed', playback: 'idle', enrollment_revision: config.enrollment_revision, speech_enabled: false, activity: 'idle' }))
    expect((await live.wait('setup_status')).status).toBe('complete')
  } finally {
    for (const socket of sockets) socket.terminate()
    await channel?.stop(); admin?.stop(); server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await fs.rm(directory, { recursive: true, force: true })
  }
})
