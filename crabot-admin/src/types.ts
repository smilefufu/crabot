/**
 * Admin 模块类型定义
 *
 * @see crabot-docs/protocols/protocol-admin.md
 */

import type { ModuleId, FriendId, PaginatedResult, PaginationParams, TaskId, ScheduleId, SessionId } from './core/base-protocol.js'

// ============================================================================
// Channel 身份
// ============================================================================

/**
 * Channel 身份 - 用于关联 Friend 和平台用户
 */
export interface ChannelIdentity {
  channel_id: ModuleId
  platform_user_id: string
  platform_display_name: string
}

// ============================================================================
// Friend（熟人）
// ============================================================================

export type FriendPermission = 'master' | 'normal'

/**
 * 熟人信息
 */
export interface Friend {
  id: FriendId
  display_name: string
  permission: FriendPermission
  /** 关联的权限模板 ID（normal 时必填） */
  permission_template_id?: string
  /** Channel 身份列表 */
  channel_identities: ChannelIdentity[]
  created_at: string
  updated_at: string
}

// ============================================================================
// PermissionTemplate（权限模板）
// ============================================================================

export interface PermissionTemplate {
  id: string
  name: string
  description?: string
  /** 是否为系统预设模板 */
  is_system: boolean
  /** 创建者（master 的 FriendId，系统模板为 null） */
  created_by?: FriendId
  desktop: boolean
  network: {
    mode: 'allow_all' | 'whitelist' | 'blacklist'
    rules: string[]
  }
  storage: Array<{
    path: string
    access: 'read' | 'readwrite'
  }>
  /** 该模板下可访问的 Memory scopes */
  memory_scopes: string[]
  created_at: string
  updated_at: string
}

// ============================================================================
// Session 权限配置
// ============================================================================

export interface SessionPermissionConfig {
  /** 桌面操作权限 */
  desktop: boolean
  /** 网络访问权限 */
  network: {
    mode: 'allow_all' | 'whitelist' | 'blacklist'
    rules: string[]
  }
  /** 存储访问权限 */
  storage: Array<{
    path: string
    access: 'read' | 'readwrite'
  }>
  /** Memory 访问作用域 */
  memory_scopes: string[]
  /** 使用的权限模板 ID */
  template_id?: string
  /** 最后更新时间 */
  updated_at: string
}

// ============================================================================
// PendingMessage（待授权消息）
// ============================================================================

/**
 * 待授权消息
 */
export interface PendingMessage {
  id: string
  /** 来源 Channel */
  channel_id: ModuleId
  /** 发信人在该 Channel 上的平台用户 ID */
  platform_user_id: string
  /** 发信人在该 Channel 上的显示名称 */
  platform_display_name: string
  /** 消息内容摘要 */
  content_preview: string
  /** 消息完整内容（JSON） */
  raw_message: ChannelMessageRef
  /** 申请意图：pair=申请成为 Master，apply=申请普通权限 */
  intent: 'pair' | 'apply'
  /** 消息接收时间 */
  received_at: string
  /** 过期时间 */
  expires_at: string
}

/**
 * ChannelMessage 最小引用类型（用于 PendingMessage 存储）
 * @see base-protocol.md §5.5
 */
export interface ChannelMessageRef {
  platform_message_id: string
  session: { session_id: string; channel_id: string; type: string }
  sender: { friend_id?: string; platform_user_id: string; platform_display_name: string }
  content: { type: string; text?: string; media_url?: string }
  features: { is_mention_crab: boolean }
  platform_timestamp: string
}

/**
 * upsert_pending_message 请求参数
 * @see protocol-admin.md §3.3.0
 */
export interface UpsertPendingMessageParams {
  channel_id: ModuleId
  platform_user_id: string
  platform_display_name: string
  content_preview: string
  raw_message: ChannelMessageRef
  /** 申请意图：pair=申请成为 Master，apply=申请普通权限 */
  intent: 'pair' | 'apply'
}

export interface UpsertPendingMessageResult {
  pending_message: PendingMessage
  created: boolean
}

// ============================================================================
// Admin 配置
// ============================================================================

export interface AdminConfig {
  /** Web 服务监听端口 */
  web_port: number
  /** 认证密码环境变量名 */
  password_env: string
  /** JWT secret 环境变量名 */
  jwt_secret_env: string
  /** JWT token 有效期（秒） */
  token_ttl: number
  /** 数据存储目录 */
  data_dir: string
}

export const DEFAULT_ADMIN_CONFIG: AdminConfig = {
  web_port: 3000,
  password_env: 'CRABOT_ADMIN_PASSWORD',
  jwt_secret_env: 'CRABOT_JWT_SECRET',
  token_ttl: 86400, // 24 hours
  data_dir: './data/admin',
}

// ============================================================================
// Admin API 参数类型
// ============================================================================

// Friend 管理
export interface ListFriendsParams extends PaginationParams {
  permission?: FriendPermission
  search?: string
}

export type ListFriendsResult = PaginatedResult<Friend>

