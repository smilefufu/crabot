/**
 * Admin Web UI 类型定义
 * 与 crabot-admin/src/types.ts 保持一致
 */

// ============================================================================
// Model Provider 类型
// ============================================================================

export type ApiFormat = 'openai' | 'anthropic' | 'gemini' | 'openai-responses'
export type ModelType = 'llm' | 'embedding'
export type ProviderStatus = 'active' | 'inactive' | 'error'
export type ProviderConfigType = 'manual' | 'preset'

export interface ModelInfo {
  model_id: string
  display_name: string
  type: ModelType
  supports_vision?: boolean
  context_window?: number
  dimension?: number
  description?: string
  tags?: string[]
}

export interface ModelProvider {
  id: string
  name: string
  type: ProviderConfigType
  format: ApiFormat
  endpoint: string
  api_key: string
  preset_vendor?: string
  auth_type?: 'apikey' | 'oauth'
  oauth_info?: { email?: string; expires_at?: number; account_id?: string }
  models: ModelInfo[]
  status: ProviderStatus
  last_validated_at?: string
  validation_error?: string
  created_at: string
  updated_at: string
}

export interface PresetVendor {
  id: string
  name: string
  format: ApiFormat
  endpoint: string
  models_api?: string
  docs_url?: string
  api_key_help_url?: string
  /** 是否允许用户自定义 endpoint（如自托管的 Ollama） */
  allows_custom_endpoint?: boolean
  /** 认证方式 */
  auth_type?: 'apikey' | 'oauth'
}

export interface GlobalModelConfig {
  default_llm_provider_id?: string
  default_llm_model_id?: string
  default_embedding_provider_id?: string
  default_embedding_model_id?: string
}

export interface ModelConnectionInfo {
  endpoint: string
  apikey: string
  model_id: string
  format: ApiFormat
  dimension?: number
  provider_id?: string
}

// ============================================================================
// Agent 类型
// ============================================================================

export type AgentEngine = 'claude-agent-sdk' | 'pydantic-ai' | 'custom'
export type AgentImplementationType = 'config_only' | 'full_code'
export type ModelFormat = 'openai' | 'anthropic' | 'gemini'

export interface ModelRoleDefinition {
  key: string
  description: string
  required: boolean
  recommended_capabilities?: string[]
  used_by?: Array<'front' | 'worker'>
}

/** LLM 角色需求（从 API 获取） */
export interface LLMRoleRequirement {
  key: string
  description: string
  required: boolean
  recommended_capabilities?: string[]
  used_by?: Array<'front' | 'worker'>
}

/** visible_when 条件 */
export type VisibleWhenCondition =
  | { key: string; equals: string | number | boolean }
  | { any_of: string[]; equals: string | number | boolean }

/** 扩展配置项 Schema */
export interface ExtraConfigSchema {
  key: string
  title: string
  description?: string
  type: 'string' | 'number' | 'boolean' | 'select'
  default?: unknown
  options?: Array<{ value: string; label: string }>
  visible_when?: VisibleWhenCondition
}

/** Agent LLM 需求响应 */
export interface AgentLLMRequirementsResponse {
  model_format: ModelFormat
  requirements: LLMRoleRequirement[]
  extra_schema: ExtraConfigSchema[]
}

export interface AgentImplementation {
  id: string
  name: string
  type: 'builtin' | 'installed'
  implementation_type: AgentImplementationType
  engine: AgentEngine
  supported_roles: Array<'front' | 'worker'>
  model_format: ModelFormat
  model_roles: ModelRoleDefinition[]
  source?: {
    type: 'local' | 'git'
    path: string
    ref?: string
  }
  installed_path?: string
  version?: string
  installed_at?: string
  created_at: string
  updated_at: string
}

export interface AgentInstance {
  id: string
  implementation_id: string
  name: string
  specialization: string
  max_concurrent_tasks?: number
  auto_start: boolean
  start_priority: number
  module_registered: boolean
  module_port?: number
  created_at: string
  updated_at: string
}

export interface MCPServerRegistryEntry {
  id: string
  name: string
  description?: string
  command: string
  args?: string[]
  env?: Record<string, string>
  is_builtin: boolean
  is_essential: boolean
  can_disable: boolean
  install_method?: 'npm' | 'pip' | 'binary' | 'local'
  source_market?: string
  source_package?: string
  enabled: boolean
  created_at: string
  updated_at: string
}

