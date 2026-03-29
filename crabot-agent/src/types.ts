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
} from './core/base-protocol.js'

// ============================================================================
// 配置
// ============================================================================

export interface OrchestrationConfig {
  /** Admin 共享存储路径 */
  admin_config_path: string
  /** Front Agent 上下文中的近期聊天记录数量上限 */
  front_context_recent_messages_limit: number
  /** Front Agent 上下文中的短期记忆数量上限 */
  front_context_memory_limit: number
  /** Worker Agent 上下文中的近期聊天记录数量上限 */
  worker_recent_messages_limit: number
  /** Worker Agent 上下文中的短期记忆数量上限 */
  worker_short_term_memory_limit: number
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
  /** 支持的任务类型 */
  supported_task_types?: string[]
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
  }>
  created_at: string
  updated_at: string
}

export interface SessionPermissionConfig {
  desktop: boolean
  network: {
    mode: 'allow_all' | 'whitelist' | 'blacklist'
    rules: string[]
  }
  storage: Array<{
    path: string
    access: 'read' | 'readwrite'
  }>
  memory_scopes: string[]
  template_id?: string
  updated_at: string
}

// ============================================================================
// Worker 选择
// ============================================================================

export interface WorkerRoutingInfo {
  worker_id: ModuleId
  specialization: string
  supported_task_types: string[]
  available_capacity: number
}

// ============================================================================
// 消息类型（对齐 base-protocol.md）
// ============================================================================

export type MessageType = 'text' | 'image' | 'file'

export interface MessageContent {
  type: MessageType
  text?: string
  media_url?: string
  file_path?: string
  filename?: string
  mime_type?: string
  size?: number
}

export interface ChannelMessage {
  platform_message_id: string
  session: {
    session_id: SessionId
    channel_id: ModuleId
    type: 'private' | 'group'
  }
  sender: {
    /** Admin 鉴权后填充，channel.message_authorized 阶段一定存在 */
    friend_id: FriendId
    platform_user_id: string
    platform_display_name: string
  }
  content: MessageContent
  features: {
    mentions?: Array<{ friend_id: FriendId; platform_user_id: string }>
    quote_message_id?: string
    is_mention_crab: boolean
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
  task_type: string
  priority: string
  plan_summary?: string
  source_channel_id?: ModuleId
  source_session_id?: SessionId
  latest_progress?: string
}

export interface ShortTermMemoryEntry {
  memory_id: string
  content: string
  timestamp: string
  metadata?: Record<string, unknown>
}

export interface LongTermL0Entry {
  memory_id: string
  content: string
  timestamp: string
  metadata?: Record<string, unknown>
}

export interface ResolvedModule {
  module_id: ModuleId
  port: number
  host?: string
}

// ============================================================================
// Agent 上下文（对齐 protocol-agent-v2.md）
// ============================================================================

export interface FrontAgentContext {
  sender_friend: Friend
  recent_messages: ChannelMessage[]
  short_term_memories: ShortTermMemoryEntry[]
  active_tasks: TaskSummary[]
  available_tools: ToolDeclaration[]
  /** Crabot's display name on the current channel (e.g. group nickname) */
  crab_display_name?: string
}

export interface WorkerAgentContext {
  task_origin?: TaskOrigin
  /** Front 做决策时的完整输入消息（定时任务等场景不存在） */
  trigger_messages?: ChannelMessage[]
  /** 发送者信息（定时任务等场景不存在） */
  sender_friend?: Friend
  recent_messages?: ChannelMessage[]
  short_term_memories: ShortTermMemoryEntry[]
  long_term_memories: LongTermL0Entry[]
  available_tools: ToolDeclaration[]
  admin_endpoint: ResolvedModule
  memory_endpoint: ResolvedModule
  channel_endpoints: ResolvedModule[]
  sandbox_path_mappings?: Array<{
    sandbox_path: string
    host_path: string
    read_only: boolean
  }>
}

export interface TaskOrigin {
  channel_id: ModuleId
  session_id: SessionId
  friend_id?: FriendId
}

// ============================================================================
// Agent 决策类型
// ============================================================================

export interface ToolHistoryEntry {
  tool_name: string
  input_summary: string
  output_summary: string
}

export interface DirectReplyDecision {
  type: 'direct_reply'
  reply: MessageContent
}

export interface CreateTaskDecision {
  type: 'create_task'
  task_title: string
  task_description: string
  task_type: string
  priority?: string
  preferred_worker_specialization?: string
  immediate_reply: MessageContent
  /** Front loop context, only set on forced termination (max rounds exceeded) */
  front_context?: ToolHistoryEntry[]
}

export interface ForwardToWorkerDecision {
  type: 'forward_to_worker'
  task_id: TaskId
  immediate_reply?: MessageContent
}

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
  decision_types: Array<'direct_reply' | 'create_task' | 'forward_to_worker'>
  task_ids?: TaskId[]
}

