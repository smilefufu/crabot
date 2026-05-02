import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Button } from '../../components/Common/Button'
import { Loading } from '../../components/Common/Loading'
import { useToast } from '../../contexts/ToastContext'
import { traceService, type AgentTrace, type AgentSpan } from '../../services/trace'

// ============================================================================
// 辅助函数
// ============================================================================

function formatDuration(ms?: number): string {
  if (ms === undefined) return '-'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatTime(iso?: string): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false })
}

function spanTypeLabel(type: AgentSpan['type']): string {
  const map: Record<string, string> = {
    agent_loop: 'loop',
    llm_call: 'llm',
    tool_call: 'tool',
    sub_agent_call: 'sub-agent',
    decision: 'decision',
    context_assembly: 'ctx',
    memory_write: 'mem-w',
    rpc_call: 'rpc',
    bg_entity_exit: 'bg-exit',
    bg_entity_spawn: 'bg-spawn',     // 已不再 emit；遗留 trace 还有
    bg_entity_output: 'bg-out',      // 同上
    bg_entity_kill: 'bg-kill',       // 同上
    llm_retry: 'retry',
  }
  return map[type] ?? type
}

function spanTypeBg(type: AgentSpan['type']): string {
  const map: Record<string, string> = {
    agent_loop: '#3b82f6',
    llm_call: '#8b5cf6',
    tool_call: '#f59e0b',
    sub_agent_call: '#ec4899',
    decision: '#10b981',
    context_assembly: '#0ea5e9',
    memory_write: '#14b8a6',
    rpc_call: '#6366f1',
    bg_entity_exit: '#84cc16',       // lime — 区分 lifecycle event
    bg_entity_spawn: '#84cc16',
    bg_entity_output: '#84cc16',
    bg_entity_kill: '#84cc16',
    llm_retry: '#fb923c',            // orange — 警示但非错误
  }
  return map[type] ?? '#6b7280'
}

function statusColor(status: string): string {
  if (status === 'completed') return '#10b981'
  if (status === 'failed') return '#ef4444'
  return '#f59e0b' // running
}

const triggerTypeLabel: Record<string, string> = {
  message: 'front',
  task: 'worker',
  sub_agent_call: 'sub-agent',
  schedule: 'schedule',
}

type ViewMode = 'flat' | 'grouped'

function TraceLink({ traceId, onNavigate }: { traceId: string; onNavigate?: (id: string) => void }) {
  return (
    <span
      style={{ color: '#3b82f6', cursor: 'pointer', textDecoration: 'underline' }}
      onClick={() => onNavigate?.(traceId)}
    >
      {traceId.slice(0, 8)}... →
    </span>
  )
}

// ============================================================================
// SpanDetailPanel — 展开的详情面板
// ============================================================================

interface SpanDetailPanelProps {
  span: AgentSpan
  onNavigateTrace?: (traceId: string) => void
}

