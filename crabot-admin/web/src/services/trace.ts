/**
 * Trace 服务 - Agent 执行 Trace 的 REST 调用封装
 */

import { api } from './api'

export interface AgentSpan {
  span_id: string
  parent_span_id?: string
  trace_id: string
  type: 'agent_loop' | 'llm_call' | 'tool_call' | 'sub_agent_call' | 'decision' | 'context_assembly' | 'memory_write'
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

  async clearTraces(_params?: {
    before?: string
    trace_ids?: string[]
  }): Promise<{ cleared_count: number }> {
    return api.delete(`/agent/traces`)
  },
}
