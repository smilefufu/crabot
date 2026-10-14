import { createHash } from 'node:crypto'
import type { SubmitVoiceTurnParams, VoiceClientControl, VoiceSegment, VoiceManagementRequest } from './voice.js'

export const VOICE_MAX_SAMPLES = 240000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export class VoiceProtocolVersionError extends Error {
  constructor() { super('语音协议版本不兼容，需要 protocol_version=5；请更新手机，保留配对和声纹') }
}
function version(value: unknown): void { if (value !== 5) throw new VoiceProtocolVersionError() }

function invalid(): never { throw new Error('Invalid voice protocol payload') }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
function fields(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(key => value[key] === undefined) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid()
}
function string(value: unknown, max = 256): void {
  if (typeof value !== 'string' || !value.length || value.length > max) invalid()
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) invalid()
}
function oneOf(value: unknown, choices: unknown[]): void { if (!choices.includes(value)) invalid() }
export function assertVoiceUuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID.test(value)) invalid()
}
export function validateVoiceManagementRequest(value: unknown): asserts value is VoiceManagementRequest {
  const request = object(value)
  fields(request, ['request_id', 'expected_revision', 'command'])
  assertVoiceUuid(request.request_id); integer(request.expected_revision)
  const command = object(request.command)
  switch (command.action) {
    case 'enroll_new': fields(command, ['action', 'display_name']); break
    case 'enroll': fields(command, ['action', 'platform_user_id']); assertVoiceUuid(command.platform_user_id); break
    case 'rename_contact': fields(command, ['action', 'platform_user_id', 'display_name']); assertVoiceUuid(command.platform_user_id); break
    case 'delete_registration': case 'cancel_enrollment': fields(command, ['action', 'registration_id']); assertVoiceUuid(command.registration_id); break
    default: invalid()
  }
  if ('display_name' in command) { string(command.display_name, 128); if (!(command.display_name as string).trim()) invalid() }
}
function models(value: unknown): void {
  const v = object(value)
  fields(v, ['segmentation', 'embedding'])
  string(v.segmentation); string(v.embedding)
}

function identity(v: Record<string, unknown>, anonymous: Map<string, string>): void {
  oneOf(v.identity_status, ['matched', 'unknown', 'uncertain'])
  if (v.identity_status === 'matched') string(v.registration_id)
  else if (v.registration_id !== undefined) invalid()
  const signature = JSON.stringify([v.identity_status, v.registration_id])
  const speaker = v.anonymous_speaker as string
  if (anonymous.has(speaker) && anonymous.get(speaker) !== signature) invalid()
  anonymous.set(speaker, signature)
}

export function validateVoiceSegments(value: unknown, samples: number): asserts value is VoiceSegment[] {
  integer(samples, 1, VOICE_MAX_SAMPLES)
  if (!Array.isArray(value) || !value.length || value.length > 32) invalid()
  let end = 0
  const anonymous = new Map<string, string>()
  for (const [index, raw] of value.entries()) {
    const v = object(raw)
    fields(v, ['segment_index', 'start_sample', 'end_sample', 'anonymous_speaker', 'identity_status'], ['registration_id', 'score', 'margin'])
    if (v.segment_index !== index) invalid()
    integer(v.start_sample, end, samples - 1)
    integer(v.end_sample, (v.start_sample as number) + 1, samples)
    string(v.anonymous_speaker, 128)
    identity(v, anonymous)
    for (const key of ['score', 'margin']) if (v[key] !== undefined && (typeof v[key] !== 'number' || !Number.isFinite(v[key]))) invalid()
    end = v.end_sample as number
  }
}

export function parseVoiceClientControl(data: string): VoiceClientControl {
  if (Buffer.byteLength(data, 'utf8') > 65536) invalid()
  const v = object(JSON.parse(data))
  switch (v.type) {
    case 'pair':
      fields(v, ['type', 'protocol_version', 'nonce']); version(v.protocol_version); string(v.nonce); break
    case 'hello':
      fields(v, ['type', 'protocol_version', 'credential', 'models', 'aec_verified'])
      version(v.protocol_version); string(v.credential); models(v.models); oneOf(v.aec_verified, [true, false]); break
    case 'heartbeat':
      fields(v, ['type', 'foreground', 'microphone', 'playback', 'enrollment_revision']); integer(v.enrollment_revision)
      oneOf(v.foreground, [true, false]); oneOf(v.microphone, ['closed', 'wake', 'recording']); oneOf(v.playback, ['idle', 'playing']); break
    case 'contact_action': fields(v, ['type', 'request']); validateVoiceManagementRequest(v.request); break
    case 'contact_action_query': fields(v, ['type', 'request_id']); assertVoiceUuid(v.request_id); break
    case 'catalog_applied': fields(v, ['type', 'enrollment_revision']); integer(v.enrollment_revision); break
    case 'turn_start':
      fields(v, ['type', 'turn_id']); assertVoiceUuid(v.turn_id); break
    case 'turn_query':
      fields(v, ['type', 'turn_id', 'payload_sha256']); assertVoiceUuid(v.turn_id)
      if (typeof v.payload_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(v.payload_sha256)) invalid()
      break
    case 'turn_end':
      fields(v, ['type', 'turn_id', 'audio_sample_count', 'sample_rate', 'models', 'enrollment_revision', 'segments'])
      assertVoiceUuid(v.turn_id); oneOf(v.sample_rate, [16000]); models(v.models); integer(v.enrollment_revision)
      validateVoiceSegments(v.segments, v.audio_sample_count as number); break
    case 'cancel':
      fields(v, ['type'], ['turn_id', 'playback_id'])
      if (v.turn_id === undefined && v.playback_id === undefined) invalid()
      if (v.turn_id !== undefined) assertVoiceUuid(v.turn_id)
      if (v.playback_id !== undefined) assertVoiceUuid(v.playback_id)
      break
    case 'playback':
      fields(v, ['type', 'playback_id', 'status'], ['played_samples']); assertVoiceUuid(v.playback_id)
      oneOf(v.status, ['started', 'completed', 'interrupted', 'failed'])
      if (v.played_samples !== undefined) integer(v.played_samples, 0, 480000)
      if (v.status === 'completed' && (v.played_samples === undefined || v.played_samples === 0)) invalid()
      if (v.status === 'started' && (v.played_samples === undefined || v.played_samples === 0)) invalid()
      break
    case 'enrollment_done':
      fields(v, ['type', 'registration_id', 'model_id', 'enrollment_revision'])
      string(v.registration_id); string(v.model_id); integer(v.enrollment_revision); break
    case 'registration_cleared':
      fields(v, ['type', 'registration_id', 'enrollment_revision'])
      string(v.registration_id); integer(v.enrollment_revision); break
    default: invalid()
  }
  return v as unknown as VoiceClientControl
}

