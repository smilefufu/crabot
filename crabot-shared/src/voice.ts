// protocol-voice.md v0.4.0: shared terminal, configuration and admission contracts.
import type { ModuleId, SessionId, FriendId } from './base-protocol.js'
import type { ChannelMessage, Friend } from './channel-protocol.js'

export type VoiceIdentityStatus = 'matched' | 'unknown' | 'uncertain'
export interface VoiceSegment {
  segment_index: number
  start_sample: number
  end_sample: number
  anonymous_speaker: string
  identity_status: VoiceIdentityStatus
  registration_id?: string
  score?: number
  margin?: number
}
export interface VoiceMessageFeatures {
  turn_id: string
  segment_index: number
  start_sample: number
  end_sample: number
  anonymous_speaker: string
  identity_status: VoiceIdentityStatus
  registration_id?: string
}
export interface VoiceReplyContext {
  channel_id: ModuleId
  session_id: SessionId
  turn_id: string
  connection_epoch: string
  expires_at: string
}
export type VoiceOutputEvent =
  | { type: 'reply_start'; playback_id: string }
  | { type: 'reply_text'; playback_id: string; sequence: number; text: string }
  | { type: 'reply_end'; playback_id: string }
  | { type: 'reply_cancel'; playback_id: string }
  | { type: 'response_end' }
export interface VoiceOutputParams {
  voice_reply_context: VoiceReplyContext
  event: VoiceOutputEvent
}
export type VoiceOutputResult =
  | { accepted: true }
  | { platform_message_id: string; sent_at: string; played_samples: number }
export interface VerifyVoiceAgentParams { channel_id: ModuleId }
export interface VerifyVoiceAgentResult { verified: true }
export interface VoiceChannelCapability {
  protocol_version: 4
  send_timeout_ms: 30000
}
export type AudioServiceFormat = 'sherpa-offline-ws' | 'mlx-audio-http' | 'openai-audio'
export type AudioServiceCapability = 'asr' | 'tts'
export interface AudioServiceModel {
  model_id: string
  display_name: string
  capabilities: AudioServiceCapability[]
  voice?: string
  language?: string
}
export interface AudioServiceProvider {
  id: string
  name: string
  format: AudioServiceFormat
  endpoint: string
  api_key?: string
  models: AudioServiceModel[]
}
export interface AudioModelReference { provider_id: string; model_id: string }
export interface AudioServiceConnection {
  provider_id: string
  format: AudioServiceFormat
  endpoint: string
  api_key?: string
  model_id: string
  voice?: string
  language?: string
}
export interface VoiceInstanceConfig {
  asr: AudioModelReference | null
  tts: AudioModelReference | null
  wake_word: string
}
export interface VoiceConnectionConfig {
  base_url: string
  transport: 'ws' | 'wss'
}
export interface VoiceSetupMetadata {
  status: 'draft' | 'complete'
  connection?: VoiceConnectionConfig
}
export interface VoiceTerminalEntry {
  url: string
  tls_fingerprint_sha256?: string
}
export interface VoiceContact {
  platform_user_id: string
  display_name: string
  friend_id?: FriendId
}
export interface VoiceRegistration {
  registration_id: string
  display_name: string
  platform_user_id: string
  model_id: string
  status: 'pending' | 'active' | 'revoked'
  terminal_cleared: boolean
}
export interface GetVoiceConfigParams { channel_id: ModuleId }
export interface GetVoiceConfigResult {
  setup_status: 'draft' | 'complete'
  terminal_entry: VoiceTerminalEntry | null
  config: VoiceInstanceConfig
  enrollment_revision: number
  contacts: VoiceContact[]
  registrations: VoiceRegistration[]
  asr_connection: AudioServiceConnection | null
  tts_connection: AudioServiceConnection | null
}
export interface SubmitVoiceTurnParams {
  channel_id: ModuleId
  session_id: SessionId
  turn_id: string
  connection_epoch: string
  enrollment_revision: number
  messages: ChannelMessage[]
}
export type VoiceTurnStatus = 'pending' | 'accepted' | 'rejected' | 'unknown'
export interface VoiceTurnResult {
  status: VoiceTurnStatus
  payload_sha256?: string
  reason?: string
}
export interface GetVoiceTurnStatusParams {
  channel_id: ModuleId
  turn_id: string
  payload_sha256: string
}
export interface GetAuthorizedVoiceTurnParams {
  channel_id: ModuleId
  turn_id: string
  payload_sha256: string
}
export interface ConfirmVoiceTurnParams {
  channel_id: ModuleId
  turn_id: string
  payload_sha256: string
}
export interface VoiceTurnAuthorizedPayload {
  channel_id: ModuleId
  session_id: SessionId
  turn_id: string
  connection_epoch: string
  enrollment_revision: number
  payload_sha256: string
  reply_context: VoiceReplyContext
  messages: Array<{ message: ChannelMessage; friend?: Friend }>
}
export interface SyncVoiceTerminalParams {
  channel_id: ModuleId
  connection_epoch: string | null
  foreground: boolean
  completed_enrollment?: { registration_id: string; model_id: string; enrollment_revision: number }
  cleared_registration?: { registration_id: string; enrollment_revision: number }
}
export interface VerifyVoiceRuntimeParams { expected_module_id: ModuleId }
export interface VerifyVoiceRuntimeResult { verified: true }
export interface VerifyVoiceAdminParams { channel_id: ModuleId }
export interface VerifyVoiceAdminResult { verified: true }

