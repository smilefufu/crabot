/**
 * Admin 模块类型定义
 *
 * @see crabot-docs/protocols/protocol-admin.md
 */

import type { ModuleId, FriendId, PaginatedResult, PaginationParams, TaskId, ScheduleId, SessionId, ProxyConfig } from 'crabot-shared'

export type { ProxyConfig }

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
// 权限配置类型
// ============================================================================

/** 工具类别 */
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

/** 工具访问配置（按类别控制） */
export interface ToolAccessConfig {
  memory: boolean
  messaging: boolean
  task: boolean
  mcp_skill: boolean
  file_io: boolean
  browser: boolean
  shell: boolean
  remote_exec: boolean
  /** 桌面控制：键盘、鼠标、截屏等 OS 级操作（computer-use 类工具）。仅 master_private 模板可开启 */
  desktop: boolean
}

/** 存储权限 */
export interface StoragePermission {
  workspace_path: string
  access: 'read' | 'readwrite'
}

/** 所有工具类别的键列表（用于遍历和验证） */
export const TOOL_CATEGORIES: readonly ToolCategory[] = [
  'memory', 'messaging', 'task', 'mcp_skill', 'file_io', 'browser', 'shell', 'remote_exec', 'desktop',
] as const

/** 创建一个所有类别都为指定值的 ToolAccessConfig */
export function createToolAccessConfig(defaultValue: boolean): ToolAccessConfig {
  return {
    memory: defaultValue,
    messaging: defaultValue,
    task: defaultValue,
    mcp_skill: defaultValue,
    file_io: defaultValue,
    browser: defaultValue,
    shell: defaultValue,
    remote_exec: defaultValue,
    desktop: defaultValue,
  }
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

// ============================================================================
// PermissionTemplate（权限模板）
// ============================================================================

export interface PermissionTemplate {
  id: string
  name: string
  description?: string
  is_system: boolean
  created_by?: FriendId
  tool_access: ToolAccessConfig
  cli_access: CliAccessConfig
  storage: StoragePermission | null
  memory_scopes: string[]
  created_at: string
  updated_at: string
}

// ============================================================================
// Session 权限配置
// ============================================================================

export interface SessionPermissionConfig {
  tool_access?: Partial<ToolAccessConfig>
  cli_access?: CliAccessConfig
  storage?: StoragePermission | null
  memory_scopes?: string[]
  template_id?: string
  updated_at: string
}

export interface FriendPermissionConfig {
  tool_access: ToolAccessConfig
  cli_access: CliAccessConfig
  storage: StoragePermission | null
  memory_scopes: string[]
  updated_at: string
}

/** 合并后的权限（模板 + Session 覆盖） */
export interface ResolvedPermissions {
  tool_access: ToolAccessConfig
  cli_access: CliAccessConfig
  storage: StoragePermission | null
  memory_scopes: string[]
}

export interface GetFriendPermissionResult {
  config: FriendPermissionConfig | null
  resolved: ResolvedPermissions | null
}

export interface UpdateFriendPermissionBody {
  config: Omit<FriendPermissionConfig, 'updated_at'>
}

// ============================================================================
// 解析"消息发起人"的 effective permissions（friend ∪ session 并集）
// ============================================================================

export interface ResolvePrincipalPermissionsParams {
  /** 发送者 friend ID（无 friend_id 时不传）*/
  sender_friend_id?: FriendId
  session_id: SessionId
  session_type: 'private' | 'group'
}

export interface ResolvePrincipalPermissionsResult {
  resolved: ResolvedPermissions
  /** 解析时使用的来源信息，便于 audit 与调试 */
  sources: {
    friend_template_id?: string
    session_template_id?: string
    fallback?: 'minimal'
  }
}

// ============================================================================
// Dialog Object（对话对象）读模型
// ============================================================================

export type DialogObjectFriendStatus = 'active' | 'no_channel'

export interface DialogObjectFriend {
  id: FriendId
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
  channel_id: ModuleId
  platform_user_id: string
  platform_display_name: string
  content_preview: string
  source_session_id: SessionId
  received_at: string
  expires_at: string
}

export interface DialogObjectChannelSessionParticipant {
  friend_id?: FriendId
  platform_user_id: string
  role: 'owner' | 'admin' | 'member'
}

export interface DialogObjectChannelSession {
  id: SessionId
  channel_id: ModuleId
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

export interface ListDialogObjectFriendsResult {
  items: DialogObjectFriend[]
}

export interface ListDialogObjectApplicationsResult {
  items: DialogObjectApplication[]
}

export interface ListDialogObjectPrivatePoolResult {
  items: DialogObjectPrivatePoolEntry[]
}

export interface ListDialogObjectGroupsResult {
  items: DialogObjectGroupEntry[]
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
  /**
   * @deprecated 自 2026-06-08 起密码迁出 .env，改存 credentials.json。
   * 字段保留一个发布周期以防外部模块读取。
   */
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
  is_temp: boolean
}

export interface ChangePasswordRequest {
  old_password?: string
  new_password: string
}

export interface MeResponse {
  is_temp: boolean
}

// PermissionTemplate 管理
export interface ListPermissionTemplatesParams extends PaginationParams {
  system_only?: boolean
}

export type ListPermissionTemplatesResult = PaginatedResult<PermissionTemplate>

export interface GetPermissionTemplateParams {
  template_id: string
}

export interface GetPermissionTemplateResult {
  template: PermissionTemplate
}

export interface CreatePermissionTemplateParams {
  name: string
  description?: string
  tool_access: ToolAccessConfig
  cli_access?: CliAccessConfig
  storage?: StoragePermission | null
  memory_scopes?: string[]
}

export interface CreatePermissionTemplateResult {
  template: PermissionTemplate
}

export interface UpdatePermissionTemplateParams {
  template_id: string
  name?: string
  description?: string
  tool_access?: ToolAccessConfig
  cli_access?: CliAccessConfig
  storage?: StoragePermission | null
  memory_scopes?: string[]
}

export interface UpdatePermissionTemplateResult {
  template: PermissionTemplate
}

export interface DeletePermissionTemplateParams {
  template_id: string
}

export interface DeletePermissionTemplateResult {
  deleted: true
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
  TASK_ALREADY_EXISTS: 'ADMIN_TASK_ALREADY_EXISTS',
  INVALID_STATUS_TRANSITION: 'ADMIN_INVALID_STATUS_TRANSITION',
  TASK_ALREADY_ASSIGNED: 'ADMIN_TASK_ALREADY_ASSIGNED',
  TASK_NOT_CANCELLABLE: 'ADMIN_TASK_NOT_CANCELLABLE',
  TASK_PLAN_UPDATE_FAILED: 'ADMIN_TASK_PLAN_UPDATE_FAILED',
  // Schedule 相关错误码
  SCHEDULE_NOT_FOUND: 'ADMIN_SCHEDULE_NOT_FOUND',
  INVALID_CRON_EXPRESSION: 'ADMIN_INVALID_CRON_EXPRESSION',
  SCHEDULE_ALREADY_EXISTS: 'ADMIN_SCHEDULE_ALREADY_EXISTS',
  // Password 相关错误码
  INVALID_OLD_PASSWORD: 'ADMIN_INVALID_OLD_PASSWORD',
  OLD_PASSWORD_REQUIRED: 'ADMIN_OLD_PASSWORD_REQUIRED',
  SERVER_NOT_INITIALIZED: 'ADMIN_SERVER_NOT_INITIALIZED',
  TOKEN_REVOKED: 'ADMIN_TOKEN_REVOKED',
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
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'

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
  trigger_type: 'manual' | 'scheduled' | 'auto' | 'event' | 'message'
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
  /** 结果摘要（自然语言）—— @deprecated 由 outcome_brief 替代，仅为向后兼容保留 */
  summary?: string
  /** 最终回复内容 —— @deprecated worker 现已主动 send_message，本字段不再写入 */
  final_reply?: { text: string }
  /** 完成/失败时间 */
  finished_at: string
  /** 结构化反思：本次任务做了什么、是否顺利（≤200 字） */
  outcome_brief?: string
  /** 结构化反思：过程中的异常 / 兜底切换 / 关键决策（最多 3 条，每条 ≤80 字） */
  process_highlights?: string[]
}

/**
 * Task 维度的人机对话流真值记录。
 *
 * spec 2026-06-09-task-trace-tool-unification.md §4.2 定义。
 * - role='human': dispatcher 收到 IM 消息且决策出 trigger_task / supplement 时 push（reply / silent / forward_to_existing 不写）
 * - role='agent': 由 spec 2026-06-07-goal-audit-async-buffered-info-design.md §4.13.6 的 dispatch 钩子点（invariant #1+#2）统一驱动；
 *   真正 flush 到 channel 成功后才追加；audit fail drop / dispatch fail 等场景均不追加
 *
 * find_task 工具的 search 在 messages[].content 上匹配，是"按聊天细节词查找已结束 task"的命中字段。
 */
export interface TaskMessage {
  /** 消息 ID */
  id: string
  /** 消息角色 */
  role: 'human' | 'agent'
  /** 消息内容（纯文本；非文本消息由调用方序列化为可读字符串） */
  content: string
  /** 时间戳 ISO 8601 */
  timestamp: string
  /** 平台来源（用于 quote / 引用回溯） */
  source?: {
    channel_id?: ModuleId
    session_id?: SessionId
    friend_id?: FriendId
    /** 平台原 msg_id；agent 出站时为 sendMessage 返回的 platform_message_id */
    platform_message_id?: string
  }
  /** role='agent' 时的 send_message intent。其他 role 此字段 undefined */
  agent_intent?: 'info' | 'ask_human'
}

/** 任务 */
export interface Task {
  /** 任务 ID */
  id: TaskId
  /** 任务状态 */
  status: TaskStatus
  /** 优先级 */
  priority: TaskPriority
  /** 任务标题 */
  title: string
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
  /**
   * worker 在 status='waiting_human' 时记录"正在等人类回答什么"。
   * 仅当 status=waiting_human 时有值；切回 executing 时由 handleUpdateTaskStatus 自动清空。
   * 给 Front 注入 active_tasks 时用，作为 supplement 判断的事实参考。
   */
  pending_question?: string
  /**
   * 切到 status='waiting_human' 的时间戳。仅 status=waiting_human 时有值。
   * 用于 admin 超时调度器判定 24h 兜底切 failed；切回 executing 或终态时清空。
   * 区别于 updated_at——updated_at 会被任何字段改动重置，不可靠。
   */
  waiting_human_at?: string
  /**
   * 切到 status='waiting' 的时间戳。仅 status=waiting 时有值。
   * worker loop 退出、异步子 agent 仍在跑时写入；子 agent 完成通知到达、loop 重入时清空。
   */
  waiting_at?: string
  /**
   * Per-task goal（spec: 2026-05-23-goal-mode-design.md §3）。
   * 由 agent 在动手前调 set_task_goal 写入；不存在表示这是简单 task，audit gate 透明放行。
   * 一旦写入，进入"重流程"模式：worker todo + audit gate 全部生效。
   */
  goal?: TaskGoal
}

// ============================================================================
// Schedule（调度）
// ============================================================================

/** 调度触发器类型 */
export type ScheduleTriggerType = 'cron' | 'interval' | 'once'

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

/** 调度触发器联合类型 */
export type ScheduleTrigger = CronTrigger | IntervalTrigger | OnceTrigger

/** 调度任务模板 */
export interface ScheduleTaskTemplate {
  /** 任务类型，如 'daily_reflection'（用于 trace 过滤） */
  type?: string
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

/**
 * Schedule 触发的 task 的目标会话。
 *
 * - 已配置：worker 系统提示词指引"按此目标 session 发送结果"；trigger_message.session 填此目标
 * - 未配置：trigger_message.session 填 SYSTEM_SESSION 哨兵；worker 按 description 文本
 *   指引自行决定是否汇报、汇报到哪
 */
export interface ScheduleTargetSession {
  channel_id: ModuleId
  session_id: SessionId
  type: 'private' | 'group'
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
  /** 是否为系统内置（不可删除） */
  is_builtin?: boolean
  /**
   * 创建者 Friend ID。
   * - 用户创建：填写当前调用者对应的 Friend；触发时 task 沿用此 friend 的权限模板。
   * - 系统内置（is_builtin=true）：留空，触发时按 master 等价的最高权限运行。
   */
  creator_friend_id?: FriendId
  /** 创建时间 */
  created_at: string
  /** 更新时间 */
  updated_at: string
  /** 反思水位 — 上次成功覆盖到的时间点（ISO 8601），完成时推进 */
  watermark?: string
  /**
   * 该 schedule 触发的 task 的目标会话（可选）。
   * 见 ScheduleTargetSession 文档。
   * 历史 schedule 通过启动迁移从 task_template.input.target_channel_id/_session_id 自动迁移。
   */
  target_session?: ScheduleTargetSession
}

// ============================================================================
// Task API 参数和返回类型
// ============================================================================

// 创建任务
export interface CreateTaskParams {
  /** 可选的 task_id；若 caller 自带 id（如 trigger 超期注册），admin 直接用之；
   *  不传走 admin 自身的 generateId()。若 admin 已存在同 id 则报 TASK_ALREADY_EXISTS。 */
  id?: string
  priority?: TaskPriority
  title: string
  source: TaskSource
  input?: Record<string, unknown>
  tags?: string[]
  expires_at?: string
  /**
   * 创建 task 同时写入 messages[0]（"启动指令" / 首条对话）。
   *
   * spec 2026-06-09-task-trace-tool-unification.md §4.2：统一 task 创建路径的对话首条入口。
   * 旧的 task.description 字段已删，所有 caller（dispatcher trigger_task / recovery / schedule cron）
   * 用本字段携带"agent 启动时该看的指令"。admin handleCreateTask 把它转成 messages[0]。
   */
  initial_message?: {
    content: string
    /** 默认 'human' */
    role?: TaskMessage['role']
    source?: TaskMessage['source']
  }
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
  priority?: TaskPriority | TaskPriority[]
  worker_agent_id?: ModuleId
  source_channel_id?: ModuleId
  source_session_id?: SessionId
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

// ============================================================================
// Conversation Units —— spec 2026-06-09-task-trace-tool-unification.md §4.3
// ============================================================================
// Admin UI 主列表的混合渲染单元：task 维度 + 孤儿 dispatcher trace 按时间合并。
// 替代旧的 TraceTable grouped/flat 模式。后端原生分页（task.created_at / trace.started_at
// 作为统一时间字段）。

/** Admin 视角下的 trace 元数据子集（agent 模块 TraceIndexEntry 的简化版）。 */
export interface TraceSummary {
  trace_id: string
  related_task_id?: string
  trigger_type: string // 'message' | 'task' | 'sub_agent_call' | ...
  trigger_summary: string
  started_at: string
  ended_at?: string
  duration_ms?: number
  status: 'running' | 'completed' | 'failed'
  outcome_summary?: string
}

/**
 * 对话单元 —— 主列表的一行 = 一个 task 或一条孤儿 dispatcher trace。
 *
 * 孤儿 dispatcher = trigger_type='message' 且 related_task_id 为空（即 dispatcher 决策为
 * reply / silent / forward_to_existing 等不创建 task 的动作）。
 */
export type ConversationUnit =
  | {
      kind: 'task'
      task: Task
      /** 含 dispatcher + worker + subagents trace 总数（lazy load tree 时再拉完整） */
      trace_count: number
      /** 主 worker trace_id；无 worker 时为 null */
      worker_trace_id: string | null
    }
  | {
      kind: 'orphan_dispatcher'
      trace: TraceSummary
    }

export interface ListConversationUnitsParams extends PaginationParams {
  filter?: TaskFilter & {
    /** 仅看 task / 仅看孤儿 dispatcher / 全部（默认 all） */
    trigger_type?: 'message' | 'task' | 'all'
  }
  sort?: {
    field: 'created_at' | 'updated_at'
    order: 'asc' | 'desc'
  }
}

export type ListConversationUnitsResult = PaginatedResult<ConversationUnit>

// ============================================================================
// Cleanup by task count（spec §4.4）
// ============================================================================

export interface CleanupOldTasksByCountParams {
  /** 保留最近 N 个终态 task（status ∈ {completed, failed, cancelled}）。活跃 task 不计入配额 */
  max_count: number
  /** 默认 false 真删；true 试运行只统计 */
  dry_run?: boolean
}

export interface CleanupOldTasksByCountResult {
  affected_count: number
  affected_bytes: number
  deleted_trace_ids: string[]
}

// 更新任务状态
export interface UpdateTaskStatusParams {
  task_id: TaskId
  status: TaskStatus
  error?: string
  result?: TaskResult
  /**
   * 仅在 status='waiting_human' 时有意义。worker 调 send_message(intent='ask_human') 时
   * 通过该字段写入"正在等的问题"。切回 executing 时调用方传 null 显式清空（也可不传，handler 自动清）。
   */
  pending_question?: string | null
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
  role: TaskMessage['role']
  content: string
  source?: TaskMessage['source']
  agent_intent?: TaskMessage['agent_intent']
}

export interface AppendMessageResult {
  message: TaskMessage
}

// 获取任务消息
export interface GetTaskMessagesParams extends PaginationParams {
  task_id: TaskId
  role?: TaskMessage['role'][]
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
  /**
   * 创建者 Friend ID。
   * - 用户/CLI 调用必须传：触发时 task 沿用该 friend 的权限。
   * - 系统内置 seed 流程不经过此入口；外部调用方留空时按系统级处理（最高权限）。
   */
  creator_friend_id?: FriendId
  /** 目标会话（可选）。详见 ScheduleTargetSession。 */
  target_session?: ScheduleTargetSession
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
  /**
   * 目标会话。
   * - 不传字段：不变
   * - 传 null：清除已配置的 target_session
   * - 传对象：更新为新值
   */
  target_session?: ScheduleTargetSession | null
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
export type ApiFormat = 'openai' | 'anthropic' | 'gemini' | 'openai-responses'

/** 模型类型 */
export type ModelType = 'llm'

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
  /** 认证方式：apikey（默认）或 oauth */
  auth_type?: 'apikey' | 'oauth'
  /** OAuth 凭证（仅 auth_type=oauth 时存在） */
  oauth_credential?: OAuthCredential
  models: ModelInfo[]
  status: ProviderStatus
  last_validated_at?: string
  validation_error?: string
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
  /** 认证方式：apikey（默认）或 oauth */
  auth_type?: 'apikey' | 'oauth'
  /**
   * 模型 id 前缀命中这里任意一项时，导入后自动标记 supports_vision=true。
   * 用于厂商 /models 响应不暴露 vision 字段、但又能确定某些命名族（如 claude- / gpt-）
   * 必然支持视觉的场景，避免用户进 detail 抽屉手动开 VLM。
   */
  vision_id_prefixes?: string[]
  /** 标记为推荐厂商，前端会在下拉里排到最前、加视觉强调 */
  recommended?: boolean
}

/**
 * OAuth 凭证信息
 */
export interface OAuthCredential {
  access_token: string
  refresh_token: string
  expires_at: number  // Unix timestamp (ms)
  account_id?: string
  email?: string
}

/**
 * 全局模型配置
 */
export interface GlobalModelConfig {
  default_llm_provider_id?: string
  default_llm_model_id?: string
  proxy?: ProxyConfig
  /**
   * 对外可达 base URL，供 agent 拼临时页面链接（<base>/tmp-pages/<id>）。
   * 可选；未配置时 resolveTmpPageBaseUrl 退化为 http://localhost:<web_port>。
   */
  public_base_url?: string
  /**
   * 自动清理的保留天数；null/undefined = 不按天清理。
   * trace_retention_days 和 task_retention_count 互斥：同时存在时 days 优先；都为空 = 不自动清理。
   */
  trace_retention_days?: number | null
  /**
   * 自动清理的保留 task 个数；null/undefined = 不按个数清理。
   *
   * 按 admin task.completed_at 倒序拉终态 task（status ∈ {completed, failed, cancelled}），
   * 取第 N 个的 completed_at 所在日期 D，删除 D 之前的 traces-*.jsonl + admin tasks。
   * 文件粒度按天 → 实际保留 task 数 ≥ N。活跃 task 不计入配额（活跃不能清）。
   *
   * spec 2026-06-09-task-trace-tool-unification.md §4.4。旧字段 trace_retention_count 已删；
   * model-provider-manager 加载配置时做 best-effort 转换（假设每 task 平均 3 条 trace，旧值 / 3）。
   */
  task_retention_count?: number | null
}

/**
 * 模块模型配置
 */
export interface ModuleModelConfig {
  module_id: string
  llm_provider_id?: string
  llm_model_id?: string
}

/**
 * 模型连接信息基础类型（供其他模块使用）
 */
export interface ModelConnectionInfo {
  endpoint: string
  apikey: string
  model_id: string
  format: ApiFormat
  /** 供应商 ID */
  provider_id?: string
  /** ChatGPT OAuth 账号 ID（仅 openai-responses + ChatGPT 订阅） */
  account_id?: string
}

/**
 * LLM 连接信息
 */
export interface LLMConnectionInfo extends ModelConnectionInfo {
  max_tokens?: number
  supports_vision?: boolean
}

// Model Provider API 参数类型

export interface CreateModelProviderParams {
  name: string
  type: ProviderConfigType
  format: ApiFormat
  endpoint: string
  api_key: string
  preset_vendor?: string
  auth_type?: 'apikey' | 'oauth'
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
  /** 未配置时的回退行为，默认 'global_default' */
  fallback?: 'global_default' | 'none'
}

/** visible_when 条件：单字段条件 */
interface SingleVisibleWhenCondition {
  readonly key: string
  readonly equals: string | number | boolean
}

/** visible_when 条件：多字段 OR 条件 */
interface AnyOfVisibleWhenCondition {
  readonly any_of: readonly string[]
  readonly equals: string | number | boolean
}

/** ExtraConfigSchema 的条件显示条件 */
export type VisibleWhenCondition = SingleVisibleWhenCondition | AnyOfVisibleWhenCondition

/** 扩展配置项 Schema（供 Admin 渲染表单） */
export interface ExtraConfigSchema {
  /** 配置项 key */
  key: string
  /** Admin 界面显示的标签 */
  title: string
  /** 帮助文字 */
  description?: string
  /** 类型 */
  type: 'string' | 'number' | 'boolean' | 'select'
  /** 默认值 */
  default?: unknown
  /** type=select 时的选项列表 */
  options?: Array<{ value: string; label: string }>
  /** 条件显示：满足条件时才渲染 */
  visible_when?: VisibleWhenCondition
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
  /** 扩展配置 Schema（声明支持的 extra 配置项，供 Admin 渲染表单） */
  extra_schema?: ExtraConfigSchema[]
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
  /** 描述 */
  description: string
  /** Skill 目录绝对路径（filesystem-native 真相源；agent 子进程同主机直接 fs.read） */
  skill_dir: string
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
  /** @deprecated as of 2026-04-27. MCP enable/disable 已移到 MCPServerRegistryEntry.enabled 全局字段。运行时忽略此字段；前端不再写入此字段。保留兼容期不破坏老数据。 */
  mcp_server_ids?: string[]
  /** @deprecated as of 2026-04-27. Skill enable/disable 已移到 SkillRegistryEntry.enabled 全局字段。运行时忽略此字段；前端不再写入此字段。保留兼容期不破坏老数据。 */
  skill_ids?: string[]
  /** 解析后的 MCP Server 完整配置（发给 Agent 时填充，不存储） */
  mcp_servers?: MCPServerConfig[]
  /** 解析后的 Skill 完整配置（发给 Agent 时填充，不存储） */
  skills?: SkillConfig[]
  /** 最大迭代次数（Front 默认 3，Worker 无限制） */
  max_iterations?: number
  /** 工具是否只读（Front 默认 true） */
  tools_readonly?: boolean
  /** IANA 时区名（如 "Asia/Shanghai"），用于 prompt 时间感知。缺省时 fallback 到 env CRABOT_DEFAULT_TIMEZONE / Asia/Shanghai */
  timezone?: string
  /** 扩展配置（非协议固定字段，由 Agent 实现自定义，见 protocol-agent-v2 §6） */
  extra?: Record<string, unknown>
}

/** Agent 实例配置的解析后格式（RPC 返回给 Agent，model_config 已从引用解析为连接信息） */
export interface ResolvedAgentConfig extends Omit<AgentInstanceConfig, 'model_config'> {
  model_config: Record<string, LLMConnectionInfo>
  /** startup pull 时一并下发已解析的 subagents（与 push 同源），避免 agent 启动期 subagents 空窗 */
  subagents?: SubAgentConfig[]
  /** 对外可达 base URL，供 agent 拼临时页面链接（<base>/tmp-pages/<id>）；未配置时为 admin 本地地址 */
  tmp_page_base_url?: string
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
  /** @deprecated as of 2026-04-27. MCP enable/disable 已移到 MCPServerRegistryEntry.enabled 全局字段。运行时忽略此字段；前端不再写入此字段。保留兼容期不破坏老数据。 */
  mcp_server_ids?: string[]
  /** @deprecated as of 2026-04-27. Skill enable/disable 已移到 SkillRegistryEntry.enabled 全局字段。运行时忽略此字段；前端不再写入此字段。保留兼容期不破坏老数据。 */
  skill_ids?: string[]
  max_iterations?: number
  tools_readonly?: boolean
  timezone?: string
  extra?: Record<string, unknown>
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
  'admin.task_updated': { task: Task }
  'admin.schedule_created': { schedule: Schedule }
  'admin.schedule_updated': { schedule: Schedule }
  'admin.schedule_deleted': { schedule_id: ScheduleId }
  'admin.schedule_triggered': { schedule: Schedule; task_id: string }
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

/** 单个媒体附件引用（对齐 base-protocol MediaItem） */
export interface MediaItem {
  /** http(s) URL 或本地绝对路径（同机模块间传递场景） */
  media_url: string
  mime_type: string
  filename?: string
  size?: number
}

/** 消息内容（对齐 base-protocol §5.4 MessageContent，admin chat 双向共用） */
export interface MessageContent {
  type: 'text' | 'image' | 'file' | 'system_event'
  text?: string
  /** 遗留单媒体表达；media 存在时此字段为 media[0] 的镜像 */
  media_url?: string
  file_path?: string
  filename?: string
  mime_type?: string
  size?: number
  /** 多附件数组；存在时为权威 */
  media?: MediaItem[]
}

/** MediaStore 配置 */
export interface MediaStoreConfig {
  /** 媒体保留天数（1-365），超期被每日清扫删除 */
  ttl_days: number
}

/** MediaStore 占用统计 */
export interface MediaUsage {
  file_count: number
  total_bytes: number
  ttl_days: number
}

/** 聊天消息 */
export interface ChatMessage {
  message_id: string
  role: 'user' | 'assistant'
  content: MessageContent
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

/** send_message RPC（admin-web 伪 channel）入参，对齐 protocol-channel SendMessageParams */
export interface ChatSendMessageParams {
  session_id: string
  content: MessageContent
  features?: Record<string, unknown>
}

/** send_message RPC 返回 */
export interface ChatSendMessageResult {
  platform_message_id: string
  sent_at: string
}

/** 任务状态快照（chat_task_update 推送与 GET /api/chat/tasks/:id 共用） */
export interface ChatTaskSnapshot {
  task_id: TaskId
  status: TaskStatus
  title: string
  /** 当前计划步骤（task.plan 存在时） */
  step?: { index: number; total: number; description: string }
}

/** 服务端发送的聊天消息 */
export interface ChatServerMessage {
  type: 'chat_reply' | 'chat_status' | 'chat_error' | 'chat_push' | 'chat_task_update' | 'chat_message_tagged' | 'chat_message_deleted'
  request_id?: string
  content?: string
  status?: 'processing' | 'completed' | 'failed'
  /**
   * chat_reply 携带任务关联时填写；chat_message_tagged 必填。
   * 对应 protocol-admin §3.20 ChatServerMessage.task_id 字段。
   */
  task_id?: TaskId
  reply_type?: 'direct_reply' | 'task_created' | 'task_completed' | 'task_failed'
  error?: string
  /** type='chat_push'：完整新消息（worker 经 send_message 伪 channel 回流） */
  message?: ChatMessage
  /** type='chat_task_update'：任务状态快照 */
  task?: ChatTaskSnapshot
  /**
   * chat_message_tagged 携带：worker 回复消息的任务归属回填（message_id + task_id）。
   * chat_message_deleted 携带：已删除消息的 id，前端据此实时移除该消息。
   */
  message_id?: string
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
    /** 结构化内容，含可选的 media[]（Phase 2 起透传，agent 侧 MessageContent.media 在 Task 7 加） */
    content: {
      type: 'text' | 'image' | 'file' | 'system_event'
      text?: string
      media_url?: string
      media?: MediaItem[]
    }
    features: { is_mention_crab: false }
    platform_timestamp: string
  }>
}

// ============================================================================
// Channel 管理类型定义
// ============================================================================

/**
 * Channel 模块声明的交互式配置入口（base-protocol §10）
 */
export interface ChannelOnboardingMethod {
  /** 该方法在模块内的唯一标识 */
  id: string
  /** 用户可读名称（卡片标题） */
  name: string
  /** 用户可读说明 */
  description?: string
  /** UI 类型词表：device_code / redirect / pending */
  type: 'device_code' | 'redirect' | 'pending'
  /** handler 文件，相对模块根目录；导出 createOnboarder() 工厂 */
  handler: string
}

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
  /** 交互式配置入口（来自 crabot-module.yaml onboarding_methods） */
  onboarding_methods?: ChannelOnboardingMethod[]
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

// ============================================================================
// Subagent 注册表（Phase 5）
// ============================================================================

/** Subagent 抽象模型 role。Admin push 时按当前 agent 实例的 model_config[role] 解析为 LLMConnectionInfo。
 *  - powerful: 主 worker / 复杂推理 / planning（如 Claude Sonnet, GPT-5）
 *  - cost_effective: 简单执行 / 摘要 / 高频低成本调用（如 DeepSeek, Haiku）
 *  - vision: 截图 / UI 识别 / 多模态图像理解 */
export type ModelRole = 'powerful' | 'cost_effective' | 'vision'

/** Subagent 内置能力组开关。每组 5 个 boolean 控制对应工具集是否注入 subagent 工具表。
 *  详见 subagent-tool-filter.ts 的 classifyTool 映射。
 *  **加新组需要写迁移函数**：admin 启动时把老数据缺失字段补 false（与 ModelRole migration 同模式）。 */
export interface BuiltinCapabilities {
  /** Read / Write / Edit / Glob / Grep — 文件读写检索 */
  file_system: boolean
  /** Bash（含 run_in_background）/ Output / Kill / ListEntities — shell + 后台进程管理 */
  shell: boolean
  /** find_task / get_task_progress — 任务情报查询 */
  task_intel: boolean
  /** crab-memory MCP 全部工具 — 长期记忆读写 */
  crab_memory: boolean
  /** crab-messaging MCP 全部工具 — channel 消息发送 */
  crab_messaging: boolean
}

/** Subagent 的共享字段：5 段 prompt + 工具白名单 + 元运行时参数。
 *  存储格式（SubAgentRegistryEntry）与运行时格式（SubAgentConfig）共用这部分。 */
export interface SubAgentBase {
  /** UUID（自动生成） */
  id: string
  /** subagent_type 参数值，用作 delegate_task 调用的 enum 选项；snake_case */
  name: string
  /** 一句话说明，给 Admin UI 列表显示 */
  description: string

  /** 触发条件：以 "Use this subagent when ..." 起头，必含 <example> 示例。
   *  注入到 delegate_task 工具的 description 的 <available_subagents> 段，
   *  worker LLM 用此判断何时调用本 subagent。 */
  when_to_use: string
  /** 角色与边界声明（persona）。运行时拼装到 system prompt 的 "—— 你的角色 ——" 段。 */
  role: string
  /** 工作流自然语言步骤。运行时拼装到 system prompt 的 "—— 工作流 ——" 段。 */
  workflow: string
  /** 交付物格式说明。运行时拼装到 system prompt 的 "—— 交付物 ——" 段。 */
  deliverables: string
  /** 完成前自检 / 边缘情况处理，可选。运行时拼装到 "—— 完成前自检 ——" 段。 */
  verification?: string

  /** 内置能力组开关。**加新 capability 需要写迁移函数**（参考 agent-manager.ts 的 migrateModelConfig 模式），
   *  否则老数据反序列化后该字段缺失，TS 会报错。 */
  builtin_capabilities: BuiltinCapabilities
  /** 允许调用的 MCP server ID 列表；空 = 全禁。引用全局 MCPServerRegistryEntry.id */
  allowed_mcp_server_ids: string[]
  /** 允许加载的 Skill ID 列表；空 = 全禁，且 Skill 工具不注入 subagent 工具集 */
  allowed_skill_ids: string[]

  /** subagent engine 最大轮数。默认 20。0 表示无限制（不推荐） */
  max_turns: number
  /** 代码层注册的 hook bundle 名（可选）。当前唯一已知值：'lsp_diagnostics'（post-edit LSP 诊断 push） */
  hook_preset?: string

  /** 系统专用：仅由系统隐式触发（如 send_message(intent='final') 的 audit gate），
   *  不出现在 delegate_task 工具的 enum 里，worker 不可主动调。
   *  spec: 2026-05-23-goal-mode-design.md §6.4 */
  system_only?: boolean
}

/** 注册表存储格式（data/admin/subagents.json）；model 以引用形式存储。 */
export interface SubAgentRegistryEntry extends SubAgentBase {
  /** Provider 引用。与 model_role 互斥：
   *  - 自定义 subagent：必填 provider_id+model_id，model_role 为 null
   *  - 内置 subagent：默认 model_role 非 null，provider_id+model_id 为 null（用户后续可改成具体引用）
   *  约束：(provider_id+model_id 都非 null) 或 (model_role 非 null)，至少一组非 null。
   *  Runtime 校验见 SubAgentManager.validateModelSpec。 */
  provider_id: string | null
  /** 与 provider_id 配对，二者必须同时非 null */
  model_id: string | null
  /** 抽象 role；admin push 时按当前 agent 实例的 model_config[role] 解析为具体连接。
   *  与 provider_id+model_id 互斥（见上） */
  model_role: ModelRole | null

  /** 该 subagent 是否在 delegate_task 的 <available_subagents> 列表里 */
  enabled: boolean
  /** 内置项（is_builtin=true）可编辑可禁用不可删。
   *
   *  存储语义（is_builtin=true 时）：磁盘只存"用户实际 override 的字段"，与代码里
   *  getBuiltinSubAgents() 的 default 不同的字段才落盘。Load 时 merge default + override
   *  得到完整 entry。代码升级 default 后，未 override 的字段自动跟随；用户改过的字段
   *  永久保留。无需 is_user_modified 标志位——override 本身即表达。 */
  is_builtin: boolean
  created_at: string
  updated_at: string
}

/** 运行时格式：admin push 给 agent 的 SubAgentConfig；model 已解析为连接信息。 */
export interface SubAgentConfig extends SubAgentBase {
  /** Admin 解析后的具体连接信息（provider+model 或 model_role 之一，由 Admin 解析时决定） */
  model: LLMConnectionInfo
}

// ============================================================================
// TaskGoal — 目标驱动模式（per-task，agent 自定）
// spec: crabot-docs/superpowers/specs/2026-05-23-goal-mode-design.md §3
//
// 不是独立资源，是 Task 上的子对象。task_id 即所有权，没有 id / owner_id。
// 简单 task 不挂 goal（task.goal === undefined），audit gate 透明放行。
// agent 调 set_task_goal 工具 = 进入"重流程"模式：todo + audit 全部生效。
// ============================================================================

/**
 * TaskGoal 生命周期：
 *   active ──► complete | blocked | budget_limited | cleared （均为终态）
 *
 * - active           agent 写下承诺后的默认状态
 * - complete         send_message(intent='final') 通过 audit
 * - blocked          连续 N 次 audit 失败且 failed_criteria 一致；走 request_goal_revision 让人类介入
 * - budget_limited   tokens_used >= token_budget
 * - cleared          task 取消 / 异常退出时由系统清理
 */
export type TaskGoalStatus = 'active' | 'complete' | 'blocked' | 'budget_limited' | 'cleared'

/**
 * 完成条件的单条规则。audit subagent 逐条独立验证。
 * - kind='cmd'      Bash 跑 spec 命令，对照 expect.exit_code / stdout_contains / stdout_matches
 * - kind='file'     看文件（路径=spec），可选用 stdout_matches 验证内容
 * - kind='semantic' 语义验证，auditor 用 Read/Grep 自采证据
 */
export interface AcceptanceCriterion {
  /** Audit 报告里用来定位的短 id（agent 自定，比如 c-typecheck） */
  id: string
  kind: 'cmd' | 'file' | 'semantic'
  /** kind=cmd 时是命令；kind=file 时是路径；kind=semantic 时是自然语言描述 */
  spec: string
  /** 期望结果（cmd/file 验证时用） */
  expect?: {
    exit_code?: number
    stdout_contains?: string
    /** 正则字符串（new RegExp 形式） */
    stdout_matches?: string
  }
  /** Agent 写给 auditor 的解释，便于 auditor 理解 criterion 的本意（可选） */
  rationale?: string
}

/** 单次 audit 历史条目（task_id 已经在外层 Task，不重复存） */
export interface TaskGoalAuditEntry {
  /** ISO 时间戳 */
  at: string
  pass: boolean
  /** 失败的 criterion id 列表（pass 时为空数组） */
  failed_criteria: string[]
  /** Audit subagent 跑出来的子 trace id（追溯证据） */
  audit_trace_id: string
}

/** 挂在 Task.goal 上的子对象 */
export interface TaskGoal {
  /** 自然语言目标描述（喂给 worker 也喂给 auditor） */
  objective: string
  /** 完成条件；非空，至少 1 条 */
  acceptance_criteria: AcceptanceCriterion[]
  status: TaskGoalStatus
  /** 累计 token 用量（worker turn 结束后由 agent 累加） */
  tokens_used: number
  /** 可选预算；超过 → status=budget_limited（系统强制终态） */
  token_budget?: number
  /** Audit 历次结果，最新的在前 */
  audit_history: TaskGoalAuditEntry[]
  created_at: string
  updated_at: string
  /** 进入终态时间（complete / blocked / budget_limited / cleared） */
  completed_at?: string
}

// === Task.goal 相关 RPC 参数与返回 ===

/** Agent 在动手前调 set_task_goal 写入承诺。Task 必须已存在且无 goal（不允许中途改）。 */
export interface SetTaskGoalParams {
  task_id: TaskId
  objective: string
  acceptance_criteria: AcceptanceCriterion[]
  token_budget?: number
}

export interface SetTaskGoalResult {
  task: Task
}

/** Audit fail 后追加历史；自动在 audit_history × N 同 failed_criteria 时切 blocked。 */
export interface AppendTaskGoalAuditEntryParams {
  task_id: TaskId
  entry: TaskGoalAuditEntry
}

export interface AppendTaskGoalAuditEntryResult {
  task: Task
}

/** 累加 token；超过 budget 时自动切 budget_limited 终态。 */
export interface IncrementTaskGoalTokensParams {
  task_id: TaskId
  delta: number
}

export interface IncrementTaskGoalTokensResult {
  task: Task
}

/** 由 audit 通过路径调用；status='complete'。 */
export interface CompleteTaskGoalParams {
  task_id: TaskId
}

export interface CompleteTaskGoalResult {
  task: Task
}

/** 由 /清除目标 slash 调用；status='cleared'。 */
export interface ClearTaskGoalParams {
  task_id: TaskId
}

export interface ClearTaskGoalResult {
  task: Task
}