export interface GetFriendParams {
  friend_id: FriendId
}

export interface GetFriendResult {
  friend: Friend
}

export interface CreateFriendParams {
  display_name: string
  permission: FriendPermission
  channel_identities?: ChannelIdentity[]
  permission_template_id?: string
}

export interface CreateFriendResult {
  friend: Friend
}

export interface UpdateFriendParams {
  friend_id: FriendId
  display_name?: string
  permission?: FriendPermission
  permission_template_id?: string
}

export interface UpdateFriendResult {
  friend: Friend
}

export interface DeleteFriendParams {
  friend_id: FriendId
}

export interface DeleteFriendResult {
  deleted: true
}

// Channel 身份绑定
export interface LinkChannelIdentityParams {
  friend_id: FriendId
  channel_identity: ChannelIdentity
}

export interface UnlinkChannelIdentityParams {
  friend_id: FriendId
  channel_id: ModuleId
  platform_user_id: string
}

// Friend 查询
export interface ResolveFriendParams {
  channel_id: ModuleId
  platform_user_id: string
}

export interface ResolveFriendResult {
  friend: Friend | null
}

// 认证
export interface LoginRequest {
  password: string
}

export interface LoginResponse {
  token: string
  expires_at: string
}

// ============================================================================
// Admin 错误码
// ============================================================================

export const AdminErrorCode = {
  INVALID_PASSWORD: 'ADMIN_INVALID_PASSWORD',
  MASTER_ALREADY_EXISTS: 'ADMIN_MASTER_ALREADY_EXISTS',
  CHANNEL_IDENTITY_IN_USE: 'ADMIN_CHANNEL_IDENTITY_IN_USE',
  CANNOT_DELETE_MASTER: 'ADMIN_CANNOT_DELETE_MASTER',
  SESSION_NOT_FOUND: 'ADMIN_SESSION_NOT_FOUND',
  CANNOT_MODIFY_SYSTEM_TEMPLATE: 'ADMIN_CANNOT_MODIFY_SYSTEM_TEMPLATE',
  CANNOT_DELETE_SYSTEM_TEMPLATE: 'ADMIN_CANNOT_DELETE_SYSTEM_TEMPLATE',
  TEMPLATE_IN_USE: 'ADMIN_TEMPLATE_IN_USE',
  // Task 相关错误码
  TASK_NOT_FOUND: 'ADMIN_TASK_NOT_FOUND',
  INVALID_STATUS_TRANSITION: 'ADMIN_INVALID_STATUS_TRANSITION',
  TASK_ALREADY_ASSIGNED: 'ADMIN_TASK_ALREADY_ASSIGNED',
  TASK_NOT_CANCELLABLE: 'ADMIN_TASK_NOT_CANCELLABLE',
  TASK_PLAN_UPDATE_FAILED: 'ADMIN_TASK_PLAN_UPDATE_FAILED',
  // Schedule 相关错误码
  SCHEDULE_NOT_FOUND: 'ADMIN_SCHEDULE_NOT_FOUND',
  INVALID_CRON_EXPRESSION: 'ADMIN_INVALID_CRON_EXPRESSION',
  SCHEDULE_ALREADY_EXISTS: 'ADMIN_SCHEDULE_ALREADY_EXISTS',
} as const

// ============================================================================
// Task（任务）
// ============================================================================

/** 任务状态 */
export type TaskStatus =
  | 'pending'
  | 'planning'
  | 'executing'
  | 'waiting_human'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** 任务类型 */
export type TaskType =
  | 'single'
  | 'conversation'
  | 'background'
  | 'scheduled'

/** 任务优先级 */
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent'

/** 计划步骤状态 */
export type PlanStepStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'skipped'

/** 任务来源 */
export interface TaskSource {
  /** 来源类型 */
  origin?: 'human' | 'system' | 'admin_chat'
  /** 来源 Channel 模块 ID */
  channel_id?: ModuleId
  /** 来源会话 ID */
  session_id?: SessionId
  /** 发起用户 */
  friend_id?: FriendId
  /** 触发类型 */
  trigger_type: 'manual' | 'scheduled' | 'auto' | 'event'
  /** Admin Chat 请求 ID（admin_chat 来源时） */
  chat_request_id?: string
  /** 来源模块 ID（admin_chat 来源时） */
  source_module_id?: ModuleId
}

/** 计划步骤 */
export interface PlanStep {
  /** 步骤 ID */
  id: string
  /** 步骤描述 */
  description: string
  /** 步骤状态 */
  status: PlanStepStatus
  /** 执行结果 */
  result?: string
  /** 开始时间 */
  started_at?: string
  /** 完成时间 */
  completed_at?: string
  /** 重试次数 */
  retry_count: number
}

/** 任务计划 */
export interface TaskPlan {
  /** 目标描述 */
  goal: string
  /** 计划步骤列表 */
  steps: PlanStep[]
  /** 当前步骤索引 */
  current_step_index: number
  /** 计划创建时间 */
  created_at: string
  /** 计划更新时间 */
  updated_at: string
}