export type VoiceAdminAction =
  | { action: 'status' }
  | { action: 'create_pairing' }
  | { action: 'confirm_pairing'; pairing_id: string }
  | { action: 'revoke_terminal' }
  | { action: 'create_contact'; display_name: string }
  | { action: 'enroll'; platform_user_id: string }
  | { action: 'delete_registration'; registration_id: string }
export interface VoiceAdminActionParams { channel_id: ModuleId; command: VoiceAdminAction }
export interface VoicePairing {
  protocol_version: 4
  channel_id: ModuleId
  pairing_id: string
  url: string
  tls_fingerprint_sha256?: string
  nonce: string
  verification_code: string
  expires_at: string
}
export interface VoiceTerminalState {
  paired: boolean
  connected: boolean
  foreground: boolean
  microphone: 'closed' | 'wake' | 'recording'
  playback: 'idle' | 'playing'
  aec_verified: boolean
  enrollment_revision: number
  contacts: VoiceContact[]
  registrations: VoiceRegistration[]
  hosts: string[]
  pairing_id?: string
  verification_code?: string
}
export type VoiceAdminActionResult =
  | { action: 'status'; state: VoiceTerminalState }
  | { action: 'create_pairing'; pairing: VoicePairing }
  | { action: 'confirm_pairing'; confirmed: true }
  | { action: 'revoke_terminal'; revoked: true }
  | { action: 'create_contact'; contact: VoiceContact }
  | { action: 'enroll'; registration: VoiceRegistration }
  | { action: 'delete_registration'; revoked: true }

export interface VoiceModelVersions { segmentation: string; embedding: string }
export type VoiceClientControl =
  | { type: 'pair'; protocol_version: 4; nonce: string }
  | { type: 'hello'; protocol_version: 4; credential: string; models: VoiceModelVersions; aec_verified: boolean }
  | { type: 'heartbeat'; foreground: boolean; microphone: 'closed' | 'wake' | 'recording'; playback: 'idle' | 'playing' }
  | { type: 'turn_start'; turn_id: string }
  | { type: 'turn_query'; turn_id: string; payload_sha256: string }
  | { type: 'turn_end'; turn_id: string; audio_sample_count: number; sample_rate: 16000; models: VoiceModelVersions; enrollment_revision: number; segments: VoiceSegment[] }
  | { type: 'cancel'; turn_id?: string; playback_id?: string }
  | { type: 'playback'; playback_id: string; status: 'started' | 'completed' | 'interrupted' | 'failed'; played_samples?: number }
  | { type: 'enrollment_done'; registration_id: string; model_id: string; enrollment_revision: number }
  | { type: 'registration_cleared'; registration_id: string; enrollment_revision: number }
export type VoiceServerControl =
  | { type: 'pair_waiting'; pairing_id: string; verification_code: string }
  | { type: 'paired'; credential: string }
  | { type: 'hello'; connection_epoch: string; config: VoiceInstanceConfig; destinations: Array<{capability: AudioServiceCapability; endpoint: string}>; enrollment_revision: number; registrations: VoiceRegistration[] }
  | { type: 'heartbeat' }
  | { type: 'turn_ready'; turn_id: string }
  | { type: 'turn_status'; turn_id: string; status: VoiceTurnStatus; payload_sha256?: string; reason?: string }
  | { type: 'playback_start'; playback_id: string; turn_id: string; text: string }
  | { type: 'playback_end'; playback_id: string; text: string; sample_count: number }
  | { type: 'response_end'; turn_id: string }
  | { type: 'playback_cancel'; playback_id: string }
  | { type: 'enroll'; registration: VoiceRegistration; enrollment_revision: number }
  | { type: 'clear_registration'; registration_id: string; enrollment_revision: number }
  | { type: 'error'; code: string; message: string; turn_id?: string }
