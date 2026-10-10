import type { IncomingMessage, ServerResponse } from 'node:http'
import { RpcError, assertVoiceUuid, type AudioServiceCapability, type Friend, type GetVoiceConfigResult, type SubmitVoiceTurnParams, type SyncVoiceTerminalParams, type VoiceAdminAction, type VoiceAdminActionResult, type VoiceRegistration, type VoiceTurnAuthorizedPayload, type VoiceTurnResult } from 'crabot-shared'
import { AudioServiceRegistry } from './audio-service-registry.js'
import { VoiceTurnStore } from './voice-turn-store.js'

export interface VoiceAdminDeps {
  isVoice(channelId: string): boolean
  admissionReady(): boolean
  verifyRuntime(channelId: string, bearer?: string): Promise<void>
  verifyCore(bearer?: string): Promise<void>
  verifyHuman(bearer?: string): Promise<void>
  resolveFriend(channelId: string, registrationId: string): Friend | undefined
  getFriend(friendId: string): Friend | undefined
  bindRegistration(channelId: string, registration: VoiceRegistration): Promise<void>
  channelAction(channelId: string, command: VoiceAdminAction, bearer: string): Promise<VoiceAdminActionResult>
  publish(payload: VoiceTurnAuthorizedPayload): Promise<void>
  configurationChanged(): Promise<void>
  testAudio(channelId: string, capability: AudioServiceCapability): Promise<unknown>
  enrollmentModelId: string
}
function invalid(message: string): never { throw new RpcError('INVALID_PARAMS', message) }
function bodyObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('Expected object')
  return raw as Record<string, unknown>
}
function requireFields(v: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(v).some(k => !allowed.includes(k))) invalid('Unknown voice field')
}