/** 任务结果（Worker 完成/失败时写入） */
export interface TaskResult {
  /** 任务结局 */
  outcome: 'completed' | 'failed'
  /** 结果摘要（自然语言） */
  summary: string
  /** 最终回复内容 */
  final_reply?: { text: string }
  /** 完成/失败时间 */
  finished_at: string
}

/** 任务消息 */
export interface TaskMessage {
  /** 消息 ID */
  id: string
  /** 消息类型 */
  type: 'info' | 'warning' | 'error' | 'debug' | 'user_input' | 'agent_output'
  /** 消息内容 */
  content: string
  /** 时间戳 */
  timestamp: string
  /** 附加数据 */
  metadata?: Record<string, unknown>
}

/** 任务 */
export interface Task {
  /** 任务 ID */
  id: TaskId
  /** 任务类型 */
  type: TaskType
  /** 任务状态 */
  status: TaskStatus
  /** 优先级 */
  priority: TaskPriority
  /** 任务标题 */
  title: string
  /** 任务描述 */
  description?: string
  /** 任务来源 */
  source: TaskSource
  /** 分配的 Worker Agent 模块 ID */
  worker_agent_id?: ModuleId
  /** 任务计划 */
  plan?: TaskPlan
  /** 任务结果 */
  result?: TaskResult
  /** 任务输入 */
  input?: Record<string, unknown>
  /** 任务输出 */
  output?: Record<string, unknown>
  /** 错误信息 */
  error?: string
  /** 消息日志 */
  messages: TaskMessage[]
  /** 标签 */
  tags: string[]
  /** 创建时间 */
  created_at: string
  /** 更新时间 */
  updated_at: string
  /** 开始执行时间 */
  started_at?: string
  /** 完成时间 */
  completed_at?: string
  /** 过期时间 */
  expires_at?: string
}

// ============================================================================
// Schedule（调度）
// ============================================================================

/** 调度触发器类型 */
export type ScheduleTriggerType = 'cron' | 'interval' | 'once' | 'threshold'

/** 调度触发器 - Cron 表达式 */
export interface CronTrigger {
  type: 'cron'
  /** Cron 表达式 */
  expression: string
  /** 时区，默认 UTC */
  timezone?: string
}

/** 调度触发器 - 固定间隔 */
export interface IntervalTrigger {
  type: 'interval'
  /** 间隔秒数 */
  seconds: number
}

/** 调度触发器 - 一次性 */
export interface OnceTrigger {
  type: 'once'
  /** 执行时间 */
  execute_at: string
}

/** 调度触发器 - 阈值触发 */
export interface ThresholdTrigger {
  type: 'threshold'
  /** 触发条件描述 */
  condition: string
  /** 检查间隔秒数 */
  check_interval_seconds: number
}

/** 调度触发器联合类型 */
export type ScheduleTrigger = CronTrigger | IntervalTrigger | OnceTrigger | ThresholdTrigger

/** 调度任务模板 */
export interface ScheduleTaskTemplate {
  /** 任务类型 */
  type: TaskType
  /** 任务标题模板 */
  title: string
  /** 任务描述模板 */
  description?: string
  /** 优先级 */
  priority: TaskPriority
  /** 任务输入模板（支持变量替换） */
  input?: Record<string, unknown>
  /** 标签 */
  tags: string[]
}

/** 调度项 */
export interface Schedule {
  /** 调度项 ID */
  id: ScheduleId
  /** 调度项名称 */
  name: string
  /** 调度项描述 */
  description?: string
  /** 是否启用 */
  enabled: boolean
  /** 触发器配置 */
  trigger: ScheduleTrigger
  /** 任务模板 */
  task_template: ScheduleTaskTemplate
  /** 上次执行时间 */
  last_triggered_at?: string
  /** 下次执行时间 */
  next_trigger_at?: string
  /** 执行次数 */
  execution_count: number
  /** 最后创建的任务 ID */
  last_task_id?: TaskId
  /** 创建时间 */
  created_at: string
  /** 更新时间 */
  updated_at: string
}

// ============================================================================
// Task API 参数和返回类型
// ============================================================================

// 创建任务
export interface CreateTaskParams {
  type: TaskType
  priority?: TaskPriority
  title: string
  description?: string
  source: TaskSource
  input?: Record<string, unknown>
  tags?: string[]
  expires_at?: string
}

export interface CreateTaskResult {
  task: Task
}

// 获取任务
export interface GetTaskParams {
  task_id: TaskId
}

export interface GetTaskResult {
  task: Task
}

// 任务列表过滤条件
export interface TaskFilter {
  status?: TaskStatus | TaskStatus[]
  type?: TaskType | TaskType[]
  priority?: TaskPriority | TaskPriority[]
  worker_agent_id?: ModuleId
  source_channel_id?: ModuleId
  source_friend_id?: FriendId
  tags?: string[]
  search?: string
  created_after?: string
  created_before?: string
}

