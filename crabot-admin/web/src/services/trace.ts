/**
 * Trace 服务 - Agent 执行 Trace 的 REST 调用封装
 */

import { api } from './api'

export interface AgentSpan {
  span_id: string
  parent_span_id?: string
  trace_id: string
  type: 'agent_loop' | 'llm_call' | 'tool_call' | 'sub_agent_call' | 'decision' | 'context_assembly' | 'memory_write' | 'rpc_call'
  started_at: string
  ended_at?: string
  duration_ms?: number
  status: 'running' | 'completed' | 'failed'
  details: Record<string, unknown>
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
  }
  spans: AgentSpan[]
  outcome?: {
    summary: string
    error?: string
  }
}

export interface GetTracesResult {
  traces: AgentTrace[]
  total: number
}

export interface TraceIndexEntry {
  trace_id: string
  related_task_id?: string
  parent_trace_id?: string
  trigger_type: string
  trigger_summary: string
  started_at: string
  ended_at?: string
  status: 'running' | 'completed' | 'failed'
  outcome_summary?: string
  span_count: number
}

export interface TraceTree {
  task_id: string
  tree: {
    fronts: TraceIndexEntry[]
    worker: TraceIndexEntry | null
    subagents: TraceIndexEntry[]
  }
}

export interface SearchTracesResult {
  traces: TraceIndexEntry[]
  total: number
}

export const traceService = {
  async getTraces(params?: {
    limit?: number
    offset?: number
    status?: string
  }): Promise<GetTracesResult> {
    const qs = new URLSearchParams()
    if (params?.limit) qs.set('limit', String(params.limit))
    if (params?.offset) qs.set('offset', String(params.offset))
    if (params?.status) qs.set('status', params.status)
    const query = qs.toString() ? `?${qs.toString()}` : ''
    return api.get<GetTracesResult>(`/agent/traces${query}`)
  },

  async getTrace(traceId: string): Promise<{ trace: AgentTrace }> {
    return api.get(`/agent/traces/${traceId}`)
  },

  async searchTraces(params?: {
    task_id?: string
    keyword?: string
    status?: string
    start?: string
    end?: string
    limit?: number
    offset?: number
  }): Promise<SearchTracesResult> {
    const qs = new URLSearchParams()
    if (params?.task_id) qs.set('task_id', params.task_id)
    if (params?.keyword) qs.set('keyword', params.keyword)
    if (params?.status) qs.set('status', params.status)
    if (params?.start) qs.set('start', params.start)
    if (params?.end) qs.set('end', params.end)
    if (params?.limit) qs.set('limit', String(params.limit))
    if (params?.offset) qs.set('offset', String(params.offset))
    const query = qs.toString() ? `?${qs.toString()}` : ''
    return api.get<SearchTracesResult>(`/agent/traces/search${query}`)
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
}
