/**
 * Agent 可观测性服务（P6-A）—— v3 Manager/Worker 读模型的 REST 封装。
 * 类型逐字段复制 protocol-agent-v3 §8.3/§8.4 read model 与 §10.2 时间线；
 * 不以 legacy AgentTrace/TraceTree/SpanTree 命名 v3 对象。
 */

import { api } from './api'

export interface Pagination {
  page: number
  page_size: number
  total_items: number
  total_pages: number
}

export interface PaginatedResult<T> {
  items: T[]
  pagination: Pagination
}

// ── Manager（§8.4）──────────────────────────────────────────────

export interface ManagerAdminSummary {
  manager_key: string
  display_name: string
  last_activity_at?: string
  recent_activity_summary?: string
  active_worker_count: number
}

export interface ManagerEpisodeTrigger {
  type: 'human_message' | 'worker_event' | 'schedule' | 'attention_flush' | 'sub_agent_call'
  summary: string
  source?: string
}

export interface ManagerEpisodeSpan {
  span_id: string
  parent_span_id?: string
  type: 'agent_loop' | 'llm_call' | 'tool_call' | 'sub_agent_call' | 'decision' | 'context_assembly' | 'memory_write' | 'rpc_call'
  started_at: string
  ended_at?: string
  duration_ms?: number
  status: 'running' | 'completed' | 'failed'
  details: unknown
}

export interface ManagerEpisodeUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_tokens?: number
  cache_read_tokens?: number
}

export interface ManagerEpisodeTrace {
  trace_id: string
  manager_key: string
  started_at: string
  ended_at?: string
  duration_ms?: number
  status: 'running' | 'completed' | 'failed'
  trigger: ManagerEpisodeTrigger
  spans: ManagerEpisodeSpan[]
  spawned_worker_ids: string[]
  outcome?: { summary: string; error?: string }
  total_usage?: ManagerEpisodeUsage
  reply_excerpt?: string
  actions?: Array<{
    kind: 'spawn_worker' | 'send_to_worker' | 'cancel_worker' | 'other'
    label: string
    worker_id?: string
  }>
  worker_ref?: { worker_id: string; title?: string; state_to?: string }
  causal_parent?: {
    trace_id: string
    started_at: string
    status: ManagerEpisodeTrace['status']
    trigger: ManagerEpisodeTrigger
    outcome?: ManagerEpisodeTrace['outcome']
    reply_excerpt?: string
    actions?: ManagerEpisodeTrace['actions']
  }
}

// ── Worker（§8.3 台账 read model）──────────────────────────────

// 2026-08-31 状态机修正:4 态。旧值(waiting_input/completed/failed/cancelled)仅存在于
// 历史 trace 数据,徽章映射保留旧键做兼容显示。
export type WorkerTaskStatus =
  | 'queued' | 'running' | 'halted' | 'closed'

export interface WorkerIncarnation {
  incarnation_id?: string
  seq: number
  impl: 'builtin' | 'claude-code' | 'codex' | 'legacy'
  state: string
  workspace: string
  started_at: string
  ended_at?: string
  ended_reason?: string
  session_ref?: string
  forked_from?: number | string
}

export interface LedgerWorker {
  worker_id: string
  manager_key: string
  task: {
    id: string
    type?: string
    title: string
    status: WorkerTaskStatus
    priority?: string
    tags?: string[]
    goal?: string
    created_at: string
    /** 载体停止的事实记录(status='halted'),spec 2026-08-31-worker-stop-oversight-design §5.1 */
    halt?: {
      halted_at: string
      halt_reason: string
      worker_self_report?: { outcome: 'completed' | 'failed'; summary: string }
      stop_unverified?: boolean
      detail?: string
    }
    /** 关闭信息(status='closed'),含迁移来源旧值备注 */
    closed?: { at: string; by: string; note?: string }
    error?: string
  }
  origin: {
    spawned_by_episode?: string
    creator_friend_id?: string
    trigger_type: 'message' | 'scheduled' | 'system'
  }
  report_to: { channel_id: string; session_id: string }
  incarnations: WorkerIncarnation[]
  legacy_source?: { kind: string; admin_task_id?: string; trace_ids?: string[]; imported_at?: string }
  updated_at: string
}

export interface WorkerListResult extends PaginatedResult<LedgerWorker> {
  total_active: number
  total_terminal: number
  total_legacy: number
}

export interface WorkerTraceEvent {
  ts: string
  kind: 'message' | 'llm_call' | 'tool_call' | 'tool_result' | 'thinking' | 'lifecycle' | 'error'
  role?: 'assistant' | 'user' | 'system'
  summary: string
  subagent_id?: string
  detail?: unknown
  source?: 'harness' | 'native' | 'legacy'
}

export interface WorkerTraceResult {
  events: WorkerTraceEvent[]
  next_cursor?: string
  unavailable_reason?: string
}

export type WorkerSubagentStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted' | 'unknown'

export interface WorkerSubagentSummary {
  subagent_id: string
  worker_id: string
  executor_impl: 'builtin' | 'claude-code' | 'codex'
  type?: string
  name: string
  task?: string
  status: WorkerSubagentStatus
  started_at?: string
  ended_at?: string
  unavailable_reason?: string
}