// 任务排序
export type TaskSortField = 'created_at' | 'updated_at' | 'priority' | 'status'
export type TaskSortOrder = 'asc' | 'desc'

export interface TaskSort {
  field: TaskSortField
  order: TaskSortOrder
}

// 任务列表
export interface ListTasksParams extends PaginationParams {
  filter?: TaskFilter
  sort?: TaskSort
}

export type ListTasksResult = PaginatedResult<Task>

// 更新任务状态
export interface UpdateTaskStatusParams {
  task_id: TaskId
  status: TaskStatus
  error?: string
  result?: TaskResult
}

export interface UpdateTaskStatusResult {
  task: Task
}

// 分配 Worker
export interface AssignWorkerParams {
  task_id: TaskId
  worker_agent_id: ModuleId
}

export interface AssignWorkerResult {
  task: Task
}

// 更新计划
export interface UpdatePlanParams {
  task_id: TaskId
  plan: TaskPlan
}

export interface UpdatePlanResult {
  task: Task
}

// 追加消息
export interface AppendMessageParams {
  task_id: TaskId
  type: TaskMessage['type']
  content: string
  metadata?: Record<string, unknown>
}

export interface AppendMessageResult {
  message: TaskMessage
}

// 获取任务消息
export interface GetTaskMessagesParams extends PaginationParams {
  task_id: TaskId
  type?: TaskMessage['type'][]
}

export type GetTaskMessagesResult = PaginatedResult<TaskMessage>

// 取消任务
export interface CancelTaskParams {
  task_id: TaskId
  reason?: string
}

export interface CancelTaskResult {
  task: Task
  cancelled: boolean
}

// 任务统计
export interface TaskStats {
  total: number
  by_status: Record<TaskStatus, number>
  by_type: Record<TaskType, number>
  by_priority: Record<TaskPriority, number>
}

// ============================================================================
// Schedule API 参数和返回类型
// ============================================================================

// 创建调度
export interface CreateScheduleParams {
  name: string
  description?: string
  enabled?: boolean
  trigger: ScheduleTrigger
  task_template: ScheduleTaskTemplate
}

export interface CreateScheduleResult {
  schedule: Schedule
}

// 获取调度
export interface GetScheduleParams {
  schedule_id: ScheduleId
}

export interface GetScheduleResult {
  schedule: Schedule
}

// 调度列表过滤
export interface ScheduleFilter {
  enabled?: boolean
  trigger_type?: ScheduleTriggerType
  search?: string
}

// 调度列表
export interface ListSchedulesParams extends PaginationParams {
  filter?: ScheduleFilter
}

export type ListSchedulesResult = PaginatedResult<Schedule>

// 更新调度
export interface UpdateScheduleParams {
  schedule_id: ScheduleId
  name?: string
  description?: string
  enabled?: boolean
  trigger?: ScheduleTrigger
  task_template?: ScheduleTaskTemplate
}

export interface UpdateScheduleResult {
  schedule: Schedule
}

// 删除调度
export interface DeleteScheduleParams {
  schedule_id: ScheduleId
}

export interface DeleteScheduleResult {
  deleted: true
}

// 立即触发
export interface TriggerNowParams {
  schedule_id: ScheduleId
}

export interface TriggerNowResult {
  task: Task
  schedule: Schedule
}

// ============================================================================
// Model Provider（模型供应商）
// ============================================================================

/** API 格式 */
export type ApiFormat = 'openai' | 'anthropic' | 'gemini'

/** 模型类型 */
export type ModelType = 'llm' | 'embedding'

/** 供应商状态 */
export type ProviderStatus = 'active' | 'inactive' | 'error'

/** 配置来源类型 */
export type ProviderConfigType = 'manual' | 'preset'

/**
 * 模型信息
 */
export interface ModelInfo {
  model_id: string
  display_name: string
  type: ModelType
  /** LLM: 是否支持视觉 */
  supports_vision?: boolean
  /** LLM: 上下文窗口大小（输入） */
  context_window?: number
  /** LLM: 最大输出 token 数（此值将传给 Anthropic SDK 的 max_tokens 参数，须与模型实际上限一致） */
  max_tokens?: number
  /** Embedding: 向量维度（自动探测） */
  dimension?: number
  description?: string
  tags?: string[]
}

/**
 * 模型供应商配置
 */
export interface ModelProvider {
  id: string
  name: string
  type: ProviderConfigType
  format: ApiFormat
  endpoint: string
  api_key: string
  /** 预置厂商标识 */
  preset_vendor?: string
  models: ModelInfo[]
  status: ProviderStatus
  last_validated_at?: string
  validation_error?: string
  /** LiteLLM 中的模型名 */
  litellm_model_name?: string
  /** LiteLLM 生成的访问密钥 */
  litellm_key?: string
  created_at: string
  updated_at: string
}

/**
 * 预置厂商定义
 */
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
  /** 不支持 /models API 的厂商，提供静态默认模型列表 */
  default_models?: ModelInfo[]
}

