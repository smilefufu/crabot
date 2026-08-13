/**
 * Manager episode trace 类型（protocol-agent-v3 §8.4 逐字段对齐）。
 *
 * 与 legacy AgentTrace 是两套 record：manager episode 不进入 legacy taskIndex/TraceTree，
 * 持久化行通过 kind discriminator 区分（无 kind 的历史行按 legacy AgentTrace 读取）。
 */

import type { ManagerKey } from '../workers/harness/ledger-types.js'
import type { AgentTrace } from '../types.js'

export interface ManagerEpisodeTrigger {
  type: 'human_message' | 'worker_event' | 'schedule' | 'attention_flush' | 'sub_agent_call'
  /** 脱敏摘要；不复制完整人类正文/terminal output/tool secret */
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
  /** 脱敏后的 span 细节（写盘前必须过 redact） */
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
  manager_key: ManagerKey
  started_at: string
  ended_at?: string
  duration_ms?: number
  status: 'running' | 'completed' | 'failed'
  trigger: ManagerEpisodeTrigger
  spans: ManagerEpisodeSpan[]
  spawned_worker_ids: string[]
  outcome?: { summary: string; error?: string }
  total_usage?: ManagerEpisodeUsage
}

/** 持久化 record 判别：新 record 带 kind；无 kind 的历史 JSONL 行按 legacy AgentTrace 读取。 */
export type PersistedTraceRecord =
  | { kind: 'legacy_agent_trace'; trace: AgentTrace }
  | { kind: 'manager_episode'; trace: ManagerEpisodeTrace }

export function wrapManagerEpisodeRecord(trace: ManagerEpisodeTrace): PersistedTraceRecord {
  return { kind: 'manager_episode', trace }
}

/** 解析一条 JSONL 行；无法解析返回 null。legacy 无 kind 行 → AgentTrace。 */
export function parseTraceRecordLine(line: string): PersistedTraceRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  if (record.kind === 'manager_episode') {
    const trace = record.trace as ManagerEpisodeTrace | undefined
    return trace && isValidManagerEpisodeTrace(trace) ? { kind: 'manager_episode', trace } : null
  }
  if (record.kind === 'legacy_agent_trace') {
    const trace = record.trace as AgentTrace | undefined
    return trace && typeof trace.trace_id === 'string' ? { kind: 'legacy_agent_trace', trace } : null
  }
  // 无 kind：legacy AgentTrace 原样行。
  if (typeof record.trace_id === 'string') return { kind: 'legacy_agent_trace', trace: parsed as AgentTrace }
  return null
}

/** manager record 的最小结构校验；坏 record 由调用方隔离并报告，不得拖垮 legacy index。 */
export function isValidManagerEpisodeTrace(trace: unknown): trace is ManagerEpisodeTrace {
  if (!trace || typeof trace !== 'object') return false
  const value = trace as Record<string, unknown>
  return (
    typeof value.trace_id === 'string' && value.trace_id.length > 0
    && typeof value.manager_key === 'string' && value.manager_key.length > 0
    && typeof value.started_at === 'string' && Number.isFinite(Date.parse(value.started_at))
    && (value.status === 'running' || value.status === 'completed' || value.status === 'failed')
    && !!value.trigger && typeof value.trigger === 'object'
    && Array.isArray(value.spans)
    && Array.isArray(value.spawned_worker_ids)
  )
}