export function validateSubmitVoiceTurn(value: unknown): asserts value is SubmitVoiceTurnParams {
  const v = object(value)
  fields(v, ['channel_id', 'session_id', 'turn_id', 'connection_epoch', 'enrollment_revision', 'messages'])
  string(v.channel_id); string(v.session_id); assertVoiceUuid(v.turn_id); assertVoiceUuid(v.connection_epoch); integer(v.enrollment_revision)
  if (!Array.isArray(v.messages) || !v.messages.length || v.messages.length > 32) invalid()
  let end = 0
  const anonymous = new Map<string, string>()
  const ids = new Set<string>()
  for (const [index, raw] of v.messages.entries()) {
    const m = object(raw)
    fields(m, ['platform_message_id', 'session', 'sender', 'content', 'features', 'platform_timestamp'])
    string(m.platform_message_id); string(m.platform_timestamp)
    if (!Number.isFinite(Date.parse(m.platform_timestamp as string)) || ids.has(m.platform_message_id as string)) invalid()
    ids.add(m.platform_message_id as string)
    const session = object(m.session); fields(session, ['session_id', 'channel_id', 'type'])
    if (session.session_id !== v.session_id || session.channel_id !== v.channel_id || session.type !== 'group') invalid()
    const sender = object(m.sender); fields(sender, ['platform_user_id', 'platform_display_name'])
    string(sender.platform_user_id); string(sender.platform_display_name)
    const content = object(m.content); fields(content, ['type', 'text'])
    if (content.type !== 'text') invalid()
    string(content.text, 8000)
    if (!(content.text as string).trim()) invalid()
    const features = object(m.features); fields(features, ['is_mention_crab', 'voice'])
    if (features.is_mention_crab !== true) invalid()
    const voice = object(features.voice)
    fields(voice, ['turn_id', 'segment_index', 'start_sample', 'end_sample', 'anonymous_speaker', 'identity_status'], ['registration_id'])
    if (voice.turn_id !== v.turn_id || voice.segment_index !== index) invalid()
    integer(voice.start_sample, end, VOICE_MAX_SAMPLES - 1)
    integer(voice.end_sample, (voice.start_sample as number) + 1, VOICE_MAX_SAMPLES)
    string(voice.anonymous_speaker, 128); identity(voice, anonymous); end = voice.end_sample as number
  }
}

export function encodeVoiceFrame(kind: 1 | 2, id: string, sequence: number, pcm: Buffer): Buffer {
  assertVoiceUuid(id); integer(sequence, 0, 0xffffffff)
  if (!pcm.length || pcm.length % 2 || pcm.length > (kind === 1 ? 640 : 960)) invalid()
  const header = Buffer.alloc(21)
  header[0] = kind
  Buffer.from(id.replaceAll('-', ''), 'hex').copy(header, 1)
  header.writeUInt32LE(sequence, 17)
  return Buffer.concat([header, pcm])
}

/** One finite turn; no audio is retained after finish/clear. */
export class VoiceInputBuffer {
  private chunks: Buffer[] = []
  private sequence = 0
  private count = 0
  private lastShort = false
  constructor(readonly turnId: string) { assertVoiceUuid(turnId) }
  append(frame: Buffer): void {
    if (frame.length <= 21 || frame.length > 661 || (frame.length - 21) % 2 || frame[0] !== 1 || this.lastShort) invalid()
    const expectedId = Buffer.from(this.turnId.replaceAll('-', ''), 'hex')
    if (!frame.subarray(1, 17).equals(expectedId) || frame.readUInt32LE(17) !== this.sequence) invalid()
    const pcm = frame.subarray(21)
    if (this.count + pcm.length / 2 > VOICE_MAX_SAMPLES) invalid()
    this.chunks.push(Buffer.from(pcm)); this.count += pcm.length / 2; this.sequence++
    this.lastShort = pcm.length < 640
  }
  finish(samples: number): Buffer {
    if (!samples || samples !== this.count) { this.clear(); invalid() }
    const result = Buffer.concat(this.chunks)
    this.clear()
    return result
  }
  clear(): void {
    for (const chunk of this.chunks) chunk.fill(0)
    this.chunks = []; this.count = 0; this.sequence = 0; this.lastShort = false
  }
}

export function voiceSessionId(channelId: string): string {
  return createHash('sha256').update(`${channelId}\0household`).digest().readUIntBE(0, 6).toString(36).padStart(8, '0').slice(0, 8)
}