export interface SkillRegistryEntry {
  id: string
  name: string
  description: string
  version: string
  content: string
  trigger_phrases?: string[]
  is_builtin: boolean
  is_essential: boolean
  can_disable: boolean
  source_market?: string
  source_package?: string
  enabled: boolean
  created_at: string
  updated_at: string
}

export interface EssentialToolsConfig {
  builtin_overrides: Record<string, { enabled: boolean }>
  essential_mcp_server_ids: string[]
  essential_skill_ids: string[]
}

export interface MCPServerConfig {
  id: string
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
  description?: string
}

export interface SkillConfig {
  id: string
  name: string
  content: string
  description?: string
}

/** 模型 slot 引用（存储格式） */
export interface ModelSlotRef {
  provider_id: string
  model_id: string
}

export interface AgentInstanceConfig {
  instance_id: string
  system_prompt: string
  model_config: Record<string, ModelSlotRef>
  mcp_server_ids?: string[]
  skill_ids?: string[]
  max_iterations?: number
  tools_readonly?: boolean
  timezone?: string
  extra?: Record<string, unknown>
}

// ============================================================================
// 认证类型
// ============================================================================

export interface LoginRequest {
  password: string
}

export interface LoginResponse {
  token: string
  expires_at: string
}

// ============================================================================
// API 响应类型
// ============================================================================

export interface ApiError {
  error: string
  code?: string
}

export interface Pagination {
  page: number
  page_size: number
  total_items: number
  total_pages: number
}

export interface PaginatedResponse<T> {
  items: T[]
  pagination: Pagination
}

export interface PaginatedResult<T> {
  items: T[]
  total: number
  page: number
  limit: number
  has_more: boolean
}

// ============================================================================
// Channel 管理类型
// ============================================================================

export interface ChannelImplementation {
  id: string
  name: string
  type: 'builtin' | 'installed'
  platform: string
  module_path?: string
  installed_path?: string
  version: string
  config_schema?: JsonSchema
  created_at: string
  updated_at: string
}

/** JSON Schema 子集（crabot-module.yaml config_schema） */
export interface JsonSchema {
  type: string
  required?: string[]
  properties?: Record<string, JsonSchemaProperty>
}

export interface JsonSchemaProperty {
  type: string
  title?: string
  description?: string
  format?: string // password, uri, email 等
  default?: unknown
  enum?: (string | number)[]
}

export interface ChannelInstance {
  id: string
  implementation_id: string
  name: string
  platform: string
  state_dir?: string
  auto_start: boolean
  start_priority: number
  module_registered: boolean
  runtime_status?: 'stopped' | 'starting' | 'running' | 'stopping' | 'failed' | 'unknown'
  created_at: string
  updated_at: string
}

export interface ChannelConfig {
  platform: string
  credentials: Record<string, string>
  cache?: Record<string, any>
  group?: Record<string, any>
  [key: string]: any
}

// ── 飞书扫码 onboarding ───────────────────────────────────────────────

export interface FeishuOnboardBeginResult {
  session_id: string
  verification_uri: string
  interval: number
  expires_at: number
}

export type FeishuOnboardPollEvent =
  | { type: 'pending' }
  | { type: 'slow_down' }
  | { type: 'success'; app_id: string; app_secret: string; open_id: string; domain: 'feishu' | 'lark' }
  | { type: 'error'; code: string; message?: string }

export interface CreateChannelInstanceParams {
  implementation_id: string
  name: string
  platform?: string
  state_dir?: string
  auto_start?: boolean
  env?: Record<string, string>
}

export interface UpdateChannelInstanceParams {
  instance_id: string
  name?: string
  auto_start?: boolean
}

export interface UpdateChannelConfigParams {
  instance_id: string
  config: Partial<ChannelConfig>
}

// ============================================================================
// Permission System
// ============================================================================

export type ToolCategory =
  | 'memory'
  | 'messaging'
  | 'task'
  | 'mcp_skill'
  | 'file_io'
  | 'browser'
  | 'shell'
  | 'remote_exec'
  | 'desktop'

export interface ToolAccessConfig {
  memory: boolean
  messaging: boolean
  task: boolean
  mcp_skill: boolean
  file_io: boolean
  browser: boolean
  shell: boolean
  remote_exec: boolean
  /** 桌面控制（computer-use）：仅 master_private 模板可开启 */
  desktop: boolean
}