export class VoiceAdmin {
  readonly audio: AudioServiceRegistry
  readonly turns: VoiceTurnStore
  private replayTimer?: ReturnType<typeof setInterval>
  private replaying = false
  constructor(dataDir: string, private readonly deps: VoiceAdminDeps) {
    this.audio = new AudioServiceRegistry(dataDir)
    this.turns = new VoiceTurnStore(dataDir)
  }
  async load(): Promise<void> { await this.audio.load(); await this.turns.load() }
  start(): void {
    if (!this.replayTimer) this.replayTimer = setInterval(() => { void this.replayPending() }, 5000)
  }
  stop(): void { if (this.replayTimer) clearInterval(this.replayTimer); this.replayTimer = undefined }
  private assertChannel(id: unknown): asserts id is string {
    if (typeof id !== 'string' || !this.deps.isVoice(id)) invalid('Voice instance required')
  }
  async getConfig(raw: unknown, bearer?: string): Promise<GetVoiceConfigResult> {
    const v = bodyObject(raw); requireFields(v, ['channel_id']); this.assertChannel(v.channel_id)
    const channelId = v.channel_id
    this.assertChannel(channelId); await this.deps.verifyRuntime(channelId, bearer)
    const config = this.audio.getConfig(channelId)
    return { config, ...this.turns.registrations(channelId), asr_connection: this.audio.resolve(config.asr, 'asr'), tts_connection: this.audio.resolve(config.tts, 'tts') }
  }
  async verifyHuman(raw: unknown, bearer?: string): Promise<{ verified: true }> {
    const v = bodyObject(raw); requireFields(v, ['channel_id']); this.assertChannel(v.channel_id)
    const channelId = v.channel_id
    this.assertChannel(channelId); await this.deps.verifyHuman(bearer); return { verified: true }
  }
  async sync(raw: unknown, bearer?: string): Promise<{ synced: true }> {
    const v = bodyObject(raw); requireFields(v, ['channel_id', 'connection_epoch', 'foreground', 'completed_enrollment', 'cleared_registration'])
    this.assertChannel(v.channel_id)
    await this.deps.verifyRuntime(v.channel_id, bearer)
    if (v.connection_epoch !== null) assertVoiceUuid(v.connection_epoch)
    if (typeof v.foreground !== 'boolean') invalid('Invalid foreground state')
    for (const field of ['completed_enrollment', 'cleared_registration']) if (v[field] !== undefined) {
      const ack = bodyObject(v[field]); requireFields(ack, field === 'completed_enrollment' ? ['registration_id', 'model_id', 'enrollment_revision'] : ['registration_id', 'enrollment_revision'])
      if (typeof ack.registration_id !== 'string' || !Number.isSafeInteger(ack.enrollment_revision) || (ack.enrollment_revision as number) < 0) invalid('Invalid registration acknowledgement')
      if (field === 'completed_enrollment') {
        if (typeof ack.model_id !== 'string') invalid('Invalid enrollment model')
        const registration = this.turns.registrations(v.channel_id).registrations.find(r => r.registration_id === ack.registration_id)
        if (!registration || this.deps.resolveFriend(v.channel_id, registration.registration_id)?.id !== registration.friend_id) invalid('Enrollment binding is unavailable')
      }
    }
    await this.turns.sync(v as unknown as SyncVoiceTerminalParams)
    return { synced: true }
  }
  async submit(raw: unknown, bearer?: string): Promise<VoiceTurnResult> {
    const v = bodyObject(raw); this.assertChannel(v.channel_id)
    await this.deps.verifyRuntime(v.channel_id, bearer)
    if (!this.deps.admissionReady()) throw new RpcError('SERVICE_UNAVAILABLE', 'Core Agent is not ready')
    const { result, payload } = await this.turns.submit(v as unknown as SubmitVoiceTurnParams, id => this.deps.resolveFriend(v.channel_id as string, id))
    if (payload) await this.deps.publish(payload)
    if (result.status !== 'pending') return result
    // Publishing is not acceptance. Core must first persist the whole batch and confirm it.
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      const status = this.turns.status(v.channel_id, v.turn_id as string, result.payload_sha256!)
      if (status.status !== 'pending') return status
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return this.turns.status(v.channel_id, v.turn_id as string, result.payload_sha256!)
  }
  async status(raw: unknown, bearer?: string): Promise<VoiceTurnResult> {
    const v = this.statusParams(raw); await this.deps.verifyRuntime(v.channel_id, bearer)
    return this.turns.status(v.channel_id, v.turn_id, v.payload_sha256)
  }
  async confirm(raw: unknown, bearer?: string): Promise<VoiceTurnResult> {
    const v = this.statusParams(raw); await this.deps.verifyCore(bearer)
    return this.turns.confirm(v.channel_id, v.turn_id, v.payload_sha256)
  }
  private statusParams(raw: unknown): { channel_id: string; turn_id: string; payload_sha256: string } {
    const v = bodyObject(raw); requireFields(v, ['channel_id', 'turn_id', 'payload_sha256']); this.assertChannel(v.channel_id); assertVoiceUuid(v.turn_id)
    if (typeof v.payload_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.payload_sha256)) invalid('Invalid voice payload digest')
    return v as { channel_id: string; turn_id: string; payload_sha256: string }
  }
  async replayPending(): Promise<void> {
    if (!this.deps.admissionReady() || this.replaying) return
    this.replaying = true
    try {
      for (const payload of this.turns.pending()) {
        try { await this.deps.publish(payload) }
        catch { console.warn('[Admin] Voice batch remains pending; publication will retry') }
      }
    } finally { this.replaying = false }
  }
  async action(channelId: string, raw: unknown, bearer: string): Promise<VoiceAdminActionResult> {
    this.assertChannel(channelId); await this.deps.verifyHuman(bearer)
    const v = bodyObject(raw)
    switch (v.action) {
      case 'status': case 'revoke_terminal': requireFields(v, ['action']); break
      case 'create_pairing': requireFields(v, ['action', 'host']); if (typeof v.host !== 'string' || !v.host.trim() || v.host.length > 256) invalid('Invalid pairing host'); break
      case 'confirm_pairing': requireFields(v, ['action', 'pairing_id']); assertVoiceUuid(v.pairing_id); break
      case 'enroll': {
        requireFields(v, ['action', 'friend_id', 'display_name'])
        if (typeof v.friend_id !== 'string' || typeof v.display_name !== 'string' || !v.display_name.trim() || v.display_name.length > 128) invalid('Invalid enrollment request')
        if (!this.deps.getFriend(v.friend_id)) invalid('Friend not found')
        const pending = this.turns.registrations(channelId).registrations.find(r => r.status === 'pending' && r.friend_id === v.friend_id)
        const registration = pending ?? await this.turns.enroll(channelId, v.friend_id, v.display_name.trim(), this.deps.enrollmentModelId)
        await this.deps.bindRegistration(channelId, registration)
        break
      }
      case 'delete_registration':
        requireFields(v, ['action', 'registration_id']); assertVoiceUuid(v.registration_id)
        await this.turns.revoke(channelId, v.registration_id); break
      default: invalid('Unknown voice management action')
    }
    return this.deps.channelAction(channelId, v as unknown as VoiceAdminAction, bearer)
  }
  /** Human REST only. Internal runtime endpoints are never exported on this web surface. */
  async handleWeb(req: IncomingMessage, res: ServerResponse, pathname: string, readBody: () => Promise<unknown>): Promise<boolean> {
    if (!pathname.startsWith('/api/audio-services') && !/^\/api\/channels\/[^/]+\/voice\//.test(pathname)) return false
    const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined
    const json = (status: number, data: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
    try {
      await this.deps.verifyHuman(bearer)
      const service = pathname.match(/^\/api\/audio-services(?:\/([^/]+))?$/)
      if (service) {
        const id = service[1] ? decodeURIComponent(service[1]) : undefined
        if (!id && req.method === 'GET') json(200, { items: this.audio.list() })
        else if (!id && req.method === 'POST') { const provider = await this.audio.saveProvider(await readBody()); await this.deps.configurationChanged(); json(201, { provider }) }
        else if (id && req.method === 'PUT') { const provider = await this.audio.saveProvider(await readBody(), id); await this.deps.configurationChanged(); json(200, { provider }) }
        else if (id && req.method === 'DELETE') { await this.audio.removeProvider(id); json(200, { deleted: true }) }
        else json(405, { error: 'Method not allowed' })
        return true
      }
      const route = pathname.match(/^\/api\/channels\/([^/]+)\/voice\/(config|action|test)$/)
      if (!route) { json(404, { error: 'Not found' }); return true }
      const channelId = decodeURIComponent(route[1]); this.assertChannel(channelId)
      if (route[2] === 'config' && req.method === 'GET') json(200, this.audio.getConfig(channelId))
      else if (route[2] === 'config' && req.method === 'PUT') { const config = await this.audio.saveConfig(channelId, await readBody()); await this.deps.configurationChanged(); json(200, config) }
      else if (route[2] === 'action' && req.method === 'POST') json(200, await this.action(channelId, await readBody(), bearer!))
      else if (route[2] === 'test' && req.method === 'POST') {
        const v = bodyObject(await readBody()); requireFields(v, ['capability'])
        if (v.capability !== 'asr' && v.capability !== 'tts') invalid('Invalid audio test capability')
        json(200, await this.deps.testAudio(channelId, v.capability))
      } else json(405, { error: 'Method not allowed' })
    } catch (error) {
      if (!res.writableEnded) {
        const code = (error as { code?: string }).code
        json(code === 'UNAUTHORIZED' ? 401 : code === 'FORBIDDEN' ? 403 : code === 'SERVICE_UNAVAILABLE' ? 503 : 400, { error: error instanceof Error ? error.message : 'Voice request failed' })
      }
    }
    return true
  }
}