/**
 * 全局模型配置
 */
export interface GlobalModelConfig {
  default_llm_provider_id?: string
  default_llm_model_id?: string
  default_embedding_provider_id?: string
  default_embedding_model_id?: string
}

/**
 * 模块模型配置
 */
export interface ModuleModelConfig {
  module_id: string
  llm_provider_id?: string
  llm_model_id?: string
  embedding_provider_id?: string
  embedding_model_id?: string
}

/**
 * 模型连接信息基础类型（供其他模块使用）
 */
export interface ModelConnectionInfo {
  endpoint: string
  apikey: string
  model_id: string
  format: ApiFormat
  /** 供应商 ID（用于 LiteLLM 路由解析） */
  provider_id?: string
}

/**
 * LLM 连接信息
 */
export interface LLMConnectionInfo extends ModelConnectionInfo {
  max_tokens?: number
  supports_vision?: boolean
}

/**
 * Embedding 连接信息
 */
export interface EmbeddingConnectionInfo extends ModelConnectionInfo {
  dimension: number
}

/**
 * 验证结果
 */
export interface ValidationResult {
  success: boolean
  error?: string
  /** Embedding 探测到的维度 */
  dimension?: number
}

// Model Provider API 参数类型

export interface CreateModelProviderParams {
  name: string
  type: ProviderConfigType
  format: ApiFormat
  endpoint: string
  api_key: string
  preset_vendor?: string
  models: ModelInfo[]
}

export interface UpdateModelProviderParams {
  name?: string
  endpoint?: string
  api_key?: string
  models?: ModelInfo[]
  status?: ProviderStatus
}

export interface ImportFromVendorParams {
  vendor_id: string
  api_key: string
  /** 覆盖预置 vendor 的 endpoint（用于非本地部署，如远程 Ollama） */
  endpoint?: string
}

export interface ImportFromVendorResult {
  provider: ModelProvider
  models: ModelInfo[]
}

export interface ResolveModelConfigParams {
  module_id: string
  role: ModelType
}

// ============================================================================
// 运行时管理
// ============================================================================

/** 运行时类型 */
export type RuntimeType = 'nodejs' | 'python' | 'binary'

/** 运行时信息 */
export interface RuntimeInfo {
  type: RuntimeType
  version?: string
  available: boolean
  path?: string
}

/** 模块来源 */
export type ModuleSource =
  | { type: 'local'; path: string }
  | { type: 'git'; url: string; ref?: string }

/** 模块包信息（从 crabot-module.yaml 解析） */
export interface ModulePackageInfo {
  module_id: string
  module_type: 'agent' | 'channel'
  protocol_version: string
  name: string
  version: string
  description?: string
  author?: string
  license?: string
  runtime: {
    type: RuntimeType
    version?: string
  }
  entry: string
  install?: string
  build?: string
  env?: Record<string, string>
  agent?: {
    engine: AgentEngine
    supported_roles: AgentRole[]
    model_format: ModelFormat
    model_roles: ModelRoleDefinition[]
  }
}

/** 安装选项 */
export interface InstallOptions {
  overwrite?: boolean
  timeout?: number
}

// ============================================================================
// Agent 实现与实例管理
// ============================================================================

/** Agent 实现类型 */
export type AgentImplementationType = 'config_only' | 'full_code'

/** Agent 引擎类型 */
export type AgentEngine = 'claude-agent-sdk' | 'pydantic-ai' | 'custom'

/** Agent 角色（仅用于 Implementation 描述能力，不暴露到实例层） */
export type AgentRole = 'front' | 'worker'

/** 模型格式 */
export type ModelFormat = 'openai' | 'anthropic' | 'gemini'

/** 模型角色定义 */
export interface ModelRoleDefinition {
  /** 角色键 */
  key: string
  /** 角色描述 */
  description: string
  /** 是否必需 */
  required: boolean
  /** 推荐能力 */
  recommended_capabilities?: string[]
  /** 被哪些 Agent 角色使用 */
  used_by?: Array<'front' | 'worker'>
}

/** Agent 实现（已安装的包） */
export interface AgentImplementation {
  /** 实现 ID */
  id: string
  /** 实现名称 */
  name: string
  /** 实现类型 */
  type: 'builtin' | 'installed'
  /** 实现方式 */
  implementation_type: AgentImplementationType
  /** 引擎类型 */
  engine: AgentEngine
  /** 支持的角色 */
  supported_roles: AgentRole[]
  /** 模型格式 */
  model_format: ModelFormat
  /** 模型角色定义 */
  model_roles: ModelRoleDefinition[]
  /** 安装来源 */
  source?: {
    type: 'local' | 'git'
    path: string
    ref?: string
  }
  /** 安装路径 */
  installed_path?: string
  /** 版本 */
  version?: string
  /** 安装时间 */
  installed_at?: string
  /** 创建时间 */
  created_at: string
  /** 更新时间 */
  updated_at: string
}