export interface WorkerSubagentTraceResult {
  events: WorkerTraceEvent[]
  next_cursor: string
  unavailable_reason?: string
}

export type WorkerTerminalView =
  | { kind: 'live_terminal'; text: string; captured_at: string }
  | { kind: 'final_terminal'; text: string; captured_at: string }
  | { kind: 'headless_text'; text: string; captured_at?: string }
  | { kind: 'unavailable'; unavailable_reason: string }

// ── 维护面（保留的专用 API）─────────────────────────────────────

export interface TraceDiskUsage {
  total_bytes: number
  trace_count: number
  oldest_iso?: string
  newest_iso?: string
}

export interface TraceCleanupResult {
  affected_count: number
  affected_bytes: number
  deleted_trace_ids: string[]
}

// ── API ────────────────────────────────────────────────────────

function qs(page: number, pageSize: number): string {
  return `page=${page}&page_size=${pageSize}`
}

export const agentObservabilityService = {
  listManagers(page = 1, pageSize = 20): Promise<PaginatedResult<ManagerAdminSummary>> {
    return api.get(`/agent/managers?${qs(page, pageSize)}`)
  },

  listManagerEpisodes(managerKey: string, page = 1, pageSize = 20): Promise<PaginatedResult<ManagerEpisodeTrace>> {
    return api.get(`/agent/managers/${encodeURIComponent(managerKey)}/episodes?${qs(page, pageSize)}`)
  },

  listWorkers(params: {
    status?: string | string[]
    manager_key?: string
    impl?: string
    q?: string
    include_terminal?: boolean
    include_legacy?: boolean
    start?: string
    end?: string
    page?: number
    page_size?: number
  }): Promise<WorkerListResult> {
    const search = new URLSearchParams()
    const statuses = Array.isArray(params.status) ? params.status : params.status ? [params.status] : []
    for (const status of statuses) search.append('status', status)
    if (params.manager_key) search.set('manager_key', params.manager_key)
    if (params.impl) search.set('impl', params.impl)
    if (params.q) search.set('q', params.q)
    if (params.include_terminal) search.set('include_terminal', 'true')
    if (params.include_legacy) search.set('include_legacy', 'true')
    if (params.start) search.set('start', params.start)
    if (params.end) search.set('end', params.end)
    search.set('page', String(params.page ?? 1))
    search.set('page_size', String(params.page_size ?? 20))
    return api.get(`/agent/workers?${search.toString()}`)
  },

  getWorkerDetail(workerId: string): Promise<{ worker: LedgerWorker }> {
    return api.get(`/agent/workers/${encodeURIComponent(workerId)}`)
  },

  getWorkerTrace(workerId: string, opts: { seq?: number; cursor?: string } = {}): Promise<WorkerTraceResult> {
    const search = new URLSearchParams()
    if (opts.seq !== undefined) search.set('seq', String(opts.seq))
    // cursor 原样透传，不解析/生成/默认化（P6-A §9.2）
    if (opts.cursor !== undefined) search.set('cursor', opts.cursor)
    const suffix = search.toString()
    return api.get(`/agent/workers/${encodeURIComponent(workerId)}/trace${suffix ? `?${suffix}` : ''}`)
  },

  getWorkerTerminal(workerId: string, opts: { seq?: number } = {}): Promise<WorkerTerminalView> {
    const search = new URLSearchParams()
    if (opts.seq !== undefined) search.set('seq', String(opts.seq))
    const suffix = search.toString()
    return api.get(`/agent/workers/${encodeURIComponent(workerId)}/terminal${suffix ? `?${suffix}` : ''}`)
  },

  listWorkerSubagents(workerId: string, incarnationId?: string): Promise<{ subagents: WorkerSubagentSummary[] }> {
    const search = new URLSearchParams()
    if (incarnationId) search.set('incarnation_id', incarnationId)
    const suffix = search.toString()
    return api.get(`/agent/workers/${encodeURIComponent(workerId)}/subagents${suffix ? `?${suffix}` : ''}`)
  },

  getWorkerSubagentDetail(workerId: string, subagentId: string): Promise<{ subagent: WorkerSubagentSummary }> {
    return api.get(`/agent/workers/${encodeURIComponent(workerId)}/subagents/${encodeURIComponent(subagentId)}`)
  },

  getWorkerSubagentTrace(workerId: string, subagentId: string, cursor?: string): Promise<WorkerSubagentTraceResult> {
    const search = new URLSearchParams()
    if (cursor) search.set('cursor', cursor)
    const suffix = search.toString()
    return api.get(`/agent/workers/${encodeURIComponent(workerId)}/subagents/${encodeURIComponent(subagentId)}/trace${suffix ? `?${suffix}` : ''}`)
  },

  // ── 维护面 ──
  getTraceDiskUsage(): Promise<TraceDiskUsage> {
    return api.get('/agent/traces/disk-usage')
  },

  cleanupOldTraces(days: number, dryRun: boolean): Promise<TraceCleanupResult> {
    return api.delete(`/agent/traces/old?days=${days}&dry_run=${dryRun}`)
  },
}
