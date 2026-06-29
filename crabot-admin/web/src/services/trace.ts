/**
 * Trace 服务 - Agent 执行 Trace 的 REST 调用封装
 * 字段对齐 protocol-agent-v2.md §8
 */

import { api } from './api'

/**
 * 跨 Provider 统一语义：
 *   input_tokens         = 未命中缓存的输入 token（实际计费的 prompt 部分）
 *   cache_read_tokens    = 命中缓存读取的部分（> 0 即代表本次有缓存命中）
 *   cache_creation_tokens = 写入缓存的部分（Anthropic 专属）
 *   全量 prompt size     = input_tokens + (cache_read_tokens ?? 0) + (cache_creation_tokens ?? 0)
 */
export interface TokenUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_tokens?: number
  cache_read_tokens?: number
}

/** 全量 prompt size（含命中和写入）。 */
export function totalPromptTokens(u: TokenUsage): number {
  return u.input_tokens + (u.cache_read_tokens ?? 0) + (u.cache_creation_tokens ?? 0)
}

/** 缓存命中率（0-1）；无缓存返回 0。 */
export function cacheHitRate(u: TokenUsage): number {
  const total = totalPromptTokens(u)
  if (total === 0) return 0
  return (u.cache_read_tokens ?? 0) / total
}

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
  | 'bg_entity_spawn'
  | 'bg_entity_output'
  | 'bg_entity_kill'
  | 'bg_entity_exit'
  | 'llm_retry'
  | 'dispatch_call'
  | 'dispatch_action'

export interface AgentSpan {
  span_id: string
  parent_span_id?: string
  trace_id: string
  type: AgentSpanType
  started_at: string
  ended_at?: string
  duration_ms?: number
  status: 'running' | 'completed' | 'failed'
  details: Record<string, unknown>
}

/** llm_call span 的 details 附加字段（其余字段仍走 Record<string, unknown>）。 */
export interface LlmCallSpanDetails {
  model?: string
  input_tokens?: number
  output_tokens?: number
  /** 本次 llm_call 执行后，Worker 消息数组的累积长度（用于切片本轮产出消息）。 */
  message_count_after?: number
  [key: string]: unknown
}

export interface AgentTrace {
  trace_id: string
  parent_trace_id?: string
  parent_span_id?: string
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
    task_type?: string
  }
  spans: AgentSpan[]
  outcome?: {
    summary: string
    error?: string
  }
  total_usage?: TokenUsage
  /** Worker trace 恢复检查点：含累积消息快照，供 Task 13/14 UI 切片展示。 */
  resume_checkpoint?: {
    agent_version: string
    system_prompt: string
    messages: EngineMessageLike[]
    worker_state: { todo_items: unknown[]; goal_revision_unlocked?: boolean }
  }
}

/** Worker Engine 消息的前端宽松镜像（role + content/toolResults）。 */
export interface EngineMessageLike {
  id: string
  role: 'user' | 'assistant'
  content?: string | unknown[]
  toolResults?: unknown[]
  timestamp: number
  stopReason?: string
}

/** 列表场景使用的轻量级索引（不含 spans，含汇总 token）。 */
export interface TraceIndexEntry {
  trace_id: string
  related_task_id?: string
  parent_trace_id?: string
  trigger_type: string
  trigger_summary: string
  trigger_task_type?: string
  started_at: string
  ended_at?: string
  duration_ms?: number
  status: 'running' | 'completed' | 'failed'
  outcome_summary?: string
  span_count: number
  total_usage?: TokenUsage
}

export interface TraceTree {
  task_id: string
  tree: {
    fronts: TraceIndexEntry[]
    /** 一个 task 可能有多条 worker run（resume 续起时另起新 trace）；全部返回，按时间升序。 */
    workers: TraceIndexEntry[]
    subagents: TraceIndexEntry[]
  }
}

export interface SearchTracesResult {
  traces: TraceIndexEntry[]
  total: number
}

export interface SearchTracesParams {
  task_id?: string
  keyword?: string
  status?: 'running' | 'completed' | 'failed'
  /** ISO 8601；start <= started_at < end */
  start?: string
  end?: string
  limit?: number
  offset?: number
}

