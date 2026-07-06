import React from 'react'
import {
  type AgentSpan,
  type TokenUsage,
  type EngineMessageLike,
  totalPromptTokens,
  cacheHitRate,
} from '../../services/trace'
import { Tooltip } from '../../components/Common/Tooltip'
import { formatDateTimeLocal, formatDuration, formatTokens, agentLoopLabel } from './utils'
import { TraceLink } from './TraceTable'
import { sliceSpanMessages, findToolIO, extractAssistantOutput } from './messageSlicing'

// ============================================================================
// 子组件：SpanDetailPanel — 单个 span 的详情展开
// ============================================================================

export const SpanDetailPanel: React.FC<{
  span: AgentSpan
  onNavigateTrace?: (traceId: string) => void
  /** Worker trace 累积消息快照（来自 resume_checkpoint.messages）。无则退回旧 summary 行。 */
  messages?: ReadonlyArray<EngineMessageLike>
  /** 所有 llm_call span 按出现顺序排列，带 message_count_after 字段。 */
  orderedLlmSpans?: ReadonlyArray<{ span_id: string; message_count_after?: number }>
  /** 当前 span 在 orderedLlmSpans 中的下标（-1 或 undefined 表示不在列表中）。 */
  spanIndexInLlm?: number
}> = ({ span, onNavigateTrace, messages, orderedLlmSpans, spanIndexInLlm }) => {
  const d = span.details as Record<string, unknown>
  const rows: { label: string; value: string | React.ReactNode; monospace?: boolean }[] = []

  if (span.type === 'agent_loop') {
    const loopLabelText = agentLoopLabel({ loop_label: d.loop_label as string | undefined })
    if (loopLabelText) rows.push({ label: 'Label', value: loopLabelText })
    if (d.model) rows.push({ label: 'Model', value: String(d.model) })
    if (d.iteration_count !== undefined) rows.push({ label: 'Iterations', value: String(d.iteration_count) })
    if (Array.isArray(d.tools) && d.tools.length > 0) {
      rows.push({ label: 'Tools', value: (d.tools as string[]).join(', ') })
    }
    if (Array.isArray(d.mcp_servers) && d.mcp_servers.length > 0) {
      rows.push({
        label: 'MCP Servers',
        value: (d.mcp_servers as Array<{ name: string; status: string }>)
          .map(s => `${s.name}(${s.status})`).join(', '),
      })
    }
    if (Array.isArray(d.skills) && d.skills.length > 0) {
      rows.push({ label: 'Skills', value: (d.skills as string[]).join(', ') })
    }
    if (d.system_prompt) rows.push({ label: 'System Prompt', value: String(d.system_prompt), monospace: true })
  }

  if (span.type === 'llm_call') {
    if (d.iteration !== undefined) rows.push({ label: 'Iteration', value: String(d.iteration) })
    if (d.attempt !== undefined) rows.push({ label: 'Attempt', value: String(d.attempt) })
    if (d.stop_reason) rows.push({ label: 'Stop Reason', value: String(d.stop_reason) })
    if (d.tool_calls_count !== undefined) rows.push({ label: 'Tool Calls', value: String(d.tool_calls_count) })
    const usage = d.usage as TokenUsage | undefined
    if (usage) {
      const cacheRead = usage.cache_read_tokens ?? 0
      const cacheCreate = usage.cache_creation_tokens ?? 0
      const total = totalPromptTokens(usage)
      const hitPct = Math.round(cacheHitRate(usage) * 100)
      rows.push({
        label: 'Tokens',
        value: (
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.6 }}>
            <div>
              <Tooltip content="未命中输入"><span>{formatTokens(usage.input_tokens)}</span></Tooltip>
              <span style={{ color: 'var(--text-muted)', margin: '0 4px' }}>未命中 in →</span>
              <Tooltip content="输出"><span>{formatTokens(usage.output_tokens)}</span></Tooltip>
              <span style={{ color: 'var(--text-muted)', marginLeft: 4 }}>out</span>
            </div>
            {(cacheRead > 0 || cacheCreate > 0) && (
              <div style={{ color: 'var(--text-secondary)' }}>
                {cacheRead > 0 && (
                  <Tooltip content="缓存命中（享受折扣）">
                    <span style={{ color: 'var(--success)' }}>
                      cache 命中 {formatTokens(cacheRead)}
                    </span>
                  </Tooltip>
                )}
                {cacheRead > 0 && cacheCreate > 0 && <span> · </span>}
                {cacheCreate > 0 && (
                  <Tooltip content="本次写入缓存">
                    <span style={{ color: 'var(--primary-light)' }}>
                      写入 {formatTokens(cacheCreate)}
                    </span>
                  </Tooltip>
                )}
                <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>
                  全量 {formatTokens(total)}
                  {cacheRead > 0 && ` · 命中 ${hitPct}%`}
                </span>
              </div>
            )}
          </div>
        ),
      })
    }
    // 有完整消息快照时:显示模型文本 + 工具名,不再倒出截断 summary 与工具结果(已下沉到各 tool span)
    const hasSliceData =
      messages != null &&
      orderedLlmSpans != null &&
      spanIndexInLlm != null &&
      spanIndexInLlm >= 0 &&
      (d.message_count_after as number | undefined) != null
    if (hasSliceData) {
      const slice = sliceSpanMessages(messages!, orderedLlmSpans!, spanIndexInLlm!)
      const out = extractAssistantOutput(slice)
      if (out.text) rows.push({ label: '模型输出', value: out.text, monospace: true })
      if (out.toolNames.length > 0) rows.push({ label: '调用工具', value: out.toolNames.join('、') })
    } else {
      if (d.input_summary) rows.push({ label: 'Input', value: String(d.input_summary), monospace: true })
      if (d.output_summary) rows.push({ label: 'Output', value: String(d.output_summary), monospace: true })
    }
  }

  if (span.type === 'tool_call') {
    if (d.tool_name) rows.push({ label: 'Tool', value: String(d.tool_name) })
    const toolUseId = d.tool_use_id as string | undefined
    const io = messages != null && toolUseId ? findToolIO(messages, toolUseId) : null
    if (io) {
      if (io.input !== undefined) {
        rows.push({ label: 'Input', value: JSON.stringify(io.input, null, 2), monospace: true })
      }
      if (io.output !== undefined) {
        rows.push({ label: io.isError ? 'Output(错误)' : 'Output', value: io.output, monospace: true })
      }
    } else {
      if (d.input_summary) rows.push({ label: 'Input', value: String(d.input_summary), monospace: true })
      if (d.output_summary) rows.push({ label: 'Output', value: String(d.output_summary), monospace: true })
    }
    if (d.error) rows.push({ label: 'Error', value: String(d.error), monospace: true })
    if (d.child_trace_id) {
      rows.push({
        label: 'Sub Trace',
        value: <TraceLink traceId={String(d.child_trace_id)} onNavigate={onNavigateTrace} />,
      })
    }
  }

  if (span.type === 'decision') {
    if (d.decision_type) rows.push({ label: 'Type', value: String(d.decision_type) })
    if (d.summary) rows.push({ label: 'Summary', value: String(d.summary) })
  }

  if (span.type === 'sub_agent_call') {
    if (d.target_module_id) rows.push({ label: 'Target', value: String(d.target_module_id) })
    if (d.method) rows.push({ label: 'Method', value: String(d.method) })
    if (d.task_id) rows.push({ label: 'Task ID', value: String(d.task_id) })
    if (d.child_trace_id) {
      rows.push({
        label: 'Child Trace',
        value: <TraceLink traceId={String(d.child_trace_id)} onNavigate={onNavigateTrace} />,
      })
    }
  }

  if (span.type === 'context_assembly' || span.type === 'context_fetch') {
    if (d.context_type) rows.push({ label: 'Context Type', value: String(d.context_type) })
    if (d.channel_id) rows.push({ label: 'Channel', value: String(d.channel_id) })
    if (d.session_id) rows.push({ label: 'Session', value: String(d.session_id) })
  }

  if (span.type === 'memory_write') {
    if (d.friend_id) rows.push({ label: 'Friend', value: String(d.friend_id) })
    if (d.channel_id) rows.push({ label: 'Channel', value: String(d.channel_id) })
  }

  if (span.type === 'rpc_call') {
    if (d.target_module) rows.push({ label: 'Target', value: String(d.target_module) })
    if (d.method) rows.push({ label: 'Method', value: String(d.method) })
    if (d.target_port) rows.push({ label: 'Port', value: String(d.target_port) })
    if (d.request_summary) rows.push({ label: 'Request', value: String(d.request_summary), monospace: true })
    if (d.response_summary) rows.push({ label: 'Response', value: String(d.response_summary), monospace: true })
    if (d.status_code) rows.push({ label: 'Status Code', value: String(d.status_code) })
    if (d.error) rows.push({ label: 'Error', value: String(d.error), monospace: true })
  }

  if (span.type === 'dispatch_call') {
    if (d.model) rows.push({ label: '模型', value: String(d.model), monospace: true })
    if (d.session_type) rows.push({ label: '会话类型', value: String(d.session_type) })
    if (d.message_count != null) rows.push({ label: '消息批次', value: String(d.message_count) })
    if (d.action_count != null) rows.push({ label: '决策动作数', value: String(d.action_count) })
    if (d.retries != null) rows.push({ label: '重试次数', value: String(d.retries) })
    if (d.error) rows.push({ label: '错误', value: String(d.error), monospace: true })
  }

  if (span.type === 'dispatch_action') {
    if (d.kind) rows.push({ label: '动作类型', value: String(d.kind), monospace: true })
    if (d.target_task_id) rows.push({ label: '目标 Task', value: String(d.target_task_id), monospace: true })
    if (d.reason) rows.push({ label: '原因', value: String(d.reason) })
    if (d.outcome) rows.push({ label: '结果', value: String(d.outcome) })
    if (d.kind === 'new_task' && d.immediate_reply_sent != null) {
      rows.push({ label: '预回复', value: d.immediate_reply_sent ? '已发送' : '未发送' })
    }
    if (d.spawned_trace_id) {
      rows.push({
        label: '派生 Trace',
        value: <TraceLink traceId={String(d.spawned_trace_id)} onNavigate={onNavigateTrace} />,
      })
    }
    if (d.error) rows.push({ label: '错误', value: String(d.error), monospace: true })
  }

  rows.push({ label: 'Started', value: formatDateTimeLocal(span.started_at) })
  if (span.ended_at) {
    rows.push({ label: 'Ended', value: formatDateTimeLocal(span.ended_at) })
    rows.push({ label: 'Duration', value: formatDuration(span.duration_ms) })
  }
  rows.push({ label: 'Status', value: span.status })

  return (
    <div
      style={{
        padding: '10px 14px 10px 36px',
        background: 'var(--bg-secondary)',
        borderBottom: '1px solid var(--border)',
        fontSize: 12,
      }}
    >
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              <td
                style={{
                  width: 110,
                  padding: '2px 8px 2px 0',
                  color: 'var(--text-secondary)',
                  verticalAlign: 'top',
                  fontWeight: 500,
                }}
              >
                {row.label}:
              </td>
              <td
                style={{
                  padding: '2px 0',
                  color: 'var(--text-primary)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontFamily: row.monospace ? 'monospace' : undefined,
                  maxWidth: 600,
                }}
              >
                {row.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
