/**
 * Unified Agent 模块类型定义
 *
 * 合并 Flow 和 Agent 的类型
 *
 * @see crabot-docs/protocols/protocol-agent-v2.md
 * @see crabot-docs/protocols/base-protocol.md
 */

import type {
  ModuleId,
  FriendId,
  SessionId,
  TaskId,
  ScheduleId,
} from 'crabot-shared'
import type { EngineMessage, EngineMessagesRef } from './engine/types.js'

// ============================================================================
// 配置
// ============================================================================

export interface OrchestrationConfig {
  /** Front Agent 近期聊天记录的时间窗口（小时） */
  front_context_recent_messages_window_hours: number
  /** Front Agent 近期聊天记录的硬上限（防止 busy 群爆 prompt） */
  front_context_recent_messages_max_cap: number
  /** Front Agent 短期记忆的时间窗口（小时） */
  front_context_short_term_memory_window_hours: number
  /** Front Agent 短期记忆的硬上限 */
  front_context_short_term_memory_max_cap: number
  /** Worker Agent 近期聊天记录的时间窗口（小时） */
  worker_recent_messages_window_hours: number
  /** Worker Agent 近期聊天记录的硬上限 */
  worker_recent_messages_max_cap: number
  /** Worker Agent 短期记忆的时间窗口（小时） */
  worker_short_term_memory_window_hours: number
  /** Worker Agent 短期记忆的硬上限 */
  worker_short_term_memory_max_cap: number
  /** Worker Agent 上下文中的长期记忆数量上限 */
  worker_long_term_memory_limit: number
  /** Front Agent 处理超时（秒） */
  front_agent_timeout: number
  /** Session 状态空闲清理时间（秒） */
  session_state_ttl: number
  /** Worker 配置刷新间隔（秒） */
  worker_config_refresh_interval: number
  /** Front Agent 等待队列最大长度 */
  front_agent_queue_max_length: number
  /** Front Agent 等待队列超时（秒） */
  front_agent_queue_timeout: number
}

export interface BuiltinToolConfig {
  /** Which built-in tools are enabled (default: all enabled) */
  enabled_tools?: string[]
  /** Which built-in tools are disabled (alternative to enabled_tools) */
  disabled_tools?: string[]
  /** Permission level overrides per tool */
  permission_overrides?: Record<string, 'safe' | 'normal' | 'dangerous'>
  /** Bash-specific timeout in ms (default 120000) */
  bash_timeout?: number
}

// ============================================================================
// Subagent 配置（Phase 5）
// ============================================================================

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

/** Admin 推过来的运行时 subagent 配置；model 已解析为 LLMConnectionInfo */
export interface SubAgentConfig {
  id: string
  name: string
  description: string

  /** 触发条件，注入 delegate_task 工具的 <available_subagents> 段 */
  when_to_use: string
  /** 角色 + 边界声明 */
  role: string
  workflow: string
  deliverables: string
  verification?: string

  model: LLMConnectionInfo

  builtin_capabilities: BuiltinCapabilities
  allowed_mcp_server_ids: string[]
  allowed_skill_ids: string[]

  max_turns: number
  /** 代码内置 hook bundle 名（如 'lsp_diagnostics'：post-edit LSP 诊断 push） */
  hook_preset?: string
  /** 系统专用：仅由系统隐式触发（如 goal_auditor 由引擎 endTurnGate 触发），
   *  不出现在 delegate_task 工具的 enum / description 里，worker 无法主动调。
   *  spec: 2026-05-23-goal-mode-design.md §6.4 */
  system_only?: boolean
}

export interface AgentLayerConfig {
  /** 实例 ID */
  instance_id: string
  /** 支持的角色 */
  roles: Array<'front' | 'worker'>
  /** 系统提示词 */
  system_prompt: string
  /** 模型配置 */
  model_config: Record<string, LLMConnectionInfo>
  /** 最大迭代次数 */
  max_iterations?: number
  /** 最大并发任务数（Worker 角色） */
  max_concurrent_tasks?: number
  /** 可用容量（Worker 角色） */
  available_capacity?: number
  /** MCP Servers */
  mcp_servers?: MCPServerConfig[]
  /** Skills */
  skills?: SkillConfig[]
  /** 工具是否只读 */
  tools_readonly?: boolean
  /** 专长描述 */
  specialization?: string
  /** Built-in tool configuration (Admin-controlled) */
  builtin_tool_config?: BuiltinToolConfig
  /** IANA 时区名（如 "Asia/Shanghai"），用于 prompt 时间感知 */
  timezone?: string
  /** Subagent 列表（Phase 5），由 admin 推过来 */
  subagents?: SubAgentConfig[]
  /** 对外可达 base URL，供 worker 拼临时页面链接（<base>/tmp-pages/<id>）；由 admin handleGetAgentConfig 注入 */
  tmp_page_base_url?: string
}

export interface UnifiedAgentConfig {
  module_id: ModuleId
  module_type: string
  version: string
  protocol_version: string
  port: number
  orchestration: OrchestrationConfig
  agent_config?: AgentLayerConfig
  /**
   * 扩展配置（非协议固定字段，由具体 Agent 实现自定义）
   * @see protocol-agent-v2.md §6 extra
   */
  extra?: Record<string, unknown>
}

// ============================================================================
// Session 状态
// ============================================================================

export interface SessionState {
  session_id: SessionId
  /** 当前正在处理的请求 ID */
  pending_request_id?: string
  /** 最后一次消息时间 */
  last_message_time: number
  /** 消息计数 */
  message_count: number
}