/** Agent 实例 */
export interface AgentInstance {
  /** 实例 ID（同时也是 module_id） */
  id: string
  /** 关联的实现 ID */
  implementation_id: string
  /** 实例名称 */
  name: string
  /** 专长描述 */
  specialization: string
  /** 支持的任务类型（Worker 角色） */
  supported_task_types?: TaskType[]
  /** 最大并发任务数 */
  max_concurrent_tasks?: number
  /** 是否自动启动 */
  auto_start: boolean
  /** 启动优先级 */
  start_priority: number
  /** 是否已注册到 Module Manager */
  module_registered: boolean
  /** 分配的端口 */
  module_port?: number
  /** 创建时间 */
  created_at: string
  /** 更新时间 */
  updated_at: string
}

/**
 * MCP Server 配置（发送给 Agent 时使用，字段与注册表条目对齐）
 * 注册表管理见 mcp-skill-manager.ts 的 MCPServerRegistryEntry
 */
export interface MCPServerConfig {
  /** MCP Server ID */
  id: string
  /** 名称 */
  name: string
  /** 传输类型 */
  transport: 'stdio' | 'streamable-http' | 'sse'
  /** 启动命令（stdio） */
  command?: string
  /** 命令参数（stdio） */
  args?: string[]
  /** 环境变量（stdio） */
  env?: Record<string, string>
  /** 服务端 URL（streamable-http / sse） */
  url?: string
  /** 请求头（streamable-http / sse） */
  headers?: Record<string, string>
  /** 描述 */
  description?: string
}

/**
 * Skill 配置（发送给 Agent 时使用，字段与注册表条目对齐）
 * 注册表管理见 mcp-skill-manager.ts 的 SkillRegistryEntry
 */
export interface SkillConfig {
  /** Skill ID */
  id: string
  /** 名称 */
  name: string
  /** 内容 */
  content: string
  /** 描述 */
  description?: string
}

/** 模型 slot 引用（存储格式：只存 provider_id + model_id，运行时由 Admin 实时解析为连接信息） */
export interface ModelSlotRef {
  provider_id: string
  model_id: string
}

/** Agent 实例配置（存储格式：引用注册表 ID） */
export interface AgentInstanceConfig {
  /** 实例 ID */
  instance_id: string
  /** 系统提示词 */
  system_prompt: string
  /** 模型配置（按角色键索引，值为 ModelSlotRef 引用） */
  model_config: Record<string, ModelSlotRef>
  /** 关联的 MCP Server ID 列表（存储格式，引用全局 MCP 注册表） */
  mcp_server_ids?: string[]
  /** 关联的 Skill ID 列表（存储格式，引用全局 Skill 注册表） */
  skill_ids?: string[]
  /** 解析后的 MCP Server 完整配置（发给 Agent 时填充，不存储） */
  mcp_servers?: MCPServerConfig[]
  /** 解析后的 Skill 完整配置（发给 Agent 时填充，不存储） */
  skills?: SkillConfig[]
  /** 最大迭代次数（Front 默认 3，Worker 无限制） */
  max_iterations?: number
  /** 工具是否只读（Front 默认 true） */
  tools_readonly?: boolean
}

/** Agent 实例配置的解析后格式（RPC 返回给 Agent，model_config 已从引用解析为连接信息） */
export interface ResolvedAgentConfig extends Omit<AgentInstanceConfig, 'model_config'> {
  model_config: Record<string, LLMConnectionInfo>
}

// Agent 实现管理 API 参数类型

export interface ListAgentImplementationsParams extends PaginationParams {
  type?: 'builtin' | 'installed'
  engine?: AgentEngine
}

export type ListAgentImplementationsResult = PaginatedResult<AgentImplementation>

export interface GetAgentImplementationParams {
  implementation_id: string
}

export interface GetAgentImplementationResult {
  implementation: AgentImplementation
}

// Agent 实例管理 API 参数类型

export interface ListAgentInstancesParams extends PaginationParams {
  implementation_id?: string
  auto_start?: boolean
}

export type ListAgentInstancesResult = PaginatedResult<AgentInstance>

export interface GetAgentInstanceParams {
  instance_id: string
}

export interface GetAgentInstanceResult {
  instance: AgentInstance
}

export interface CreateAgentInstanceParams {
  implementation_id: string
  name: string
  specialization: string
  supported_task_types?: TaskType[]
  max_concurrent_tasks?: number
  auto_start?: boolean
  start_priority?: number
}

export interface CreateAgentInstanceResult {
  instance: AgentInstance
}

export interface UpdateAgentInstanceParams {
  instance_id: string
  name?: string
  specialization?: string
  supported_task_types?: TaskType[]
  max_concurrent_tasks?: number
  auto_start?: boolean
  start_priority?: number
}

export interface UpdateAgentInstanceResult {
  instance: AgentInstance
}

export interface DeleteAgentInstanceParams {
  instance_id: string
}

export interface DeleteAgentInstanceResult {
  deleted: true
}

