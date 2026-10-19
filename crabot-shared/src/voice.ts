// protocol-voice.md v0.9.0: shared terminal, configuration and admission contracts.
import type { ModuleId, SessionId, FriendId } from './base-protocol.js'
import type { ChannelMessage, Friend } from './channel-protocol.js'
import type { ConversationRequestSource } from './conversation-request-source.js'

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
  | { type: 'pending_results'; count: number }
export interface VoiceDeliveryBinding {
  channel_id: ModuleId
  session_id: SessionId
  response_id: string
  request_id?: string
  worker_id?: string
  worker_turn_id?: string
}
export interface VoicePlaybackContext {
  binding: VoiceDeliveryBinding
  connection_epoch: string
  kind: 'reply' | 'notification'
  turn_id?: string
}
export type VoiceOutputParams =
  | { voice_reply_context: VoiceReplyContext; delivery_context?: never; event: VoiceOutputEvent }
  | { delivery_context: VoicePlaybackContext; voice_reply_context?: never; event: VoiceOutputEvent }
export interface GetVoiceOutputStateParams { channel_id: ModuleId; session_id: SessionId }
export interface VoiceOutputState {
  channel_id: ModuleId
  session_id: SessionId
  connection_epoch: string | null
  foreground: boolean
  speech_enabled: boolean
  activity: 'idle' | 'recording' | 'processing' | 'answering' | 'management'
  current_turn_id: string | null
}
export interface VoicePlaybackReport {
  playback_id: string
  status: 'started' | 'completed' | 'interrupted' | 'failed'
  played_samples?: number
}
export interface VoicePlaybackProgress {
  playback_id: string
  played_samples: number
}
export interface GetVoicePlaybackReceiptParams {
  channel_id: ModuleId
  session_id: SessionId
  playback_id: string
}
export interface VoicePlaybackReceipt {
  playback_id: string
  status: 'active' | 'unknown' | 'completed' | 'interrupted' | 'failed'
  played_samples?: number
  sent_at?: string
}
export interface VoiceOutputReadyPayload {
  channel_id: ModuleId
  session_id: SessionId
  connection_epoch: string
}
export type VoiceOutputResult =
  | { accepted: true }
  | { accepted: false; code: 'VOICE_OUTPUT_BACKPRESSURE' }
  | { platform_message_id: string; sent_at: string; played_samples: number }