// ============================================================================
// 权限检查
// ============================================================================

/** 由 PermissionResult 派生的记忆读写权限参数，传给 ContextAssembler 和 MemoryWriter */
export interface MemoryPermissions {
  /** 写入短期记忆时的 visibility 标记 */
  write_visibility: 'private' | 'internal' | 'public'
  /** 写入短期记忆时的 scopes 标记 */
  write_scopes: string[]
  /** 读取短期记忆时的最低 visibility 过滤 */
  read_min_visibility: 'private' | 'internal' | 'public'
  /** 读取短期记忆时的 scope 过滤（undefined 表示不过滤） */
  read_accessible_scopes?: string[]
}

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
  /** 桌面控制：键盘、鼠标、截屏等 OS 级操作（computer-use 类 MCP 工具）。仅 master_private 模板可开启 */
  desktop: boolean
}

export interface StoragePermission {
  workspace_path: string
  access: 'read' | 'readwrite'
}

// ============================================================================
// CLI 访问权限（与 admin 端 types.ts CliAccessConfig 保持同构）
//
// CliDomain 直接从 crabot-shared 导入——shared 是 agent hook + admin RPC 共享的协议层；
// 这里不再重新定义 union 字面量，避免漂移。CliPerm / CLI_DOMAINS / CliAccessConfig 仍保留
// agent 本地定义（admin 也有自己的副本），但 domain 字面量从 shared 单一来源得到。
// ============================================================================

import type { CliDomain } from 'crabot-shared'
export type { CliDomain }

export type CliPerm = 'none' | 'read' | 'write'

export const CLI_DOMAINS: readonly CliDomain[] = [
  'provider', 'agent', 'mcp', 'skill', 'schedule',
  'channel', 'friend', 'permission', 'config', 'undo',
] as const

export type CliAccessConfig = Record<CliDomain, CliPerm>

export interface ResolvedPermissions {
  tool_access: ToolAccessConfig
  cli_access: CliAccessConfig
  storage: StoragePermission | null
  memory_scopes: string[]
}

export interface PermissionResult {
  /** 是否允许处理 */
  allowed: boolean
  /** 拒绝原因 */
  reason?: string
  /** Friend 信息（如果已识别） */
  friend?: Friend
  /** Session 权限配置 */
  session_config?: SessionPermissionConfig
}

export interface Friend {
  id: FriendId
  display_name: string
  permission: 'master' | 'normal'
  permission_template_id?: string
  channel_identities: Array<{
    channel_id: ModuleId
    platform_user_id: string
    platform_display_name: string
  }>
  created_at: string
  updated_at: string
}

export interface SessionPermissionConfig {
  tool_access?: Partial<ToolAccessConfig>
  storage?: StoragePermission | null
  memory_scopes?: string[]
  template_id?: string
  updated_at: string
}

export interface FriendPermissionConfig {
  tool_access: ToolAccessConfig
  storage: StoragePermission | null
  memory_scopes: string[]
  updated_at: string
}

// ============================================================================
// Worker 选择
// ============================================================================

export interface WorkerRoutingInfo {
  worker_id: ModuleId
  specialization: string
  available_capacity: number
}

// ============================================================================
// 消息类型（对齐 base-protocol.md）
// ============================================================================

export type MessageType = 'text' | 'image' | 'file' | 'system_event'

/** 仅 type='system_event' 时使用，见 base-protocol.md §5.4 system_event */
export type SystemEventType = 'members_added' | 'scheduled'

export interface MediaItem {
  /** http(s) URL 或本地绝对路径（同机模块间传递场景） */
  media_url: string
  mime_type: string
  filename?: string
  size?: number
}

export interface MessageContent {
  type: MessageType
  text?: string
  media_url?: string
  file_path?: string
  filename?: string
  mime_type?: string
  size?: number
  /** 多附件数组（media 存在时为权威，media_url 是 media[0] 的镜像）；见 base-protocol §5.4 */
  media?: MediaItem[]
  /** 惰性媒体下载句柄（非图片文件 status=not_fetched 时携带，传给 fetch_media RPC） */
  handle?: string
  /** 媒体就绪状态：ready=已就绪(见 file_path) / not_fetched=未下载 / fetching=下载中 / failed=失败 */
  status?: 'ready' | 'not_fetched' | 'fetching' | 'failed'
  /** system_event 子类型（type=system_event 时必填） */
  event_type?: SystemEventType
  /** 系统事件涉及的用户（如 members_added 的新加入者） */
  affected_users?: Array<{ platform_user_id: string; platform_display_name: string }>
}

export interface ChannelMessage {
  platform_message_id: string
  session: {
    session_id: SessionId
    channel_id: ModuleId
    type: 'private' | 'group'
  }
  sender: {
    /** undefined if sender is not a registered friend */
    friend_id?: FriendId
    platform_user_id: string
    platform_display_name: string
  }
  content: MessageContent
  features: {
    is_mention_crab: boolean
    mentions?: Array<{ user_id: string; display_name?: string }>
    quote_message_id?: string
    reply_to_message_id?: string
    thread_id?: string
    action_callback?: { action_id: string; payload: Record<string, unknown> }
  }
  platform_timestamp: string
}

// ============================================================================
// 工具和记忆
// ============================================================================

