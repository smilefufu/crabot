/**
 * Admin Web UI 类型定义
 * 与 crabot-admin/src/types.ts 保持一致
 */

// ============================================================================
// Model Provider 类型
// ============================================================================

export type ApiFormat = 'openai' | 'anthropic' | 'gemini' | 'openai-responses'
export type ModelType = 'llm'
export type ProviderStatus = 'active' | 'inactive' | 'error'
export type ProviderConfigType = 'manual' | 'preset'

export interface ModelInfo {
  model_id: string
  display_name: string
  type: ModelType
  supports_vision?: boolean
  context_window?: number
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
  /** 标记为推荐厂商，前端会在下拉里排到最前、加视觉强调 */
  recommended?: boolean
}

export interface GlobalModelConfig {
  default_llm_provider_id?: string
  default_llm_model_id?: string
  /**
   * 对外可达 base URL，供 agent 拼临时页面链接（<base>/tmp-pages/<id>）。
   * 可选；未配置时后端退化为 http://localhost:<web_port>。
   */
  public_base_url?: string
  /** 自动清理保留天数；null = 不按天清理。与 task_retention_count 互斥，同时存在时 days 优先 */
  trace_retention_days?: number | null
  /**
   * 自动清理保留 task 个数；null = 不按个数清理。
   * spec 2026-06-09-task-trace-tool-unification.md §4.4：单位从 trace 改 task，跟用户心智一致
   * （"保留最近 N 个对话"）。活跃 task 不计入配额。
   */
  task_retention_count?: number | null
}

export interface ModelConnectionInfo {
  endpoint: string
  apikey: string
  model_id: string
  format: ApiFormat
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
  source_type?: 'builtin' | 'imported' | 'scanned'
  is_builtin: boolean
  is_essential: boolean
  can_disable: boolean
  source_market?: string
  source_package?: string
  enabled: boolean
  created_at: string
  updated_at: string
  /**
   * 上一版快照（N=1 覆盖式）。仅 update() 检测到 content 变化 + 非 builtin 时写入。
   * 详见 spec 2026-06-07-skill-previous-version-and-diff-design.md §4.1。
   */
  previous_snapshot?: {
    snapshot_dir: string
    version: string
    updated_at: string
    snapshotted_at: string
  }
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
  is_temp: boolean
}

export interface ChangePasswordRequest {
  old_password?: string
  new_password: string
}