export interface VerifyVoiceAgentParams { channel_id: ModuleId }
export interface VerifyVoiceAgentResult { verified: true }
export interface VoiceChannelCapability {
  protocol_version: 9
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
  owner_activation_required?: boolean
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
export interface VoiceTerminalContact {
  platform_user_id: string
  display_name: string
}
export interface VoiceEnrollmentTask {
  registration: VoiceRegistration
  enrollment_revision: number
  expires_at: string
}
export interface VoiceCatalog {
  enrollment_revision: number
  contacts: VoiceTerminalContact[]
  registrations: VoiceRegistration[]
  pending_enrollment: VoiceEnrollmentTask | null
}
export type VoiceManagementCommand =
  | { action: 'enroll_new'; display_name: string }
  | { action: 'enroll'; platform_user_id: string }
  | { action: 'rename_contact'; platform_user_id: string; display_name: string }
  | { action: 'delete_registration'; registration_id: string }
  | { action: 'cancel_enrollment'; registration_id: string }
export interface VoiceManagementRequest {
  request_id: string
  expected_revision: number
  command: VoiceManagementCommand
}
export interface VoiceManagementResult {
  status: 'pending' | 'completed' | 'rejected' | 'unknown'
  catalog: VoiceCatalog
  code?: string
  message?: string
}
export interface ManageVoiceContactsParams {
  channel_id: ModuleId
  connection_epoch: string
  request: VoiceManagementRequest
}
export interface GetVoiceManagementResultParams {
  channel_id: ModuleId
  connection_epoch: string
  request_id: string
}
export interface GetVoiceConfigParams { channel_id: ModuleId }
export interface GetVoiceConfigResult {
  owner_activation_required: boolean
  owner_activation: VoiceOwnerActivation | null
  setup_status: 'draft' | 'complete'
  terminal_entry: VoiceTerminalEntry | null
  config: VoiceInstanceConfig
  enrollment_revision: number
  contacts: VoiceContact[]
  registrations: VoiceRegistration[]
  pending_enrollment: VoiceEnrollmentTask | null
  unconfirmed_contacts: VoiceTerminalContact[]
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
  owner_saved?: VoiceOwnerSaved
  completed_enrollment?: { registration_id: string; model_id: string; enrollment_revision: number }
  cleared_registration?: { registration_id: string; enrollment_revision: number }
}
export interface SyncVoiceTerminalResult { synced: true; catalog: VoiceCatalog; guided_enrollment: VoiceGuidedEnrollment | null; owner_activation: VoiceOwnerActivation | null; setup_status: 'draft' | 'complete' }
export interface VerifyVoiceRuntimeParams { expected_module_id: ModuleId }
export interface VerifyVoiceRuntimeResult { verified: true }
export interface VerifyVoiceAdminParams { channel_id: ModuleId }
export interface VerifyVoiceAdminResult { verified: true }

export type VoiceAdminAction =
  | { action: 'status' }
  | { action: 'create_pairing' }
  | { action: 'confirm_pairing'; pairing_id: string }
  | { action: 'revoke_terminal' }
  | { action: 'enroll_new'; display_name: string; request_id: string; expected_revision: number }
  | { action: 'enroll'; platform_user_id: string; request_id: string; expected_revision: number }
  | { action: 'rename_contact'; platform_user_id: string; display_name: string; request_id: string; expected_revision: number }
  | { action: 'delete_registration'; registration_id: string; request_id: string; expected_revision: number }
  | { action: 'cancel_enrollment'; registration_id: string; request_id: string; expected_revision: number }
export interface VoiceAdminActionParams { channel_id: ModuleId; command: VoiceAdminAction; owner_activation?: VoiceOwnerActivation }
export interface VoicePairing {
  protocol_version: 9
  channel_id: ModuleId
  pairing_id: string
  url: string
  tls_fingerprint_sha256?: string
  nonce: string
  verification_code: string
  expires_at: string
}
export interface VoiceTerminalState {
  owner_activation: VoiceOwnerActivation | null
  pairing_owner?: VoiceDeviceOwner
  paired: boolean
  connected: boolean
  foreground: boolean
  microphone: 'closed' | 'wake' | 'recording'
  playback: 'idle' | 'playing'
  aec_verified: boolean
  enrollment_revision: number
  contacts: VoiceContact[]
  registrations: VoiceRegistration[]
  pending_enrollment: VoiceEnrollmentTask | null
  unconfirmed_contacts: VoiceTerminalContact[]
  hosts: string[] // Admin 投影的局域网候选完整 HTTP URL，含当前 Admin Web 端口；不包含 loopback/link-local
  pairing_id?: string
  verification_code?: string
}
export type VoiceAdminActionResult =
  | { action: 'status'; state: VoiceTerminalState }
  | { action: 'create_pairing'; pairing: VoicePairing }
  | { action: 'confirm_pairing'; confirmed: true }
  | { action: 'revoke_terminal'; revoked: true }
  | { action: 'enroll_new' | 'enroll' | 'rename_contact' | 'delete_registration' | 'cancel_enrollment'; result: VoiceManagementResult }

export interface VoiceModelVersions { segmentation: string; embedding: string }
export type VoiceClientControl =
  | { type: 'pair'; protocol_version: 9; nonce: string; owner: VoiceDeviceOwner }
  | { type: 'hello'; protocol_version: 9; credential: string; models: VoiceModelVersions; aec_verified: boolean; owner?: VoiceDeviceOwner }
  | { type: 'heartbeat'; foreground: boolean; microphone: 'closed' | 'wake' | 'recording'; playback: 'idle' | 'playing'; enrollment_revision: number; speech_enabled: boolean; activity: VoiceOutputState['activity'] }
  | { type: 'owner_saved'; saved: VoiceOwnerSaved }
  | { type: 'guided_prompt'; operation_id: string; step: 1 | 2 | 3 }
  | ({ type: 'guided_playback'; operation_id: string } & VoicePlaybackReport)
  | { type: 'guided_cancel'; operation_id: string }
  | { type: 'contact_action'; request: VoiceManagementRequest }
  | { type: 'contact_action_query'; request_id: string }
  | { type: 'catalog_applied'; enrollment_revision: number }
  | { type: 'turn_start'; turn_id: string }
  | { type: 'turn_query'; turn_id: string; payload_sha256: string }
  | { type: 'turn_end'; turn_id: string; audio_sample_count: number; sample_rate: 16000; models: VoiceModelVersions; enrollment_revision: number; segments: VoiceSegment[] }
  | { type: 'cancel'; turn_id?: string; playback_id?: string }
  | ({ type: 'playback' } & VoicePlaybackReport)
  | ({ type: 'playback_progress' } & VoicePlaybackProgress)
  | { type: 'playback_ready'; playback_id: string; accepted: boolean }
  | { type: 'enrollment_done'; registration_id: string; model_id: string; enrollment_revision: number }
  | { type: 'registration_cleared'; registration_id: string; enrollment_revision: number }
export type VoiceServerControl =
  | { type: 'pair_waiting'; pairing_id: string; verification_code: string }
  | { type: 'paired'; credential: string; owner_activation: VoiceOwnerActivation | null }
  | { type: 'hello'; connection_epoch: string; setup_status: 'draft' | 'complete'; config: VoiceInstanceConfig; destinations: Array<{capability: AudioServiceCapability; endpoint: string}>; catalog: VoiceCatalog; owner_activation: VoiceOwnerActivation | null }
  | { type: 'heartbeat' }
  | { type: 'owner_activation'; activation: VoiceOwnerActivation }
  | { type: 'setup_status'; status: 'draft' | 'complete' }
  | { type: 'catalog'; catalog: VoiceCatalog }
  | { type: 'catalog_confirmed'; enrollment_revision: number }
  | { type: 'contact_result'; request_id: string; result: VoiceManagementResult }
  | { type: 'turn_ready'; turn_id: string }
  | { type: 'turn_status'; turn_id: string; status: VoiceTurnStatus; payload_sha256?: string; reason?: string }
  | { type: 'playback_prepare'; playback_id: string; context: VoicePlaybackContext }
  | { type: 'playback_start'; playback_id: string; turn_id: string }
  | { type: 'playback_text'; playback_id: string; sequence: number; text: string }
  | { type: 'playback_confirmed'; playback_id: string }
  | { type: 'pending_results'; count: number }
  | { type: 'playback_end'; playback_id: string; sample_count: number; text_segment_count: number }
  | { type: 'response_end'; turn_id: string }
  | { type: 'playback_cancel'; playback_id: string }
  | { type: 'enroll'; task: VoiceEnrollmentTask }
  | { type: 'guided_enroll'; enrollment: VoiceGuidedEnrollment }
  | { type: 'guided_prompt_start'; operation_id: string; step: 1 | 2 | 3; playback_id: string; text: string }
  | { type: 'guided_prompt_end'; operation_id: string; playback_id: string; sample_count: number }
  | { type: 'guided_record'; operation_id: string; step: 1 | 2 | 3; playback_id: string }
  | { type: 'guided_end'; operation_id: string; status: 'completed' | 'rejected'; message: string }
  | { type: 'clear_registration'; registration_id: string; enrollment_revision: number }
  | { type: 'error'; code: string; message: string; turn_id?: string }

export interface VoiceDeviceOwner {
  profile_id: string
  display_name: string
  model_id: string
}
export interface VoiceOwnerActivation {
  operation_id: string
  owner: VoiceDeviceOwner
  platform_user_id: string
  registration_id: string
  status: 'pending' | 'completed'
}
export interface VoiceOwnerSaved {
  operation_id: string
  profile_id: string
  registration_id: string
  model_id: string
}

export interface VoiceAgentContext {
  request_id: string
  source: ConversationRequestSource
  turn_id: string
  delivery: 'origin' | 'requester_private'
}
export type VoiceAgentActionParams =
  | { action: 'list'; context: VoiceAgentContext }
  | { action: 'manage'; context: VoiceAgentContext; request: VoiceManagementRequest; existing_friend_id?: FriendId }
  | { action: 'result' | 'commit' | 'ack'; context: VoiceAgentContext; operation_id: string }
export interface VoiceAgentManagementResult {
  operation_id: string | null
  status: 'pending' | 'completed' | 'rejected' | 'unknown'
  catalog: VoiceCatalog
  contacts: VoiceContact[]
  friend_id?: FriendId
  code?: string
  message?: string
}
export interface VoiceAgentManagementReadyPayload {
  channel_id: ModuleId
  session_id: SessionId
  request_id: string
  operation_id: string
}
export interface VoiceGuidedEnrollment {
  operation_id: string
  request_id: string
  connection_epoch: string
  delivery: 'origin' | 'requester_private'
  task: VoiceEnrollmentTask
}