const SpanDetailPanel: React.FC<SpanDetailPanelProps> = ({ span, onNavigateTrace }) => {
  const d = span.details as Record<string, unknown>

  const rows: { label: string; value: string | React.ReactNode; monospace?: boolean }[] = []

  // agent_loop 详情
  if (span.type === 'agent_loop') {
    if (d.loop_label) rows.push({ label: 'Label', value: String(d.loop_label) })
    if (d.model) rows.push({ label: 'Model', value: String(d.model) })
    if (d.iteration_count !== undefined) rows.push({ label: 'Iterations', value: String(d.iteration_count) })
    if (d.tools && Array.isArray(d.tools) && d.tools.length > 0) {
      rows.push({ label: 'Tools', value: (d.tools as string[]).join(', ') })
    }
    if (d.mcp_servers && Array.isArray(d.mcp_servers) && d.mcp_servers.length > 0) {
      rows.push({
        label: 'MCP Servers',
        value: (d.mcp_servers as Array<{ name: string; status: string }>)
          .map(s => `${s.name}(${s.status})`)
          .join(', '),
      })
    }
    if (d.skills && Array.isArray(d.skills) && d.skills.length > 0) {
      rows.push({ label: 'Skills', value: (d.skills as string[]).join(', ') })
    }
    if (d.system_prompt) {
      rows.push({
        label: 'System Prompt',
        value: String(d.system_prompt),
        monospace: true,
      })
    }
  }

  // llm_call 详情
  if (span.type === 'llm_call') {
    if (d.iteration !== undefined) rows.push({ label: 'Iteration', value: String(d.iteration) })
    if (d.attempt !== undefined) rows.push({ label: 'Attempt', value: String(d.attempt) })
    if (d.stop_reason) rows.push({ label: 'Stop Reason', value: String(d.stop_reason) })
    if (d.tool_calls_count !== undefined) rows.push({ label: 'Tool Calls', value: String(d.tool_calls_count) })
    if (d.input_summary) {
      rows.push({ label: 'Input', value: String(d.input_summary), monospace: true })
    }
    if (d.output_summary) {
      rows.push({ label: 'Output', value: String(d.output_summary), monospace: true })
    }
  }

  // tool_call 详情
  if (span.type === 'tool_call') {
    if (d.tool_name) rows.push({ label: 'Tool', value: String(d.tool_name) })
    if (d.input_summary) {
      rows.push({ label: 'Input', value: String(d.input_summary), monospace: true })
    }
    if (d.output_summary) {
      rows.push({ label: 'Output', value: String(d.output_summary), monospace: true })
    }
    if (d.error) {
      rows.push({ label: 'Error', value: String(d.error), monospace: true })
    }
    if (d.child_trace_id) {
      rows.push({
        label: 'Sub Trace',
        value: <TraceLink traceId={String(d.child_trace_id)} onNavigate={onNavigateTrace} />,
      })
    }
  }

  // decision 详情
  if (span.type === 'decision') {
    if (d.decision_type) rows.push({ label: 'Type', value: String(d.decision_type) })
    if (d.summary) rows.push({ label: 'Summary', value: String(d.summary) })
  }

  // sub_agent_call 详情
  if (span.type === 'sub_agent_call') {
    if (d.target_module_id) rows.push({ label: 'Target', value: String(d.target_module_id) })
    if (d.method) rows.push({ label: 'Method', value: String(d.method) })
    if (d.task_id) rows.push({ label: 'Task ID', value: String(d.task_id) })
    if (d.child_trace_id) rows.push({
      label: 'Child Trace',
      value: <TraceLink traceId={String(d.child_trace_id)} onNavigate={onNavigateTrace} />,
    })
  }

  // context_assembly 详情
  if (span.type === 'context_assembly') {
    if (d.context_type) rows.push({ label: 'Context Type', value: String(d.context_type) })
    if (d.channel_id) rows.push({ label: 'Channel', value: String(d.channel_id) })
    if (d.session_id) rows.push({ label: 'Session', value: String(d.session_id) })
  }

  // memory_write 详情
  if (span.type === 'memory_write') {
    if (d.friend_id) rows.push({ label: 'Friend', value: String(d.friend_id) })
    if (d.channel_id) rows.push({ label: 'Channel', value: String(d.channel_id) })
  }

  // rpc_call 详情
  if (span.type === 'rpc_call') {
    if (d.target_module) rows.push({ label: 'Target', value: String(d.target_module) })
    if (d.method) rows.push({ label: 'Method', value: String(d.method) })
    if (d.target_port) rows.push({ label: 'Port', value: String(d.target_port) })
    if (d.request_summary) {
      rows.push({ label: 'Request', value: String(d.request_summary), monospace: true })
    }
    if (d.response_summary) {
      rows.push({ label: 'Response', value: String(d.response_summary), monospace: true })
    }
    if (d.status_code) rows.push({ label: 'Status Code', value: String(d.status_code) })
    if (d.error) {
      rows.push({ label: 'Error', value: String(d.error), monospace: true })
    }
  }

  // 通用时间信息
  rows.push({ label: 'Started', value: formatTime(span.started_at) })
  if (span.ended_at) {
    rows.push({ label: 'Ended', value: formatTime(span.ended_at) })
    rows.push({ label: 'Duration', value: formatDuration(span.duration_ms) })
  }
  rows.push({ label: 'Status', value: span.status })

  return (
    <div
      style={{
        padding: '8px 12px 8px 36px',
        background: 'var(--bg-secondary, #f9fafb)',
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
                  width: 100,
                  padding: '2px 8px 2px 0',
                  color: '#6b7280',
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

// ============================================================================
// SpanTree 组件
// ============================================================================

interface SpanTreeProps {
  spans: AgentSpan[]
  parentSpanId?: string
  depth?: number
  expandedDetails: Set<string>
  toggleDetail: (spanId: string) => void
  onNavigateTrace?: (traceId: string) => void
}

const SpanTree: React.FC<SpanTreeProps> = ({ spans, parentSpanId, depth = 0, expandedDetails, toggleDetail, onNavigateTrace }) => {
  const children = spans.filter((s) => s.parent_span_id === parentSpanId)
  if (children.length === 0) return null

  return (
    <>
      {children.map((span) => (
        <SpanRow
          key={span.span_id}
          span={span}
          spans={spans}
          depth={depth}
          expandedDetails={expandedDetails}
          toggleDetail={toggleDetail}
          onNavigateTrace={onNavigateTrace}
        />
      ))}
    </>
  )
}

interface SpanRowProps {
  span: AgentSpan
  spans: AgentSpan[]
  depth: number
  expandedDetails: Set<string>
  toggleDetail: (spanId: string) => void
  onNavigateTrace?: (traceId: string) => void
}

const SpanRow: React.FC<SpanRowProps> = ({ span, spans, depth, expandedDetails, toggleDetail, onNavigateTrace }) => {
  const [expanded, setExpanded] = useState(depth < 2)
  const hasChildren = spans.some((s) => s.parent_span_id === span.span_id)
  const showDetail = expandedDetails.has(span.span_id)
  const details = span.details as Record<string, unknown>

  const detailSummary = (): string => {
    if (span.type === 'agent_loop') {
      const label = details.loop_label ? `"${details.loop_label}"` : ''
      const iters = details.iteration_count ? ` ${details.iteration_count} iters` : ''
      return `${label}${iters}`.trim()
    }
    if (span.type === 'llm_call') {
      const iter = details.iteration ? `iter=${details.iteration}` : ''
      const stop = details.stop_reason ? ` stop:${details.stop_reason}` : ''
      return `${iter}${stop}`
    }
    if (span.type === 'tool_call') {
      return String(details.tool_name ?? '')
    }
    if (span.type === 'sub_agent_call') {
      return `→ ${details.target_module_id ?? ''}`
    }
    if (span.type === 'decision') {
      return String(details.decision_type ?? '')
    }
    if (span.type === 'context_assembly') {
      return `${details.context_type ?? 'front'} context`
    }
    if (span.type === 'memory_write') {
      return `→ ${details.channel_id ?? ''}`
    }
    if (span.type === 'rpc_call') {
      return `${details.target_module ?? ''}::${details.method ?? ''}`
    }
    if (span.type === 'bg_entity_exit') {
      const id = String(details.entity_id ?? '?')
      const status = String(details.status ?? '?')
      const exitCode = details.exit_code !== undefined ? `, exit=${details.exit_code}` : ''
      const runtimeMs = typeof details.runtime_ms === 'number' ? details.runtime_ms : 0
      const totalSecs = Math.floor(runtimeMs / 1000)
      const runtime = totalSecs < 60
        ? `${totalSecs}s`
        : totalSecs < 3600
        ? `${Math.floor(totalSecs / 60)}m${totalSecs % 60}s`
        : `${Math.floor(totalSecs / 3600)}h${Math.floor((totalSecs % 3600) / 60)}m`
      return `${id} → ${status}${exitCode}, ran ${runtime}`
    }
    if (span.type === 'bg_entity_spawn') {
      // 已废弃 emission，仅渲染遗留 trace
      const id = String(details.entity_id ?? '?')
      const mode = details.mode ? ` (${details.mode})` : ''
      return `${id}${mode}`
    }
    if (span.type === 'bg_entity_output' || span.type === 'bg_entity_kill') {
      // 已废弃 emission
      return String(details.entity_id ?? '?')
    }
    if (span.type === 'llm_retry') {
      const attempt = details.attempt ?? '?'
      const max = details.max_attempts ?? '?'
      const reason = String(details.error ?? '').slice(0, 80)
      return `attempt ${attempt}/${max}: ${reason}`
    }
    return ''
  }

  const handleToggleExpand = () => {
    if (hasChildren) setExpanded(!expanded)
  }

  const handleToggleDetail = (e: React.MouseEvent) => {
    e.stopPropagation()
    toggleDetail(span.span_id)
  }

  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '4px 0',
          paddingLeft: `${depth * 20 + 8}px`,
          borderBottom: '1px solid var(--border)',
          fontSize: '12px',
          fontFamily: 'monospace',
        }}
      >
        {/* 展开/收起箭头 */}
        <span
          style={{
            width: 16,
            color: '#9ca3af',
            marginRight: 4,
            cursor: hasChildren ? 'pointer' : 'default',
          }}
          onClick={handleToggleExpand}
        >
          {hasChildren ? (expanded ? '▼' : '▶') : ' '}
        </span>

        {/* 类型标签 */}
        <span
          style={{
            background: spanTypeBg(span.type),
            color: '#fff',
            borderRadius: 3,
            padding: '1px 5px',
            fontSize: 10,
            marginRight: 6,
            minWidth: 52,
            textAlign: 'center',
          }}
        >
          {spanTypeLabel(span.type)}
        </span>

        {/* 摘要（点击展开详情） */}
        <span
          style={{
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: 'var(--text-primary)',
            cursor: 'pointer',
          }}
          onClick={handleToggleDetail}
          title="点击查看详情"
        >
          {detailSummary()}
          {showDetail && <span style={{ marginLeft: 6, color: '#9ca3af' }}>▲ 收起</span>}
        </span>

        {/* 时长 */}
        <span style={{ color: formatDuration(span.duration_ms) === '-' ? '#9ca3af' : 'var(--text-secondary)', marginLeft: 8 }}>
          {formatDuration(span.duration_ms)}
        </span>

        {/* 状态 */}
        <span
          style={{
            marginLeft: 8,
            color: statusColor(span.status),
            fontWeight: 600,
          }}
        >
          {span.status === 'completed' ? '✓' : span.status === 'failed' ? '✗' : '…'}
        </span>
      </div>

      {/* 展开的详情面板 */}
      {showDetail && <SpanDetailPanel span={span} onNavigateTrace={onNavigateTrace} />}

      {/* 子节点 */}
      {expanded && hasChildren && (
        <SpanTree
          spans={spans}
          parentSpanId={span.span_id}
          depth={depth + 1}
          expandedDetails={expandedDetails}
          toggleDetail={toggleDetail}
          onNavigateTrace={onNavigateTrace}
        />
      )}
    </>
  )
}

// ============================================================================
// TraceDetail 组件
// ============================================================================

interface TraceDetailProps {
  trace: AgentTrace
  expandedDetails: Set<string>
  toggleDetail: (spanId: string) => void
  onNavigateTrace?: (traceId: string) => void
}

const TraceDetail: React.FC<TraceDetailProps> = ({ trace, expandedDetails, toggleDetail, onNavigateTrace }) => {
  return (
    <div style={{ height: '100%', overflow: 'auto' }}>
      {/* 标题区 */}
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
        {trace.parent_trace_id && (
          <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 6 }}>
            来自 {trace.module_id} / {trace.parent_trace_id.slice(0, 8)}
          </div>
        )}
        {trace.related_task_id && (
          <div style={{ fontSize: 12, color: '#6366f1', marginBottom: 6 }}>
            任务: {trace.related_task_id.slice(0, 8)}...
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              background: statusColor(trace.status),
              color: '#fff',
              borderRadius: 3,
              padding: '2px 8px',
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            {trace.status}
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {formatTime(trace.started_at)} · {formatDuration(trace.duration_ms)}
          </span>
        </div>
        <div style={{ marginTop: 6, fontSize: 13, color: 'var(--text-primary)' }}>
          <span style={{ color: '#9ca3af' }}>{trace.trigger.type}: </span>
          {trace.trigger.summary}
        </div>
        {trace.outcome && (
          <div style={{ marginTop: 6, fontSize: 12, color: trace.outcome.error ? '#ef4444' : 'var(--text-secondary)' }}>
            结果: {trace.outcome.summary}
            {trace.outcome.error && <span style={{ marginLeft: 4 }}>({trace.outcome.error})</span>}
          </div>
        )}
      </div>

      {/* Span 树 */}
      <div>
        {trace.spans.length === 0 ? (
          <div style={{ padding: 16, color: '#9ca3af', fontSize: 13 }}>暂无 Span 数据</div>
        ) : (
          <SpanTree
            spans={trace.spans}
            parentSpanId={undefined}
            depth={0}
            expandedDetails={expandedDetails}
            toggleDetail={toggleDetail}
            onNavigateTrace={onNavigateTrace}
          />
        )}
      </div>
    </div>
  )
}

// ============================================================================
// TraceListItem — 单条 Trace 列表项
// ============================================================================

interface TraceListItemProps {
  trace: AgentTrace
  isSelected: boolean
  onClick: () => void
  indent?: boolean
}

const TraceListItem: React.FC<TraceListItemProps> = ({ trace, isSelected, onClick, indent }) => (
  <div
    onClick={onClick}
    style={{
      padding: '10px 12px',
      paddingLeft: indent ? 28 : 12,
      borderBottom: '1px solid var(--border)',
      cursor: 'pointer',
      background: isSelected ? 'var(--bg-highlight, rgba(59,130,246,0.08))' : undefined,
      transition: 'background 0.1s',
    }}
  >
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
      <span
        style={{
          width: 8, height: 8, borderRadius: '50%',
          background: statusColor(trace.status),
          flexShrink: 0,
        }}
      />
      <span style={{ fontSize: 11, color: '#9ca3af' }}>
        {triggerTypeLabel[trace.trigger.type] ?? trace.trigger.type}
      </span>
      <span style={{ flex: 1 }} />
      <span style={{ fontSize: 11, color: '#9ca3af' }}>
        {formatDuration(trace.duration_ms)}
      </span>
    </div>
    <div style={{
      fontSize: 12, color: 'var(--text-primary)',
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    }}>
      {trace.trigger.summary}
    </div>
    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
      {formatTime(trace.started_at)}
      {trace.trigger.source && ` · ${trace.trigger.source}`}
    </div>
  </div>
)

// ============================================================================
// TraceGroupItem — 按 task 聚合的 Trace 组
// ============================================================================

interface TraceGroup {
  taskId: string | null
  traces: AgentTrace[]
  latestTime: string
  hasRunning: boolean
}

interface TraceGroupItemProps {
  group: TraceGroup
  selectedTraceId: string | null
  onSelectTrace: (trace: AgentTrace) => void
}

const TraceGroupItem: React.FC<TraceGroupItemProps> = ({ group, selectedTraceId, onSelectTrace }) => {
  const [expanded, setExpanded] = useState(false)

  if (group.taskId === null) {
    const trace = group.traces[0]
    return (
      <TraceListItem
        trace={trace}
        isSelected={selectedTraceId === trace.trace_id}
        onClick={() => onSelectTrace(trace)}
      />
    )
  }

  const roleOrder: Record<string, number> = { message: 0, task: 1, sub_agent_call: 2, schedule: 3 }
  const sorted = [...group.traces].sort((a, b) =>
    (roleOrder[a.trigger.type] ?? 9) - (roleOrder[b.trigger.type] ?? 9)
  )
  const primary = sorted.find(t => t.trigger.type === 'task') ?? sorted[0]
  const fronts = sorted.filter(t => t.trigger.type === 'message')
  const subagents = sorted.filter(t => t.trigger.type === 'sub_agent_call')

  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          padding: '10px 12px',
          cursor: 'pointer',
          background: group.traces.some(t => t.trace_id === selectedTraceId)
            ? 'var(--bg-highlight, rgba(59,130,246,0.08))' : undefined,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <span style={{ fontSize: 11, color: '#9ca3af' }}>
            {expanded ? '▼' : '▶'}
          </span>
          <span
            style={{
              width: 8, height: 8, borderRadius: '50%',
              background: group.hasRunning ? '#f59e0b' : sorted.some(t => t.status === 'failed') ? '#ef4444' : '#10b981',
              flexShrink: 0,
            }}
          />
          <span style={{ fontSize: 11, color: '#6366f1', fontWeight: 500 }}>
            task
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: '#9ca3af' }}>
            {fronts.length}F{subagents.length > 0 ? ` ${subagents.length}S` : ''}
          </span>
          <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 4 }}>
            {formatDuration(primary.duration_ms)}
          </span>
        </div>
        <div style={{
          fontSize: 12, color: 'var(--text-primary)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {primary.trigger.summary}
        </div>
        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
          {formatTime(primary.started_at)}
          {' · '}
          {group.taskId.slice(0, 8)}
        </div>
      </div>

      {expanded && sorted.map(trace => (
        <TraceListItem
          key={trace.trace_id}
          trace={trace}
          isSelected={selectedTraceId === trace.trace_id}
          onClick={() => onSelectTrace(trace)}
          indent
        />
      ))}
    </div>
  )
}