export interface CreateTaskFromScheduleParams {
  schedule_id: ScheduleId
  task_type: string
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
  key: 'default' | 'fast' | 'smart'
  /** 描述说明 */
  description: string
  /** 是否必须 */
  required: boolean
  /** 使用该模型的角色 */
  used_by: Array<'front' | 'worker'>
}

export interface LLMConnectionInfo {
  endpoint: string
  apikey: string
  model_id: string
  format: 'anthropic' | 'openai' | 'gemini'
  max_tokens?: number
}

export interface MCPServerConfig {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface SkillConfig {
  id: string
  name: string
  content: string
}

export interface AgentRole {
  roles: Array<'front' | 'worker'>
  specialization: string
  supported_task_types?: string[]
  max_concurrent_tasks?: number
  models: Record<string, LLMConnectionInfo>
  model_format: 'anthropic' | 'openai' | 'gemini'
  tools?: ToolDeclaration[]
  skills?: SkillConfig[]
}

export interface HandleMessageResult {
  decisions: MessageDecision[]
}

export interface ExecuteTaskResult {
  task_id: TaskId
  outcome: 'completed' | 'failed'
  summary: string
  final_reply?: MessageContent
  memories_to_store?: WriteLongTermParams[]
}

export interface WriteLongTermParams {
  content: string
  category: string
  metadata?: Record<string, unknown>
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

export interface HandleMessageParams {
  messages: ChannelMessage[]
  context: FrontAgentContext
}

export interface ExecuteTaskParams {
  task: {
    task_id: TaskId
    task_title: string
    task_description: string
    task_type: string
    priority: string
    plan?: string
  }
  context: WorkerAgentContext
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
  status: string
  startedAt: string
  title?: string
  abortController: {
    signal: { aborted: boolean }
    abort: () => void
  }
  pendingHumanMessages: ChannelMessage[]
}

export interface SilentDecision {
  type: 'silent'
}

export interface SupplementTaskDecision {
  type: 'supplement_task'
  task_id: TaskId
  supplement_content: string
  confidence: 'high' | 'low'
  immediate_reply: MessageContent
}

export interface FrontLoopResult {
  decision: MessageDecision
  /** Only set on forced termination (max rounds exceeded) */
  toolHistory?: ToolHistoryEntry[]
}

export type MessageDecision =
  | DirectReplyDecision
  | CreateTaskDecision
  | ForwardToWorkerDecision
  | SilentDecision
  | SupplementTaskDecision

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
  | 'memory_write'
  | 'rpc_call'

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

export interface LlmCallDetails {
  iteration?: number
  attempt?: number
  input_summary?: string
  output_summary?: string
  stop_reason?: string
  tool_calls_count?: number
  full_input?: string
  full_output?: string
}

export interface ToolCallDetails {
  tool_name: string
  input_summary: string
  output_summary?: string
  error?: string
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

export type AgentSpanDetails =
  | AgentLoopDetails
  | LlmCallDetails
  | ToolCallDetails
  | SubAgentCallDetails
  | DecisionDetails
  | ContextAssemblyDetails
  | MemoryWriteDetails
  | RpcCallDetails

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

export interface AgentTrace {
  trace_id: string
  parent_trace_id?: string
  parent_span_id?: string
  module_id: string
  started_at: string
  ended_at?: string
  duration_ms?: number
  status: 'running' | 'completed' | 'failed'
  trigger: {
    type: 'message' | 'task' | 'schedule' | 'sub_agent_call'
    summary: string
    source?: string
  }
  spans: AgentSpan[]
  outcome?: {
    summary: string
    error?: string
  }
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
  onLlmCallStart(iteration: number, inputSummary: string, attempt?: number): string
  onLlmCallEnd(spanId: string, result: { stopReason?: string; outputSummary?: string; toolCallsCount?: number; fullInput?: string; fullOutput?: string }): void
  onToolCallStart(toolName: string, inputSummary: string): string
  onToolCallEnd(spanId: string, outputSummary: string, error?: string): void
}