// Agent 配置管理 API 参数类型

export interface GetAgentConfigParams {
  instance_id: string
}

export interface GetAgentConfigResult {
  config: AgentInstanceConfig
}

export interface UpdateAgentConfigParams {
  instance_id: string
  system_prompt?: string
  model_config?: Record<string, ModelSlotRef>
  mcp_server_ids?: string[]
  skill_ids?: string[]
  max_iterations?: number
  tools_readonly?: boolean
}

export interface UpdateAgentConfigResult {
  config: AgentInstanceConfig
}

// ============================================================================
// 模块安装 API 参数类型
// ============================================================================

export interface PreviewModulePackageParams {
  source: ModuleSource
}

export interface PreviewModulePackageResult {
  package_info: ModulePackageInfo
}

export interface InstallModuleParams {
  source: ModuleSource
  overwrite?: boolean
}

export interface InstallModuleResult {
  implementation: AgentImplementation
}

export interface UninstallModuleParams {
  implementation_id: string
}

export interface UninstallModuleResult {
  deleted: true
}

// ============================================================================
// Admin 事件类型
// ============================================================================

/** Admin 事件 Payload 类型映射 */
export interface AdminEventPayloads {
  'admin.task_created': { task: Task }
  'admin.task_status_changed': { task_id: TaskId; old_status: TaskStatus; new_status: TaskStatus }
  'admin.task_assigned': { task_id: TaskId; worker_agent_id: ModuleId }
  'admin.task_plan_updated': { task_id: TaskId; plan: TaskPlan }
  'admin.task_cancelled': { task_id: TaskId; reason?: string }
  'admin.schedule_created': { schedule: Schedule }
  'admin.schedule_updated': { schedule: Schedule }
  'admin.schedule_deleted': { schedule_id: ScheduleId }
  'admin.schedule_triggered': { schedule: Schedule; task: Task }
  'admin.model_provider_created': { provider: ModelProvider }
  'admin.model_provider_updated': { provider: ModelProvider }
  'admin.model_provider_deleted': { provider_id: string }
  'admin.agent_implementation_installed': { implementation: AgentImplementation }
  'admin.agent_implementation_uninstalled': { implementation_id: string }
  'admin.agent_instance_created': { instance: AgentInstance }
  'admin.agent_instance_updated': { instance: AgentInstance }
  'admin.agent_instance_deleted': { instance_id: string }
  'admin.agent_instance_config_updated': { instance_id: string; config: AgentInstanceConfig }
  'admin.channel_instance_created': { instance: ChannelInstance }
  'admin.channel_instance_updated': { instance: ChannelInstance }
  'admin.channel_instance_deleted': { instance_id: string }
  'admin.channel_instance_config_updated': { instance_id: string; config: ChannelConfig }
}

// ============================================================================
// Master Chat（管理员聊天）
// ============================================================================

/** 聊天消息 */
export interface ChatMessage {
  message_id: string
  role: 'user' | 'assistant'
  content: string
  request_id?: string
  task_id?: TaskId
  timestamp: string
}

/** 客户端发送的聊天消息 */
export interface ChatClientMessage {
  type: 'chat_message'
  request_id: string
  content: string
}

/** 服务端发送的聊天消息 */
export interface ChatServerMessage {
  type: 'chat_reply' | 'chat_status' | 'chat_error'
  request_id?: string
  content?: string
  status?: 'processing' | 'completed' | 'failed'
  task_id?: TaskId
  reply_type?: 'direct_reply' | 'task_created' | 'task_completed' | 'task_failed'
  error?: string
}

/** chat_callback RPC 方法参数 */
export interface ChatCallbackParams {
  request_id: string
  reply_type: 'direct_reply' | 'task_created' | 'task_completed' | 'task_failed'
  content: string
  task_id?: TaskId
}

/** chat_callback RPC 方法返回 */
export interface ChatCallbackResult {
  received: true
}

/** get_chat_history RPC 方法参数 */
export interface GetChatHistoryParams {
  /** 返回数量上限，默认 20 */
  limit?: number
  /** 时间截止点（不含），用于分页 */
  before?: string
}

/** get_chat_history RPC 方法返回（ChannelMessage 兼容格式） */
export interface GetChatHistoryResult {
  /** 按 platform_timestamp 正序（最旧在前）排列 */
  messages: Array<{
    platform_message_id: string
    session: { session_id: string; channel_id: string; type: 'private' }
    sender: { friend_id?: string; platform_user_id: string; platform_display_name: string }
    content: { type: 'text'; text: string }
    features: { is_mention_crab: false }
    platform_timestamp: string
  }>
}

// ============================================================================
// LiteLLM 类型定义
// ============================================================================

/**
 * LiteLLM 模型配置
 */
export interface LiteLLMModelConfig {
  model_name: string
  litellm_params: {
    model: string
    api_key: string
    api_base?: string
  }
}

/**
 * LiteLLM 客户端配置
 */