export interface MeResponse {
  is_temp: boolean
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

export interface ChannelOnboardingMethod {
  id: string
  name: string
  description?: string
  type: 'device_code' | 'redirect' | 'pending'
  handler: string
}

export interface ChannelImplementation {
  id: string
  name: string
  type: 'builtin' | 'installed'
  platform: string
  module_path?: string
  installed_path?: string
  version: string
  config_schema?: JsonSchema
  onboarding_methods?: ChannelOnboardingMethod[]
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
  /** 与 enum 一一对应的展示文案。比 enum 多 / 少时按位置取值，缺失则显示原始 enum 值 */
  enum_titles?: string[]
  /** JSON Schema 标准：true 时 Admin Web 把字段渲染为只读 */
  readOnly?: boolean
  /**
   * 扩展字段：运行时 get_config / update_config RPC 里嵌套对象的路径（点分），
   * env 风格 schema property key ↔ 运行时嵌套对象路径的映射。Admin Web 用它
   * 在「模块运行中」编辑面板上按 schema 读 / 写嵌套 config。
   * 不影响 channel 模块自身（onboarding 仍按 env 注入），仅前端用。
   */
  'x-runtime-path'?: string
  /** 扩展字段：true 时 Admin Web 不渲染（保留 schema 内字段的隐藏能力） */
  'x-ui-hidden'?: boolean
}

export interface ChannelInstance {
  id: string
  implementation_id: string
  name: string
  platform: string
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

// ── Channel onboarding (base-protocol §10) ──────────────────────────

export interface OnboardBeginResult {
  session_id: string
  ui_mode: 'qrcode' | 'redirect' | 'pending'
  verification_uri?: string
  interval?: number
  expires_at?: number
  display?: { title?: string; description?: string }
}

export type OnboardPollEvent =
  | { type: 'pending' }
  | { type: 'slow_down' }
  | { type: 'success' }
  | { type: 'error'; code: string; message?: string }

export interface CreateChannelInstanceParams {
  implementation_id: string
  name: string
  platform?: string
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

// ============================================================================
// CLI 访问权限（按 crabot CLI domain 控制粒度）
// ============================================================================

export type CliPerm = 'none' | 'read' | 'write'

export type CliDomain =
  | 'provider'
  | 'agent'
  | 'mcp'
  | 'skill'
  | 'schedule'
  | 'channel'
  | 'friend'
  | 'permission'
  | 'config'
  | 'undo'

export const CLI_DOMAINS: readonly CliDomain[] = [
  'provider', 'agent', 'mcp', 'skill', 'schedule',
  'channel', 'friend', 'permission', 'config', 'undo',
] as const

export type CliAccessConfig = Record<CliDomain, CliPerm>

export const CLI_DOMAIN_LABELS: Record<CliDomain, string> = {
  provider: 'Provider（模型提供商）',
  agent: 'Agent（AI 实例）',
  mcp: 'MCP（工具市场）',
  skill: 'Skill（技能）',
  schedule: 'Schedule（定时任务）',
  channel: 'Channel（消息通道）',
  friend: 'Friend（熟人）',
  permission: 'Permission（权限模板）',
  config: 'Config（全局配置）',
  undo: 'Undo（撤销）',
}

export function createCliAccessConfig(defaultValue: CliPerm): CliAccessConfig {
  return {
    provider: defaultValue,
    agent: defaultValue,
    mcp: defaultValue,
    skill: defaultValue,
    schedule: defaultValue,
    channel: defaultValue,
    friend: defaultValue,
    permission: defaultValue,
    config: defaultValue,
    undo: defaultValue,
  }
}

export interface PermissionTemplate {
  id: string
  name: string
  description?: string
  is_system: boolean
  tool_access: ToolAccessConfig
  cli_access: CliAccessConfig
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
  /** 当前 channel 是否支持手动回填历史（目前仅 feishu native channel 实现了 backfill_history RPC） */
  supports_backfill: boolean
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
  /**
   * 触发的 task 的目标会话（可选）。
   * 详见 protocol-admin §3.19 / spec 2026-06-04-trigger-messages-unified-design §7。
   * 配置后 schedule 触发时 worker 直接知道往哪发；未配置则任务自行决定汇报对象。
   */
  target_session?: {
    channel_id: string
    session_id: string
    platform_session_id?: string
    type: 'private' | 'group'
  }
  last_triggered_at?: string
  next_trigger_at?: string
  execution_count: number
  last_task_id?: string
  created_at: string
  updated_at: string
}

// ============================================================================
// SubAgent（与 crabot-admin/src/types.ts 镜像；保持字段名 100% 一致）
// ============================================================================

export type ModelRole = 'powerful' | 'cost_effective' | 'vision'

export interface BuiltinCapabilities {
  file_system: boolean
  shell: boolean
  task_intel: boolean
  crab_memory: boolean
  crab_messaging: boolean
}

export interface SubAgentBase {
  id: string
  name: string
  description: string
  when_to_use: string
  role: string
  workflow: string
  deliverables: string
  verification?: string
  builtin_capabilities: BuiltinCapabilities
  allowed_mcp_server_ids: string[]
  allowed_skill_ids: string[]
  max_turns: number
  hook_preset?: string
  /** 系统专用：仅由系统隐式触发，不暴露给 worker（spec §6.4） */
  system_only?: boolean
}

export interface SubAgentRegistryEntry extends SubAgentBase {
  provider_id: string | null
  model_id: string | null
  model_role: ModelRole | null
  enabled: boolean
  is_builtin: boolean
  created_at: string
  updated_at: string
}

// ============================================================================
// TaskGoal — 目标驱动模式（per-task，agent 自定）
// spec: crabot-docs/superpowers/specs/2026-05-23-goal-mode-design.md §3
// ============================================================================

/**
 * Task 内嵌的目标状态机：
 *   active ──► complete | blocked | budget_limited | cleared （均为终态）
 */
export type TaskGoalStatus = 'active' | 'complete' | 'blocked' | 'budget_limited' | 'cleared'

export interface AcceptanceCriterion {
  id: string
  kind: 'cmd' | 'file' | 'semantic'
  spec: string
  expect?: {
    exit_code?: number
    stdout_contains?: string
    stdout_matches?: string
  }
  rationale?: string
}

export interface TaskGoalAuditEntry {
  at: string
  pass: boolean
  failed_criteria: string[]
  audit_trace_id: string
}

/** 挂在 Task.goal 上的子对象；不是独立资源，没有 id / owner_id（task_id 即所有权） */
export interface TaskGoal {
  objective: string
  acceptance_criteria: AcceptanceCriterion[]
  status: TaskGoalStatus
  tokens_used: number
  token_budget?: number
  audit_history: TaskGoalAuditEntry[]
  created_at: string
  updated_at: string
  completed_at?: string
}