export interface StoragePermission {
  workspace_path: string
  access: 'read' | 'readwrite'
}

export interface PermissionTemplate {
  id: string
  name: string
  description?: string
  is_system: boolean
  tool_access: ToolAccessConfig
  storage: StoragePermission | null
  memory_scopes: string[]
  created_at: string
  updated_at: string
}

/** Tool category labels for display */
export const TOOL_CATEGORY_LABELS: Record<ToolCategory, string> = {
  memory: '记忆读写',
  messaging: '消息操作',
  task: '任务管理',
  mcp_skill: 'MCP 技能',
  file_io: '文件操作',
  browser: '浏览器',
  shell: '本地命令',
  remote_exec: '远程执行',
  desktop: '桌面控制（仅 Master 私聊）',
}

export const TOOL_CATEGORIES: readonly ToolCategory[] = [
  'memory', 'messaging', 'task', 'mcp_skill', 'file_io', 'browser', 'shell', 'remote_exec', 'desktop',
] as const

// ============================================================================
// Friend（熟人）管理类型
// ============================================================================

export type FriendPermission = 'master' | 'normal'

export interface ChannelIdentity {
  channel_id: string
  platform_user_id: string
  platform_display_name: string
}

export interface Friend {
  id: string
  display_name: string
  permission: FriendPermission
  permission_template_id?: string
  channel_identities: ChannelIdentity[]
  created_at: string
  updated_at: string
}

export interface PendingMessage {
  id: string
  channel_id: string
  platform_user_id: string
  platform_display_name: string
  content_preview: string
  /** 申请意图：pair=申请成为 Master，apply=申请普通权限 */
  intent: 'pair' | 'apply'
  received_at: string
  expires_at: string
}

// ============================================================================
// Dialog Objects
// ============================================================================

export type DialogObjectFriendStatus = 'active' | 'no_channel'

export interface DialogObjectFriend {
  id: string
  display_name: string
  permission: FriendPermission
  permission_template_id?: string
  identities: ChannelIdentity[]
  status: DialogObjectFriendStatus
  created_at: string
  updated_at: string
}

export interface DialogObjectApplication {
  id: string
  intent: 'pair' | 'apply'
  channel_id: string
  platform_user_id: string
  platform_display_name: string
  content_preview: string
  source_session_id: string
  received_at: string
  expires_at: string
}

export interface DialogObjectChannelSessionParticipant {
  friend_id?: string
  platform_user_id: string
  role: 'owner' | 'admin' | 'member'
}

export interface DialogObjectChannelSession {
  id: string
  channel_id: string
  type: 'private' | 'group'
  platform_session_id: string
  title: string
  participants: DialogObjectChannelSessionParticipant[]
  created_at: string
  updated_at: string
}

export interface DialogObjectPrivatePoolEntry extends DialogObjectChannelSession {
  has_session_config: boolean
  matching_pending_application_ids: string[]
}

export interface DialogObjectGroupEntry extends DialogObjectChannelSession {
  participant_count: number
  has_session_config: boolean
  master_in_group: boolean
}

// ============================================================================
// Channel 扫描类型
// ==============================================================================

export interface ScannedPlugin {
  name: string        // 包名，如 @openclaw/feishu
  platform: string    // 平台，如 feishu
  entry_path: string  // 入口文件路径
}

export interface ScanResult {
  plugins: ScannedPlugin[]
  has_config: boolean
}

// ============================================================================
// Schedule 类型
// ============================================================================

export type ScheduleTriggerType = 'cron' | 'interval' | 'once'

export interface CronTrigger {
  type: 'cron'
  expression: string
  timezone?: string
}

export interface IntervalTrigger {
  type: 'interval'
  seconds: number
}

export interface OnceTrigger {
  type: 'once'
  execute_at: string
}

export type ScheduleTrigger = CronTrigger | IntervalTrigger | OnceTrigger

export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent'

export interface ScheduleTaskTemplate {
  title: string
  description?: string
  priority: TaskPriority
  input?: Record<string, unknown>
  tags: string[]
}

export interface Schedule {
  id: string
  name: string
  description?: string
  enabled: boolean
  is_builtin?: boolean
  trigger: ScheduleTrigger
  task_template: ScheduleTaskTemplate
  last_triggered_at?: string
  next_trigger_at?: string
  execution_count: number
  last_task_id?: string
  created_at: string
  updated_at: string
}