export interface ToolDeclaration {
  name: string
  description: string
  source: 'builtin' | 'mcp'
  mcp_server?: string
  input_schema?: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

export interface TaskSummary {
  task_id: TaskId
  title: string
  status: string
  priority: string
  assigned_worker?: string
  plan_summary?: string
  latest_progress?: string
  source_channel_id?: string
  source_session_id?: string
  /**
   * 任务触发类型（来自 admin TaskSource.trigger_type）。
   * `scheduled` 表示由调度引擎创建的定时/巡检任务，Front 在 prompt 中需要标记，
   * 且不允许 supplement_task；engine 收到针对 scheduled 的 supplement 时改走 create_task。
   */
  trigger_type?: 'manual' | 'scheduled' | 'auto' | 'event'
  updated_at?: string
  /**
   * 任务正在等待人类回答的问题（仅 status=waiting_human 时有值）。
   * 由 worker 调 ask_human 工具写入，Front prompt 渲染时作为 supplement 判断的参考。
   */
  pending_question?: string
  /** 当前正在执行的实时快照（仅 status=executing 且 worker 在本进程时有值） */
  live?: LiveTaskSnapshot
}

/** 飞行中的工具调用（写入 LiveTaskSnapshot.active_tools） */
export interface LiveToolCall {
  readonly name: string
  readonly input_summary: string
  readonly started_at: number
}

/** 已完成的工具调用（写入 LiveTaskSnapshot.recent_completed） */
export interface LiveCompletedTool {
  readonly name: string
  readonly input_summary: string
  readonly is_error: boolean
  readonly ended_at: number
}

/**
 * Worker 运行时的实时进度快照。
 * 由 agent-handler 维护内存映射，ContextAssembler 同进程同步读取，
 * 用于 Front 回答"汇报进度"类提问时拥有飞行中状态信息。
 */
export interface LiveTaskSnapshot {
  readonly task_id: TaskId
  readonly current_turn: number
  readonly started_at: number
  readonly last_assistant_text?: string
  readonly active_tools: ReadonlyArray<LiveToolCall>
  readonly recent_completed: ReadonlyArray<LiveCompletedTool>
  /**
   * 当前 LLM 调用 retry 状态（undefined 表示未在 retry 中）。
   * Admin web 可据此显示"正在重试"提示，避免用户看到"卡住"。
   */
  readonly llm_retry?: {
    readonly attempt: number
    readonly max_attempts: number
    readonly source: 'pre-stream' | 'mid-stream'
    readonly last_error: string
    readonly since: number  // ms timestamp
  }
}

export interface ShortTermMemoryEntry {
  id: string
  content: string
  keywords: string[]
  event_time: string
  persons: string[]
  entities: string[]
  topic?: string
  source: {
    channel_id?: string
    session_id?: string
    friend_id?: string
    type: 'triage' | 'task' | 'manual'
  }
  refs?: Record<string, string>
  compressed: boolean
  visibility: 'private' | 'internal' | 'public'
  scopes: string[]
  created_at: string
}

/**
 * 长期记忆引用 — Memory v2 `search_long_term` 默认 brief 形态
 *
 * @see protocol-memory.md `search_long_term` 响应（include='brief'）
 * @see protocol-memory.md frontmatter（include='full' 时附带）
 */
export interface LongTermMemoryRef {
  id: string
  type: 'fact' | 'lesson' | 'concept'
  status: 'inbox' | 'confirmed' | 'trash'
  brief: string
  /** optional tags from frontmatter (only present if include='full' was used) */
  tags?: string[]
}

export interface ResolvedModule {
  module_id: ModuleId
  port: number
  host?: string
}

// ============================================================================
// Agent 上下文（对齐 protocol-agent-v2.md）
// ============================================================================

/**
 * 上下文时间窗口元数据。让 prompt 构建器在 section 标题里显示真实窗口大小，
 * 而不是 hardcode；同时 LLM 看到窗口边界后能判断"窗口外的事件需要主动调工具查"。
 */
export interface ContextTimeWindows {
  recent_messages_window_hours: number
  short_term_memory_window_hours: number
}

export interface FrontAgentContext {
  sender_friend: Friend
  recent_messages: ChannelMessage[]
  short_term_memories: ShortTermMemoryEntry[]
  active_tasks: TaskSummary[]
  available_tools: ToolDeclaration[]
  /** 当前场景画像，由 Memory 模块直接返回并映射为运行时格式 */
  scene_profile?: RuntimeSceneProfile
  /** Crabot's display name on the current channel (e.g. group nickname) */
  crab_display_name?: string
  /**
   * Crabot 在该渠道里 @ 自己时的稳定标识（含 `@` 前缀）。
   * 用于让 dispatcher / worker 在消息正文出现多个 @bot 时区分哪一个是自己。
   * - telegram: `@<username>`
   * - feishu: `@<bot_open_id>`
   * - wechat: `@<puppet_wxid>`
   */
  crab_self_handle?: string
  /** 用于 prompt 渲染时显示窗口边界 */
  time_windows: ContextTimeWindows
}

export interface WorkerAgentContext {
  task_origin?: TaskOrigin
  /** Front 做决策时的完整输入消息（定时任务等场景不存在） */
  trigger_messages?: ChannelMessage[]
  /** 发送者信息（定时任务等场景不存在） */
  sender_friend?: Friend
  recent_messages?: ChannelMessage[]
  short_term_memories: ShortTermMemoryEntry[]
  long_term_memories: LongTermMemoryRef[]
  available_tools: ToolDeclaration[]
  admin_endpoint: ResolvedModule
  memory_endpoint: ResolvedModule
  channel_endpoints: ResolvedModule[]
  /** 用于 prompt 渲染时显示窗口边界 */
  time_windows: ContextTimeWindows
  sandbox_path_mappings?: Array<{
    sandbox_path: string
    host_path: string
    read_only: boolean
  }>
  /** Memory write permissions for this task's context */
  memory_permissions?: {
    write_visibility: 'private' | 'internal' | 'public'
    write_scopes: string[]
  }
  /**
   * 任务执行权限（模板 + Session 覆盖）。
   *
   * 三种来源：
   * 1. 私聊/群聊消息触发：Front 处理消息时由 UnifiedAgent.resolvePrincipalPermissions 解析后塞入
   * 2. Schedule 触发：Admin 端按 `creator_friend_id` 解析（系统内置走 master_private）后随 RPC 下发
   * 3. 都没有：worker 兜底回 FAIL_CLOSED_TOOL_ACCESS（仅 messaging）
   *
   * 每个任务都带自己的快照，避免共享字段在并发任务间被串改。
   */
  resolved_permissions?: ResolvedPermissions
  /** 当前场景画像，由 Memory 模块直接返回并映射为运行时格式 */
  scene_profile?: RuntimeSceneProfile
}

export interface TaskOrigin {
  channel_id: ModuleId
  session_id: SessionId
  friend_id?: FriendId
  session_type?: 'private' | 'group'
}

// ============================================================================
// Agent 决策类型
// ============================================================================

export interface ToolHistoryEntry {
  tool_name: string
  input_summary: string
  output_summary: string
}

/**
 * 用户对 task 的态度（Phase A 2026-04-25）
 *
 * Front Handler 在 reply / create_task / supplement_task 三个工具上可附带本字段。
 * 锚定对象由调用的工具自动决定（spec §6）：
 * - reply / create_task：prev finished task（同 channel/sender，30 分钟内）
 * - supplement_task：当前 payload 里的 task_id
 *
 * Spec: 2026-04-25-self-learning-feedback-signal-design.md
 */
export type UserAttitude = 'strong_pass' | 'pass' | 'fail' | 'strong_fail'
export type UserAttitudeNegOnly = 'fail' | 'strong_fail'

export type UserEmotion = 'neutral' | 'unhappy' | 'frustrated' | 'angry' | 'dismissive'

// ============================================================================
// 协议接口参数
// ============================================================================

export interface ProcessMessageParams {
  message: ChannelMessage
  source_type?: 'channel' | 'admin_chat'
  callback_info?: {
    source_module_id: string
    request_id: string
  }
}

export interface ProcessMessageResult {
  // worker 端只能产出 direct_reply / create_task；supplement / stay_silent 由 dispatcher
  // 在 worker spawn 前直接处理，不会出现在 worker 返回里
  decision_types: Array<'direct_reply' | 'create_task'>
  task_ids?: TaskId[]
}

export interface CreateTaskFromScheduleParams {
  schedule_id: ScheduleId
  title: string
  description: string
  preferred_worker_specialization?: string
}

export interface CreateTaskFromScheduleResult {
  task_id: TaskId
  assigned_worker: ModuleId
}

// ============================================================================
// 事件 Payload
// ============================================================================

export interface MessageReceivedEvent {
  channel_id: ModuleId
  session_id: SessionId
  message: ChannelMessage
}

export interface TaskStatusChangedEvent {
  task_id: TaskId
  old_status: string
  new_status: string
  final_reply?: string
}

export interface ModuleStoppedEvent {
  module_id: ModuleId
  reason: 'shutdown' | 'crashed' | 'health_check_failed' | 'forced'
}

export interface FriendUpdatedEvent {
  friend_id: FriendId
}

export interface FriendDeletedEvent {
  friend_id: FriendId
}

// ============================================================================
// Agent 相关类型
// ============================================================================

/**
 * LLM 模型角色配置需求
 */
export interface LLMRoleRequirement {
  /** 配置 key */
  key: string
  /** 描述说明 */
  description: string
  /** 是否必须 */
  required: boolean
  /** 使用该模型的角色 */
  used_by: Array<'front' | 'worker'>
  /** 推荐能力 */
  recommended_capabilities?: string[]
  /** 未配置时的回退行为，默认 'global_default' */
  fallback?: 'global_default' | 'none'
}

export interface LLMConnectionInfo {
  endpoint: string
  apikey: string
  model_id: string
  format: 'anthropic' | 'openai' | 'gemini' | 'openai-responses'
  max_tokens?: number
  supports_vision?: boolean
  /** ChatGPT OAuth 账号 ID（仅 openai-responses + ChatGPT 订阅需要） */
  account_id?: string
}

export interface MCPServerConfig {
  name: string
  transport?: 'stdio' | 'streamable-http' | 'sse'
  // stdio fields
  command?: string
  args?: string[]
  env?: Record<string, string>
  // http/sse fields
  url?: string
  headers?: Record<string, string>
  /**
   * Per-tool default parameters injected before each call.
   * Key = tool name (without mcp__server__ prefix), value = defaults to merge.
   * Only fills in missing keys — never overwrites explicit LLM input.
   *
   * Example: { "fetch": { "real_chrome": true }, "stealthy_fetch": { "real_chrome": true } }
   */
  tool_defaults?: Record<string, Record<string, unknown>>
}

export interface SkillConfig {
  id: string
  name: string
  description?: string
  /** 绝对路径，agent 子进程同主机可直接 fs.read */
  skill_dir: string
}

export interface AgentRole {
  roles: Array<'front' | 'worker'>
  specialization: string
  max_concurrent_tasks?: number
  models: Record<string, LLMConnectionInfo>
  model_format: 'anthropic' | 'openai' | 'gemini' | 'openai-responses'
  tools?: ToolDeclaration[]
  skills?: SkillConfig[]
}

export interface ExecuteTaskResult {
  task_id: TaskId
  outcome: 'completed' | 'failed'
  /** 失败时填错误描述；成功路径不填。worker 完成内容已通过 send_message 发出 +
   *  通过 admin update_task_outcome 写入 task.result.outcome_brief，dispatcher 不再消费 */
  error?: string
}

// ============================================================================
// Agent Loop 相关类型（SDK 替代后保留的最小集合）
// ============================================================================

export interface ToolHandler {
  (input: unknown): Promise<unknown> | unknown
}


// ============================================================================
// Handler 参数类型
// ============================================================================

export interface ExecuteTaskParams {
  task: {
    task_id: TaskId
    task_title: string
    priority: string
    plan?: string
    task_type?: string
    /** 任务来源信息。Schedule 路径由 ScheduledTaskRunner 填入 trigger_type='scheduled'；
     *  trigger 路径合成 task 不填此字段（视为 'message'）。 */
    source?: {
      trigger_type?: 'manual' | 'scheduled' | 'auto' | 'event'
    }
  }
  context: WorkerAgentContext
  /**
   * 无损 resume：从 ResumeCheckpoint 重建 worker loop 初始状态。
   * 存在时：首轮 initialMessages = [...initialMessages, wakeupMessage]；
   * todoStore 和 goalRevisionUnlocked 从此处恢复，而非空初始化。
   */
  resumeFrom?: {
    initialMessages: import('./engine/types.js').EngineMessage[]
    todoItems: import('./agent/worker-todo-store.js').TodoItem[]
    goalRevisionUnlocked?: boolean
    /** Task-scoped cwd（set_cwd 设置）；从 checkpoint worker_state.cwd 恢复，缺失则回退 home。 */
    cwd?: string
  }
}

export interface DeliverHumanResponseParams {
  task_id: TaskId
  messages: ChannelMessage[]
}

export interface DeliverHumanResponseResult {
  received: boolean
  task_status: string
}

export interface CancelTaskParams {
  task_id: TaskId
  reason: string
}

export interface WorkerTaskState {
  taskId: TaskId
  /**
   * 注：task.status 字段曾经存在过，2026-06-09 起删除（spec：task/trace 状态同步 SSOT 重整）。
   * task.status 的 SSOT 是 admin tasks.json；agent 永远不直接 mutate。
   * 这里只保留 ephemeral 执行态（humanQueue / abortController / pendingHumanMessages 等）。
   */
  startedAt: string
  title?: string
  /** task 触发类型，供 context-assembler union 时过滤 scheduled task */
  readonly triggerType?: 'message' | 'scheduled'
  abortController: {
    signal: { aborted: boolean }
    abort: () => void
  }
  pendingHumanMessages: ChannelMessage[]
  taskOrigin?: TaskOrigin
  /** Per-task mutable todo plan store; created on task start, dropped on cleanup. */
  todoStore: import('./agent/worker-todo-store.js').TodoStore
  /**
   * engine 每轮刷新的对话快照引用。runWorkerLoop 创建后写入，onStop 补 flush 用。
   * undefined = loop 还未启动（不应发生）或已清理。
   */
  messagesRef?: EngineMessagesRef
  /**
   * 本 worker loop 对应的 trace id。runWorkerLoop 开始后写入，onStop 补 flush 用。
   * undefined = loop 还未启动或已清理。
   */
  activeTraceId?: string
  /**
   * resume checkpoint 用：worker 执行上下文子集（权限/身份/场景），决定 resumed worker
   * 拿回原工具集 + 投递目标 + report mode。runWorkerLoop 开始后从 context 快照写入。
   */
  resumeWorkerContext?: ResumeWorkerContext
  /**
   * "改目标券"：人类 supplement 到达时置 true（上限 1，不叠加）。
   * set_task_goal 重设已有 goal 时消费它——没券不许 worker 自改目标（反 specification-gaming）。
   */
  goalRevisionUnlocked?: boolean
  /**
   * Goal mode 工作态下"待审最终交付候选"的缓冲槽。
   *
   * **语义（spec §4.1 Revision 2026-06-09 第 1 段）**：永远 ≤ 1 条。
   * - 数组形态保留是实现选择（共享引用、跨模块改动小），但**业务语义就是单值**
   * - send_message handler 缓冲分支 push 新条前若数组已有旧条 → 先 sync flush 旧条（"新顶旧"）
   * - audit pass 后引擎 flush 这一条；audit fail / 改 goal abort 时整体丢弃
   * - 维护者千万不要把它当通用 array 用、push 多条
   *
   * Entry shape 用 OutboundBufferEntry（与 TaskContext.outboundBuffer / 测试 mock 共享同一类型，
   * 由 ./agent/outbound-flush 导出）。
   * spec: 2026-06-07-goal-audit-async-buffered-info-design.md §4.1（含 Revision 2026-06-09 第 1 段）
   */
  readonly outboundBuffer: Array<import('./agent/outbound-flush.js').OutboundBufferEntry>
  /** Active audit subagent id；设置后表示 task 处于"等审态"。undefined = 工作态。 */
  activeAuditId?: string
  /**
   * 当前 task 的 async subagent ids。runWorkerLoop 跨 iteration 持久（Task 3 reviewer follow-up）。
   * delegate_task 异步路径返回 launched 时加入；wait_for_signal 跟全局 agentAbortControllers 取交集
   * 判断是否还有 active subagent。spec: 2026-06-07-goal-audit-async-buffered-info-design.md Task 5
   */
  readonly activeAsyncSubagentIds: Set<string>
  /**
   * Task 生命周期内是否至少一次 send_message 真正 flush 到 channel 成功返回过。
   * 一旦置 true 不再清零（task 即使续作 audit fail，"过去发过"是事实）。
   *
   * 由 dispatchOutboundMessage 钩子点统一设值（spec §4.13.6 Invariant #1+#2）：
   * - success 路径触发钩子 → 置 true
   * - 抛错路径不触发 → 状态不变
   *
   * endTurnGate 用此字段在 "buffer 空 + has goal" 路径区分讨论型放行 vs 从未交付拦截。
   * spec: 2026-06-07-goal-audit-async-buffered-info-design.md §4.13.3
   */
  everSentMessage: boolean
  /**
   * Task 生命周期内是否至少一次 send_message(intent='info') 进过 outboundBuffer
   * （即"worker 交付过但可能被 audit 拦下/丢弃"）。一旦置 true 不再清零。
   *
   * endTurnGate 用它区分 NO_DELIVERY 提示的两种情形：从未调过 send_message（保持
   * 原文案）vs 调过但被 audit 拦下（换文案——否则 worker 看到"你从未交付"会
   * 原样重发同一条消息，trace e1c9663f 死循环成因之三）。
   * spec: 2026-06-10-audit-anchor-human-request §3.5
   */
  everBufferedMessage: boolean
  /**
   * endTurnGate "buffer 空 + has goal + !everSentMessage" 路径已塞 GOAL_MODE_NO_DELIVERY_PROMPT 次数。
   * 累计 3 次仍 silent end_turn → 第 4 次切换强制派 audit subagent 路径（even with empty buffer）。
   * spec: 2026-06-07-goal-audit-async-buffered-info-design.md §4.13.3 / §4.13.4
   */
  silentNoDeliveryRetries: number
  /**
   * Task-scoped 工作根目录（spec 2026-06-08-task-scoped-cwd-design §3.1）。
   * set_cwd 工具改它、Grep/Glob/Read/Write/Bash 默认以它为根。挂在 taskState 上
   * 是为了 runWorkerLoop 跨 iteration 持久——task 进 waiting 后 resume 仍保留 cwd，
   * 否则 resume 重置回 home 会让后续上下文（相对路径解析）错位。
   * undefined = 还未初始化（runWorkerLoop 启动时填 getWorkspaceDir()）。
   */
  cwd?: string
  /**
   * Read 去重缓存（read dedup，仅 main worker 用）。见 engine/tools/file-read-state.ts。
   * 跨 turn 持久（同 task 内重复读同一文件返回 stub 省 token），但**不随 checkpoint 持久**——
   * resume 后为空即可：旧 Read 的 tool_result 此时也已不在新上下文，重新全量读才安全。
   * 压缩（onCompactionStart）时清空。
   */
  readFileState?: import('./engine/tools/file-read-state.js').FileReadState
}

export interface SupplementTaskDecision {
  type: 'supplement_task'
  task_id: TaskId
  supplement_content: string
  /** 用户对当前 supplement 的 task 的否定程度（仅 fail/strong_fail；补充而非纠偏时不填） */
  user_attitude?: UserAttitudeNegOnly
}

// ============================================================================
// 配置热更新
// ============================================================================

export interface UpdateConfigParams {
  /** 更新的模型配置 */
  model_config?: Record<string, LLMConnectionInfo>
  /** 更新的系统提示词 */
  system_prompt?: string
  /** 更新的 MCP Servers */
  mcp_servers?: MCPServerConfig[]
  /** 更新的 Skills */
  skills?: SkillConfig[]
  /** 更新的最大迭代次数 */
  max_iterations?: number
  /** 更新的扩展配置 */
  extra?: Record<string, unknown>
  /** Phase 5: 更新的 Subagent 列表 */
  subagents?: SubAgentConfig[]
  /** 对外可达 base URL（tmp-page 链接用）；admin push 时带上，更新到 this.agentConfig 供下个 worker handler 读 */
  tmp_page_base_url?: string
}

export interface UpdateConfigResult {
  /** 是否需要重启 */
  restart_required: boolean
  /** 更新后的配置 */
  config: AgentLayerConfig
  /** 变更的字段列表 */
  changed_fields: string[]
}

export interface GetConfigResult {
  config: AgentLayerConfig
}

// ============================================================================
// 类型别名
// ============================================================================

export type { ModuleId, FriendId, SessionId, TaskId, ScheduleId }

// ============================================================================
// Trace 可观测性（对齐 protocol-agent-v2.md §8）
// ============================================================================

export type AgentSpanType =
  | 'agent_loop'
  | 'llm_call'
  | 'tool_call'
  | 'sub_agent_call'
  | 'decision'
  | 'context_assembly'
  | 'context_fetch'
  | 'memory_write'
  | 'rpc_call'
  // bg-entities lifecycle events. Plan 2 §9.1 引入；Plan 3 Task 20 wire emission。
  // 当前仅 'bg_entity_exit' 实际 emit；spawn/output/kill 的信息已通过对应 tool_call
  // 完整记录，留在 union 里只为兼容历史 trace 渲染（参 Traces/index.tsx）。
  | 'bg_entity_spawn'
  | 'bg_entity_output'
  | 'bg_entity_kill'
  | 'bg_entity_exit'
  // Dispatcher span types（2026-05-19 引入）
  | 'dispatch_call'
  | 'dispatch_action'

export interface AgentLoopDetails {
  loop_label?: string
  iteration_count?: number
  /** 来自 SDK init 事件 */
  system_prompt?: string
  model?: string
  tools?: string[]
  mcp_servers?: Array<{ name: string; status: string }>
  skills?: string[]
}

/** Token 用量；对齐 protocol-agent-v2.md §8.2 TokenUsage */
export interface TokenUsage {
  input_tokens: number
  output_tokens: number
  /** Anthropic prompt caching：写入缓存的 token 数 */
  cache_creation_tokens?: number
  /** 命中缓存读取的 token 数（OpenAI cached_tokens 也归此） */
  cache_read_tokens?: number
}

export interface LlmCallDetails {
  iteration?: number
  attempt?: number
  input_summary?: string
  output_summary?: string
  stop_reason?: string
  tool_calls_count?: number
  full_input?: string
  full_output?: string
  /** 1-indexed；存在表示本轮由"沉默 end_turn 追问"机制触发 */
  forced_summary_attempt?: number
  usage?: TokenUsage
  /** 该 turn 结束时 messages[] 的长度，供 trace UI 把 span 映射到 messages 切片。 */
  message_count_after?: number
  /** 本轮成功前的流式重试次数（0 = 一次成功） */
  stream_retries?: number
  /** 首 chunk 延迟（ms）；排查"静默连接被掐"类问题用 */
  first_chunk_ms?: number
  /** 本轮收到的流 chunk 数 */
  chunk_count?: number
}

export interface ToolCallDetails {
  tool_name: string
  input_summary: string
  output_summary?: string
  error?: string
  /** 指向 sub-agent 的独立 trace（delegate_task 等场景） */
  child_trace_id?: string
  /** 本工具对应的 tool_use id,供 UI 从 messages 精确匹配完整 I/O。 */
  tool_use_id?: string
}

export interface SubAgentCallDetails {
  target_module_id: string
  method: string
  child_trace_id?: string
  task_id?: string
}

export interface DecisionDetails {
  decision_type: string
  summary: string
}

export interface ContextAssemblyDetails {
  context_type: 'front' | 'worker'
  channel_id?: string
  session_id?: string
  message_batch?: Array<{
    sender: string
    text: string
    is_mention_crab: boolean
  }>
}

export interface MemoryWriteDetails {
  friend_id: string
  channel_id: string
}

export interface RpcCallDetails {
  target_module: string
  target_port: number
  method: string
  request_summary: string
  response_summary?: string
  status_code?: number
  error?: string
}

/** dispatch_call span details（对齐 dispatcher.ts emit 字段） */
export interface DispatchCallDetails {
  /** Dispatcher 使用的 LLM 模型 ID */
  model?: string
  /** 触发本次 dispatch 的会话类型（master/regular 等） */
  session_type?: string
  /** 本轮处理的消息批次大小 */
  message_count?: number
  /** dispatcher 看到的活跃任务数（fetchActiveTasks 结果，已过滤 scheduled） */
  active_task_count?: number
  /** SessionLane take 整批的大小；> 1 表示有合并发生（私聊 = 消息条数；群聊 = attention batch 数） */
  lane_batch_size?: number
  /** completed 后追加：本次解析到的动作数 */
  action_count?: number
  /** completed/failed 后追加：解析重试次数（0 = 首次成功） */
  retries?: number
  /** failed 后追加：最后错误信息（截断 200 字符） */
  error?: string
}

/** dispatch_action span details（对齐 dispatcher-executor.ts buildActionSpanDetails + endSpan 字段） */
export interface DispatchActionDetails {
  /** 动作类型 */
  kind: 'supplement' | 'new_task' | 'stay_silent'
  /** supplement 专用：目标 task id */
  target_task_id?: string
  /** supplement / new_task 专用：文本摘要（截断 200 字符） */
  text_summary?: string
  /** stay_silent 专用：原因（当 action.reason 存在时写入） */
  reason?: string
  /** 完成后追加：动作结果。
   *  - supplement_delivered: pushSupplement 成功
   *  - supplement_fallback_recovered: pushSupplement 返回 fallback → 自动降级 new_task（attempted_target_task_id 记录原 LLM 输出）
   *  - new_task_spawned: 直接 spawn
   *  - silent_discard: 群聊 stay_silent
   *  注：supplement_fallback 这个旧 outcome 已不再产生（被 supplement_fallback_recovered 取代），保留枚举值仅为兼容历史 trace 数据。 */
  outcome?:
    | 'supplement_fallback'
    | 'supplement_fallback_recovered'
    | 'supplement_delivered'
    | 'new_task_spawned'
    | 'silent_discard'
  /** new_task 完成后追加：spawn 出的子 trace id；
   *  supplement_fallback_recovered 时也可填（降级到 new_task 后的子 trace）。 */
  spawned_trace_id?: string
  /** supplement_fallback_recovered 专用：原 LLM 输出的（不存在的）target_task_id，便于排查 LLM 编造行为。 */
  attempted_target_task_id?: string
  /** supplement_fallback_recovered 专用：降级路径标记。 */
  recovered_via?: 'new_task'
  /** 失败时追加：错误信息 */
  error?: string
}

export type AgentSpanDetails =
  | AgentLoopDetails
  | LlmCallDetails
  | ToolCallDetails
  | SubAgentCallDetails
  | DecisionDetails
  | ContextAssemblyDetails
  | MemoryWriteDetails
  | RpcCallDetails
  | DispatchCallDetails
  | DispatchActionDetails

export interface AgentSpan {
  span_id: string
  parent_span_id?: string
  trace_id: string
  type: AgentSpanType
  started_at: string
  ended_at?: string
  duration_ms?: number
  status: 'running' | 'completed' | 'failed'
  details: AgentSpanDetails
}

/** worker trace 上的 resume 快照（仅 trigger.type==='task' 的 worker trace 填）。 */
export interface WorkerStateSnapshot {
  /** todoStore 序列化（就地 merge 无法从 messages 重建） */
  todo_items: import('./agent/worker-todo-store.js').TodoItem[]
  /** 改目标券是否已解锁（可选，丢了顶多改目标被门控一次） */
  goal_revision_unlocked?: boolean
  /**
   * Task-scoped 工作根目录（set_cwd 设置）。无法从 messages 重建，必须随 checkpoint
   * 持久——否则跨重启 resume 后 cwd 回退到 home，相对路径解析错位、后续上下文出问题。
   */
  cwd?: string
}

/**
 * resume 时必须复原的「worker 执行身份/权限上下文」子集。
 *
 * 决定 worker 能用哪些工具、消息往哪投、用什么 report mode 的全部输入都在这里。
 * 缺了它们，resumed worker 会落进 FAIL_CLOSED_TOOL_ACCESS（几乎无工具）+ 投递到
 * SYSTEM_SESSION（联系不到原会话）。endpoints / memories / sandbox 这类可重新拉取
 * 或会过期的字段**不**存，resume 时由 assembleScheduledTaskContext 重新装配。
 */
export interface ResumeWorkerContext {
  task_origin?: TaskOrigin
  sender_friend?: Friend
  memory_permissions?: WorkerAgentContext['memory_permissions']
  resolved_permissions?: ResolvedPermissions
  scene_profile?: RuntimeSceneProfile
}

export interface ResumeCheckpoint {
  /** agent 构建版本，upgrade 不匹配时拒绝 resume */
  agent_version: string
  /** 调试展示用；resume 时现重建、不回放 */
  system_prompt: string
  /** 累积快照（latest-wins，干净 turn 边界） */
  messages: EngineMessage[]
  worker_state: WorkerStateSnapshot
  /** worker 执行上下文子集；缺失（旧 checkpoint）时 resume 回退到从 task.source 重建 task_origin */
  worker_context?: ResumeWorkerContext
}

export interface AgentTrace {
  trace_id: string
  parent_trace_id?: string
  parent_span_id?: string
  /** 关联的任务 ID（Front/Worker/Sub-agent 通过此字段关联） */
  related_task_id?: string
  module_id: string
  started_at: string
  ended_at?: string
  duration_ms?: number
  status: 'running' | 'completed' | 'failed'
  trigger: {
    type: 'message' | 'task' | 'schedule' | 'sub_agent_call'
    summary: string
    source?: string
    /** 触发子类型分类标签。
     *  - 调度任务：如 'daily_reflection'
     *  - sub_agent_call 子 trace：如 'goal_audit'（Phase 2 起）
     *  其它情况可缺省。 */
    task_type?: string
  }
  spans: AgentSpan[]
  outcome?: {
    summary: string
    error?: string
  }
  /** trace 结束时由 trace-store 从所有 llm_call span 聚合得出 */
  total_usage?: TokenUsage
  /** worker resume 快照；per-turn 覆盖写，仅 worker trace 有。 */
  resume_checkpoint?: ResumeCheckpoint
}

export interface TraceCallback {
  onLoopStart(loopLabel?: string, initData?: {
    system_prompt?: string
    model?: string
    tools?: string[]
    mcp_servers?: Array<{ name: string; status: string }>
    skills?: string[]
  }): string
  onLoopEnd(spanId: string, status: 'completed' | 'failed', iterationCount: number): void
  /** `startedAtMs`/`endedAtMs` back-date spans for post-hoc callers (e.g.
   * agent-handler's onTurn fires after the LLM call already completed). */
  onLlmCallStart(iteration: number, inputSummary: string, attempt?: number, startedAtMs?: number): string
  onLlmCallEnd(spanId: string, result: { stopReason?: string; outputSummary?: string; toolCallsCount?: number; error?: string; forcedSummaryAttempt?: number; usage?: TokenUsage; messageCountAfter?: number; diagnostics?: import('./engine/types.js').LLMCallDiagnostics }, endedAtMs?: number): void
  onToolCallStart(toolName: string, inputSummary: string, startedAtMs?: number, toolUseId?: string): string
  /**
   * `childTraceId` 标识由本次工具调用派生出的子 trace（如 `delegate_task` 派 subagent）。
   * 写入后 Admin UI 可从该 tool_call span 内联展开子 trace span 树。
   */
  onToolCallEnd(spanId: string, outputSummary: string, error?: string, endedAtMs?: number, childTraceId?: string): void
}

// ============================================================================
// 场景画像（SceneProfile）— 对齐 protocol-memory.md v0.3.0
// 注：v0.3.0 移除 global 分支；跨场景规则走 agent 模块的 AI 性格提示词
// ============================================================================

export type SceneIdentity =
  | { type: 'friend'; friend_id: string }
  | { type: 'group_session'; channel_id: string; session_id: string }

export interface SceneProfile {
  scene: SceneIdentity
  label: string
  content: string
  source_memory_ids?: string[]
  created_at: string
  updated_at: string
  last_declared_at?: string | null
}

export interface RuntimeSceneProfile {
  label: string
  content: string
  source: {
    scene: SceneIdentity
  }
}