export interface LiteLLMClientConfig {
  baseUrl: string
  masterKey: string
}

/**
 * LiteLLM 密钥生成参数
 */
export interface LiteLLMGenerateKeyParams {
  models: string[]
  key_alias?: string
  max_budget?: number
}

/**
 * LiteLLM 密钥信息
 */
export interface LiteLLMKeyInfo {
  key: string
  key_alias?: string
  models: string[]
  max_budget?: number
}

/**
 * LiteLLM 模型信息
 */
export interface LiteLLMModelInfo {
  model_name: string
  litellm_params: {
    model: string
    api_key?: string
    api_base?: string
  }
}

// ============================================================================
// Channel 管理类型定义
// ============================================================================

/**
 * Channel 实现
 */
export interface ChannelImplementation {
  id: string
  name: string
  type: 'builtin' | 'installed'
  platform: string
  module_path?: string // builtin 类型使用
  installed_path?: string // installed 类型使用
  version: string
  /** 配置 JSON Schema（来自 crabot-module.yaml config_schema），供 Admin UI 动态渲染表单 */
  config_schema?: Record<string, unknown>
  created_at: string
  updated_at: string
}

/**
 * Channel 实例
 */
export interface ChannelInstance {
  id: string
  implementation_id: string
  name: string
  platform: string
  /** channel-host 实例必须，指向 OpenClaw 插件安装目录 */
  state_dir?: string
  auto_start: boolean
  start_priority: number
  module_registered: boolean
  created_at: string
  updated_at: string
}

/**
 * Channel 配置（从 Channel 模块的 get_config 获取）
 */
export interface ChannelConfig {
  platform: string
  credentials: Record<string, string>
  cache?: Record<string, any>
  group?: Record<string, any>
  [key: string]: any
}

/**
 * 列出 Channel 实现参数
 */
export interface ListChannelImplementationsParams {
  type?: 'builtin' | 'installed'
  platform?: string
  page?: number
  page_size?: number
}

/**
 * 列出 Channel 实例参数
 */
export interface ListChannelInstancesParams {
  platform?: string
  page?: number
  page_size?: number
}

/**
 * 创建 Channel 实例参数
 */
export interface CreateChannelInstanceParams {
  implementation_id: string
  name: string
  platform?: string
  state_dir?: string
  auto_start?: boolean
  /** 模块启动环境变量（如 WECHAT_CONNECTOR_URL），保存到 channel-configs/<id>.json */
  env?: Record<string, string>
}

/**
 * 更新 Channel 实例参数
 */
export interface UpdateChannelInstanceParams {
  instance_id: string
  name?: string
  auto_start?: boolean
}

/**
 * 更新 Channel 配置参数
 */
export interface UpdateChannelConfigParams {
  instance_id: string
  config: Partial<ChannelConfig>
}

/**
 * state_dir 扫描结果 - 检测已安装的 OpenClaw 插件
 */
export interface ScannedPlugin {
  name: string        // 插件名，如 openclaw-lark 或 @openclaw/feishu
  platform: string    // 平台，如 feishu
  entry_path: string  // 入口文件路径（向导安装时为空）
}

export interface ScanResult {
  plugins: ScannedPlugin[]
  has_config: boolean
}

// ============================================================================
// Memory 管理类型
// ============================================================================

/** Memory 模块信息 */
export interface MemoryModuleInfo {
  module_id: string
  port: number
  name: string
}

/** Memory 来源信息 */
export interface MemorySourceInfo {
  type: 'conversation' | 'reflection' | 'manual' | 'system'
  task_id?: string
  channel_id?: string
  session_id?: string
  original_time?: string
}

/** 短期记忆条目（对应协议 ShortTermMemoryEntry） */
export interface ShortTermMemoryEntry {
  id: string
  content: string
  keywords: string[]
  event_time: string
  persons: string[]
  entities: string[]
  topic?: string
  source: MemorySourceInfo
  refs?: Record<string, string>
  compressed: boolean
  visibility: 'private' | 'internal' | 'public'
  scopes: string[]
  created_at: string
}

/** 实体引用 */
export interface EntityRef {
  type: string
  id: string
  name: string
}

/** 长期记忆条目 */
export interface LongTermMemoryEntry {
  id: string
  category: string
  abstract: string
  overview: string
  content: string
  entities: EntityRef[]
  importance: number
  keywords: string[]
  tags: string[]
  source: MemorySourceInfo
  metadata?: Record<string, unknown>
  read_count: number
  version: number
  visibility: 'private' | 'internal' | 'public'
  scopes: string[]
  created_at: string
  updated_at: string
}

/** Memory 统计 */
export interface MemoryStats {
  short_term: {
    entry_count: number
    compressed_count: number
    total_tokens: number
    latest_entry_at: string | null
    earliest_entry_at: string | null
  }
  long_term: {
    entry_count: number
    by_category: Record<string, number>
    total_tokens: number
    latest_entry_at: string | null
    earliest_entry_at: string | null
  }
}