// ============================================================================
// 主页面
// ============================================================================

export const Traces: React.FC = () => {
  const toast = useToast()
  const [traces, setTraces] = useState<AgentTrace[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [serviceError, setServiceError] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // 选中的 trace ID（用于刷新后重新匹配）
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null)
  // 当前显示的 trace 详情
  const [selectedTrace, setSelectedTrace] = useState<AgentTrace | null>(null)
  // 展开的详情 span
  const [expandedDetails, setExpandedDetails] = useState<Set<string>>(new Set())

  const [viewMode, setViewMode] = useState<ViewMode>('grouped')

  const loadTraces = useCallback(async () => {
    setLoading(true)
    try {
      const result = await traceService.getTraces({ limit: 50 })
      setTraces(result.traces)
      setTotal(result.total)
      setServiceError('')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setServiceError(`Agent 未响应: ${msg}`)
      setTraces([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadTraces()
  }, [loadTraces])

  // 2 秒轮询
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(() => {
      loadTraces()
    }, 2000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [loadTraces])

  // 当 traces 更新时，刷新选中的 trace
  useEffect(() => {
    if (selectedTraceId) {
      const updated = traces.find(t => t.trace_id === selectedTraceId)
      if (updated) {
        setSelectedTrace(updated)
      }
    }
  }, [traces, selectedTraceId])

  const handleSelectTrace = (trace: AgentTrace) => {
    setSelectedTraceId(trace.trace_id)
    setSelectedTrace(trace)
    setExpandedDetails(new Set()) // 切换 trace 时清空展开状态
  }

  const tracesRef = useRef(traces)
  useEffect(() => { tracesRef.current = traces }, [traces])

  const handleNavigateTrace = useCallback(async (traceId: string) => {
    const existing = tracesRef.current.find(t => t.trace_id === traceId)
    if (existing) {
      handleSelectTrace(existing)
      return
    }
    try {
      const result = await traceService.getTrace(traceId)
      setSelectedTraceId(result.trace.trace_id)
      setSelectedTrace(result.trace)
      setExpandedDetails(new Set())
    } catch {
      toast.error('无法加载关联 Trace')
    }
  }, [toast])

  const traceGroups = useMemo((): TraceGroup[] => {
    if (viewMode === 'flat') return []

    const grouped = new Map<string, AgentTrace[]>()
    const ungrouped: AgentTrace[] = []

    for (const trace of traces) {
      if (trace.related_task_id) {
        const arr = grouped.get(trace.related_task_id)
        if (arr) { arr.push(trace) } else { grouped.set(trace.related_task_id, [trace]) }
      } else {
        ungrouped.push(trace)
      }
    }

    const groups: TraceGroup[] = []

    for (const [taskId, taskTraces] of grouped) {
      groups.push({
        taskId,
        traces: taskTraces,
        latestTime: taskTraces.reduce((latest, t) =>
          t.started_at > latest ? t.started_at : latest, ''),
        hasRunning: taskTraces.some(t => t.status === 'running'),
      })
    }

    for (const trace of ungrouped) {
      groups.push({
        taskId: null,
        traces: [trace],
        latestTime: trace.started_at,
        hasRunning: trace.status === 'running',
      })
    }

    groups.sort((a, b) => new Date(b.latestTime).getTime() - new Date(a.latestTime).getTime())
    return groups
  }, [traces, viewMode])

  const toggleDetail = useCallback((spanId: string) => {
    setExpandedDetails(prev => {
      const next = new Set(prev)
      if (next.has(spanId)) {
        next.delete(spanId)
      } else {
        next.add(spanId)
      }
      return next
    })
  }, [])

  const handleClear = useCallback(async () => {
    setClearing(true)
    try {
      const result = await traceService.clearTraces()
      setTraces([])
      setSelectedTrace(null)
      setSelectedTraceId(null)
      setExpandedDetails(new Set())
      toast.success(`已清理 ${result.cleared_count} 条 Trace`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`清理失败: ${msg}`)
    } finally {
      setClearing(false)
    }
  }, [toast])

  return (
    <MainLayout>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 16, padding: '0 24px 24px' }}>
        {/* 顶部工具栏 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 8 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Agent Traces</h2>
          <div style={{ flex: 1 }} />
          <Button
            variant="secondary"
            onClick={() => loadTraces()}
          >
            刷新
          </Button>
          <Button
            variant="danger"
            onClick={handleClear}
            disabled={clearing || traces.length === 0}
          >
            {clearing ? '清理中...' : '清理全部'}
          </Button>
        </div>

        {serviceError && (
          <div style={{ padding: '10px 16px', background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 6, color: '#dc2626', fontSize: 13 }}>
            {serviceError}
          </div>
        )}

        {/* 主内容：左列表 + 右详情 */}
        <div style={{ display: 'flex', flex: 1, gap: 16, overflow: 'hidden', minHeight: 0 }}>
          {/* 左侧 Trace 列表 */}
          <div className="card" style={{ width: 340, flexShrink: 0, overflow: 'auto', padding: 0 }}>
            {loading && traces.length === 0 ? (
              <div style={{ padding: 24 }}><Loading /></div>
            ) : traces.length === 0 ? (
              <div style={{ padding: 24, color: '#9ca3af', fontSize: 13, textAlign: 'center' }}>
                暂无 Trace 数据
              </div>
            ) : (
              <>
                <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, fontSize: 12 }}>
                  <span style={{ color: '#9ca3af' }}>共 {total} 条</span>
                  <span style={{ flex: 1 }} />
                  <span
                    style={{ cursor: 'pointer', color: viewMode === 'grouped' ? '#3b82f6' : '#9ca3af' }}
                    onClick={() => setViewMode('grouped')}
                  >
                    聚合
                  </span>
                  <span
                    style={{ cursor: 'pointer', color: viewMode === 'flat' ? '#3b82f6' : '#9ca3af' }}
                    onClick={() => setViewMode('flat')}
                  >
                    平铺
                  </span>
                </div>
                {viewMode === 'flat' ? (
                  traces.map(trace => (
                    <TraceListItem
                      key={trace.trace_id}
                      trace={trace}
                      isSelected={selectedTraceId === trace.trace_id}
                      onClick={() => handleSelectTrace(trace)}
                    />
                  ))
                ) : (
                  traceGroups.map((group, i) => (
                    <TraceGroupItem
                      key={group.taskId ?? `ungrouped-${i}`}
                      group={group}
                      selectedTraceId={selectedTraceId}
                      onSelectTrace={handleSelectTrace}
                    />
                  ))
                )}
              </>
            )}
          </div>

          {/* 右侧详情 */}
          <div className="card" style={{ flex: 1, overflow: 'hidden', padding: 0 }}>
            {selectedTrace ? (
              <TraceDetail
                trace={selectedTrace}
                expandedDetails={expandedDetails}
                toggleDetail={toggleDetail}
                onNavigateTrace={handleNavigateTrace}
              />
            ) : (
              <div style={{ padding: 24, color: '#9ca3af', fontSize: 13, textAlign: 'center' }}>
                选择左侧 Trace 查看详情
              </div>
            )}
          </div>
        </div>
      </div>
    </MainLayout>
  )
}