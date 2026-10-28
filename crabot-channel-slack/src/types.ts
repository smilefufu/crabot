import type { MessageContent, MessageFeatures, SenderRef, SessionType } from 'crabot-shared'
export type { ChannelMessage, MessageContent, MessageFeatures, SenderRef } from 'crabot-shared'

// base-protocol §5. Session authority is subsequently resolved by Admin.
export interface DirectoryStoragePermission { workspace_path: string; access: 'read' | 'readwrite' }
export interface AllDirectoriesStoragePermission { scope: 'all'; access: 'read' | 'readwrite' }
export type StoragePermission = DirectoryStoragePermission | AllDirectoriesStoragePermission
export interface ToolAccessConfig {
  memory: boolean; messaging: boolean; task: boolean; mcp_skill: boolean; file_io: boolean
  browser: boolean; shell: boolean; remote_exec: boolean; desktop: boolean
}
export interface SessionPermissions { tool_access: ToolAccessConfig; storage: StoragePermission | null }
export interface SessionParticipant { friend_id: string; platform_user_id: string; role: 'owner' | 'admin' | 'member' }
export interface Session {
  id: string; channel_id: string; type: SessionType; platform_session_id: string; title: string
  participants: SessionParticipant[]; permissions: SessionPermissions; memory_scopes: string[]
  workspace_path: string; created_at: string; updated_at: string
}
export interface HistoryMessage {
  platform_message_id: string; sender: SenderRef; content: MessageContent
  features: MessageFeatures; platform_timestamp: string
}
export interface CacheConfig { max_days: number; max_messages_per_session: number }
export interface SlackConfig {
  platform: 'slack'; credentials: { bot_token: string; app_token: string }
  cache: CacheConfig; group: { only_respond_to_mentions: boolean }; crab_platform_user_id: string
}
export interface SlackConversation {
  id?: string; name?: string; user?: string; is_im?: boolean; is_mpim?: boolean
  is_member?: boolean; is_archived?: boolean; num_members?: number
}
export interface SlackUser {
  id?: string; name?: string; real_name?: string; deleted?: boolean; is_bot?: boolean
  is_app_user?: boolean; is_primary_owner?: boolean; is_owner?: boolean; is_admin?: boolean
  profile?: { display_name?: string; real_name?: string; image_192?: string }
}
export interface SlackResult {
  ok?: boolean; team_id?: string; user_id?: string; bot_id?: string; ts?: string
  bot?: { app_id?: string }; channel?: SlackConversation; channels?: SlackConversation[]
  user?: SlackUser; members?: Array<SlackUser | string>; response_metadata?: { next_cursor?: string }
}
export interface SlackEnvelope {
  team_id?: string; api_app_id?: string; event_id?: string
  event?: { type?: string; channel?: string; channel_type?: 'im' | 'channel' | 'group' | 'mpim'; user?: string; bot_id?: string; subtype?: string
    text?: string; ts?: string; thread_ts?: string; hidden?: boolean
    files?: Array<{ name?: string; title?: string }> }
}
export interface SlackApi {
  connected: boolean
  call(method: string, args?: Record<string, unknown>): Promise<SlackResult>
  start(onEvent: (body: SlackEnvelope) => Promise<void>): Promise<void>
  stop(): Promise<void>
}
export interface PaginationParams { page: number; page_size: number }
export function displayName(user: SlackUser): string {
  return user.profile?.display_name || user.profile?.real_name || user.real_name || user.name || user.id || ''
}