export const traceService = {
  /**
   * 列表查询：合并磁盘索引 + 内存中正在运行的 trace，支持分页与过滤。
   * 比 getTraces 轻量（不含 spans），用于 Traces 页主列表。
   */
  async searchTraces(params?: SearchTracesParams): Promise<SearchTracesResult> {
    const qs = new URLSearchParams()
    if (params?.task_id) qs.set('task_id', params.task_id)
    if (params?.keyword) qs.set('keyword', params.keyword)
    if (params?.status) qs.set('status', params.status)
    if (params?.start) qs.set('start', params.start)
    if (params?.end) qs.set('end', params.end)
    if (params?.limit !== undefined) qs.set('limit', String(params.limit))
    if (params?.offset !== undefined) qs.set('offset', String(params.offset))
    const query = qs.toString() ? `?${qs.toString()}` : ''
    return api.get<SearchTracesResult>(`/agent/traces/search${query}`)
  },

  /** 详情：含 spans，按需加载（可能从磁盘 JSONL 回捞） */
  async getTrace(traceId: string): Promise<{ trace: AgentTrace }> {
    return api.get(`/agent/traces/${traceId}`)
  },

  async getTraceTree(taskId: string): Promise<TraceTree> {
    return api.get<TraceTree>(`/agent/trace-tree/${taskId}`)
  },

  async clearTraces(_params?: {
    before?: string
    trace_ids?: string[]
  }): Promise<{ cleared_count: number }> {
    return api.delete(`/agent/traces`)
  },

  async getDiskUsage(): Promise<{ total_bytes: number; trace_count: number; oldest_iso?: string; newest_iso?: string }> {
    return api.get('/agent/traces/disk-usage')
  },

  async cleanupOld(days: number, dryRun: boolean): Promise<{ affected_count: number; affected_bytes: number; deleted_trace_ids: string[] }> {
    return api.delete(`/agent/traces/old?days=${days}&dry_run=${dryRun}`)
  },

  /**
   * spec 2026-06-09-task-trace-tool-unification.md §4.3: 按 task 维度合并列表（task + 孤儿 dispatcher）。
   * 后端 union 分页，前端拿到统一 ConversationUnit[]。
   */
  async listConversationUnits(params: ListConversationUnitsParams): Promise<ListConversationUnitsResult> {
    return api.post<ListConversationUnitsResult>(`/admin/conversation-units`, params)
  },

  /** 永久删除单条 task（活跃 task 后端会拒绝） */
  async deleteTask(taskId: string): Promise<{ deleted: boolean }> {
    return api.delete<{ deleted: boolean }>(`/admin/tasks/${encodeURIComponent(taskId)}`)
  },
}

// ============================================================================
// spec 2026-06-09-task-trace-tool-unification.md §4.3 Conversation Units types
// ============================================================================

/** Admin 视角下的 trace 元数据子集（admin types.ts TraceSummary 镜像）。 */
export interface TraceSummary {
  trace_id: string
  related_task_id?: string
  trigger_type: string
  trigger_summary: string
  started_at: string
  ended_at?: string
  duration_ms?: number
  status: 'running' | 'completed' | 'failed'
  outcome_summary?: string
}

/** Admin task 元数据子集（前端列表用）。 */
export interface ConvTaskBrief {
  id: string
  status: string
  priority: string
  title: string
  source: {
    origin?: string
    channel_id?: string
    session_id?: string
    friend_id?: string
    trigger_type: string
  }
  tags: string[]
  created_at: string
  updated_at: string
  started_at?: string
  completed_at?: string
  pending_question?: string
  messages: Array<{ id: string; role: string; content: string; timestamp: string }>
  result?: {
    outcome: string
    outcome_brief?: string
    finished_at: string
  }
  goal?: {
    objective: string
    status: string
  }
}

export type ConversationUnit =
  | {
      kind: 'task'
      task: ConvTaskBrief
      trace_count: number
      worker_trace_id: string | null
    }
  | {
      kind: 'orphan_dispatcher'
      trace: TraceSummary
    }

export interface ListConversationUnitsParams {
  filter?: {
    status?: string | string[]
    source_channel_id?: string
    source_session_id?: string
    search?: string
    created_after?: string
    created_before?: string
    trigger_type?: 'message' | 'task' | 'all'
  }
  sort?: { field: 'created_at' | 'updated_at'; order: 'asc' | 'desc' }
  page: number
  page_size: number
}

export interface ListConversationUnitsResult {
  items: ConversationUnit[]
  pagination: { page: number; page_size: number; total_items: number; total_pages: number }
}
