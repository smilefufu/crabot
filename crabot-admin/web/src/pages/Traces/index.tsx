import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Button } from '../../components/Common/Button'
import { Loading } from '../../components/Common/Loading'
import { Tooltip } from '../../components/Common/Tooltip'
import { TaskBgShells } from './TaskBgShells'
import { useToast } from '../../contexts/ToastContext'
import {
  traceService,
  totalPromptTokens,
  cacheHitRate,
  type AgentTrace,
  type AgentSpan,
  type TraceIndexEntry,
  type ConversationUnit,
  type ConvTaskBrief,
  type ListConversationUnitsParams,
  type TraceTree,
} from '../../services/trace'
import {
  PAGE_SIZE,
  LIST_REFRESH_MS,
  DETAIL_REFRESH_MS,
  rangeToISO,
  formatDateTimeLocal,
  formatDuration,
  formatTime,
  formatTokens,
  statusColor,
  DEFAULT_FILTER,
  buildTraceEpochs,
  type FilterState,
  type TraceEpoch,
  type TraceEpochRole,
} from './utils'
import { FilterBar } from './FilterBar'
import { PaginationBar } from './PaginationBar'
import { StatusDot, TriggerBadge, AuditBadge, TraceChip, TraceLink } from './TraceTable'
import { SpanTree } from './SpanTree'
import { StatusBar } from './StatusBar'
import { ManualCleanupDialog, AutoCleanupSettingsDialog } from './CleanupDialogs'
import { MessageBlocks } from './MessageBlocks'
import { Modal } from '../../components/Common/Modal'

// ============================================================================
// 本地 type（仅主组件用）
// ============================================================================

/**
 * spec 2026-06-09-task-trace-tool-unification.md §4.3:
 * 唯一主视图按 task 维度合并（含孤儿 dispatcher 时间序合并）+ 三角展开看关联 trace。
 * 删 'flat' / 'grouped' 双视图——按 task 一统天下。
 */

interface TraceTreeData {
  fronts: TraceIndexEntry[]
  workers: TraceIndexEntry[]
  subagents: TraceIndexEntry[]
}

interface TraceFocusWindow {
  startedAt: string
  endedAt?: string
  epochLabel: string
}

const epochRoleLabel: Record<TraceEpochRole, string> = {
  dispatcher: 'Dispatch',
  worker: 'Task',
  subagent: 'Sub-agent',
}

const epochRoleColor: Record<TraceEpochRole, string> = {
  dispatcher: '#3b82f6',
  worker: '#8b5cf6',
  subagent: '#ec4899',
}

// ============================================================================
// 子组件：RelatedTraceTree — 同 task_id 的 fronts/worker/sub-agents 关联视图
// ============================================================================

function RelatedTraceTree({
  taskId,
  currentTraceId,
  focusWindow,
  onJumpToTrace,
}: {
  taskId: string
  currentTraceId: string
  focusWindow?: TraceFocusWindow | null
  onJumpToTrace?: (traceId: string, focusWindow?: TraceFocusWindow) => void
}) {
  const [tree, setTree] = useState<TraceTreeData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    traceService
      .getTraceTree(taskId)
      .then((result) => {
        if (cancelled) return
        setTree(result.tree)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [taskId])

  if (loading && !tree) {
    return (
      <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--text-muted)' }}>
        加载关联链路中...
      </div>
    )
  }
  if (error) {
    return (
      <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--error)' }}>
        关联链路加载失败：{error}
      </div>
    )
  }
  if (!tree) return null

  const total = tree.fronts.length + tree.workers.length + tree.subagents.length
  const epochs = buildTraceEpochs({
    fronts: tree.fronts,
    workers: tree.workers,
    subagents: tree.subagents,
    currentTraceId,
  })

  return (
    <div
      style={{
        padding: '10px 12px',
        background: 'var(--primary-subtle)',
        border: '1px solid rgba(217,124,74,0.2)',
        borderRadius: 4,
        marginTop: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--primary-light)', fontWeight: 600 }}>
        <span>🔗 关联链路</span>
        <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontFamily: 'var(--font-mono)' }}>
          task {taskId.slice(0, 12)}
        </span>
        <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>· {epochs.length} epoch / 共 {total} trace</span>
      </div>
      <EpochList epochs={epochs} currentTraceId={currentTraceId} focusWindow={focusWindow} onJumpToTrace={onJumpToTrace} />
    </div>
  )
}

function EpochList({
  epochs,
  currentTraceId,
  focusWindow,
  onJumpToTrace,
}: {
  epochs: TraceEpoch[]
  currentTraceId: string
  focusWindow?: TraceFocusWindow | null
  onJumpToTrace?: (traceId: string, focusWindow?: TraceFocusWindow) => void
}) {
  const [historyExpanded, setHistoryExpanded] = useState(false)
  if (epochs.length === 0) {
    return <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>(无关联 trace)</div>
  }
  const visible = epochs.filter((epoch) => (
    epoch.isLatest || epoch.isCurrent || (focusWindow && epoch.label === focusWindow.epochLabel)
  ))
  const history = epochs.filter((epoch) => !visible.includes(epoch))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {visible.map((epoch) => (
        <EpochBlock key={epoch.id} epoch={epoch} currentTraceId={currentTraceId} onJumpToTrace={onJumpToTrace} />
      ))}
      {history.length > 0 && (
        <button
          type="button"
          onClick={() => setHistoryExpanded((v) => !v)}
          style={{
            border: '1px solid rgba(148,163,184,0.24)',
            borderRadius: 4,
            background: 'rgba(15,23,42,0.12)',
            color: 'var(--text-muted)',
            padding: '5px 8px',
            cursor: 'pointer',
            textAlign: 'left',
            fontSize: 11,
            fontFamily: 'var(--font-body)',
          }}
        >
          {historyExpanded ? '▼' : '▶'} 历史 epoch ({history.length})
        </button>
      )}
      {historyExpanded && history.map((epoch) => (
        <EpochBlock key={epoch.id} epoch={epoch} currentTraceId={currentTraceId} onJumpToTrace={onJumpToTrace} />
      ))}
    </div>
  )
}

function EpochBlock({
  epoch,
  currentTraceId,
  onJumpToTrace,
}: {
  epoch: TraceEpoch
  currentTraceId: string
  onJumpToTrace?: (traceId: string, focusWindow?: TraceFocusWindow) => void
}) {
  const [expanded, setExpanded] = useState(epoch.isLatest || epoch.isCurrent)
  useEffect(() => {
    if (epoch.isLatest || epoch.isCurrent) setExpanded(true)
  }, [epoch.isLatest, epoch.isCurrent])
  const title = `${epoch.label}${epoch.isLatest ? ' · 最新' : ''}${epoch.isCurrent && !epoch.isLatest ? ' · 当前' : ''}`
  return (
    <div
      style={{
        border: `1px solid ${epoch.isLatest ? 'rgba(16,185,129,0.38)' : 'rgba(148,163,184,0.28)'}`,
        borderRadius: 4,
        background: epoch.isLatest ? 'rgba(16,185,129,0.06)' : 'rgba(15,23,42,0.18)',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={{
          width: '100%',
          border: 'none',
          background: 'transparent',
          color: 'var(--text-primary)',
          padding: '6px 8px',
          display: 'grid',
          gridTemplateColumns: 'minmax(96px, auto) 1fr auto',
          gap: 8,
          alignItems: 'center',
          textAlign: 'left',
          cursor: 'pointer',
          fontFamily: 'var(--font-body)',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700 }}>
          <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 10 }}>
            {expanded ? '▼' : '▶'}
          </span>
          {title}
        </span>
        <span
          style={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: 'var(--text-muted)',
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
          }}
        >
          {formatTime(epoch.startedAt)} - {epoch.endedAt ? formatTime(epoch.endedAt) : 'now'} · {formatDuration(epoch.durationMs)}
        </span>
        <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center', justifyContent: 'flex-end', fontSize: 10, color: 'var(--text-muted)' }}>
          <span>{epoch.roleCounts.dispatcher}D</span>
          <span>{epoch.roleCounts.worker}T</span>
          <span>{epoch.roleCounts.subagent}S</span>
          <span style={{ color: statusColor(epoch.status), fontWeight: 700 }}>{epoch.status}</span>
        </span>
      </button>
      {expanded && (
        <div style={{ padding: '0 8px 7px', display: 'flex', flexDirection: 'column', gap: 5 }}>
          {(['dispatcher', 'worker', 'subagent'] as TraceEpochRole[]).map((role) => {
            const items = epoch.traces.filter((m) => m.role === role).map((m) => m.entry)
            if (items.length === 0) return null
            return (
              <div key={role} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span
                  style={{
                    fontSize: 10,
                    color: epochRoleColor[role],
                    fontWeight: 600,
                    letterSpacing: 0.3,
                    textTransform: 'uppercase',
                    minWidth: 76,
                  }}
                >
                  {epochRoleLabel[role]} ({items.length})
                </span>
                {items.map((e) => (
                  <TraceChip
                    key={e.trace_id}
                    entry={e}
                    current={e.trace_id === currentTraceId && (role !== 'worker' || epoch.isLatest || epoch.isCurrent)}
                    onClick={() => onJumpToTrace?.(e.trace_id, epochFocusWindow(epoch))}
                  />
                ))}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function epochFocusWindow(epoch: TraceEpoch): TraceFocusWindow {
  return {
    startedAt: epoch.startedAt,
    ...(epoch.endedAt ? { endedAt: epoch.endedAt } : {}),
    epochLabel: epoch.label,
  }
}

// ============================================================================
// 子组件：UsageStat
// ============================================================================

function UsageStat({
  label,
  value,
  color,
  hint,
  suffix,
}: {
  label: string
  value: number
  color: string
  hint?: string
  suffix?: string
}) {
  return (
    <Tooltip content={hint}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 0.3 }}>
        {label}
      </span>
      <span style={{ fontSize: 16, color, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
        {suffix ? `${value}${suffix}` : formatTokens(value)}
      </span>
    </div>
    </Tooltip>
  )
}

// ============================================================================
// 子组件：TraceDetailPanel
// ============================================================================

export function TraceDetailPanel({
  trace,
  loading,
  focusWindow,
  onNavigateTrace,
}: {
  trace: AgentTrace | null
  loading: boolean
  focusWindow?: TraceFocusWindow | null
  onNavigateTrace?: (traceId: string, focusWindow?: TraceFocusWindow) => void
}) {
  const [expandedDetails, setExpandedDetails] = useState<Set<string>>(new Set())
  const [convModalOpen, setConvModalOpen] = useState(false)
  const [sysPromptExpanded, setSysPromptExpanded] = useState(false)

  // 切换 trace 时清空展开状态
  useEffect(() => {
    setExpandedDetails(new Set())
    setConvModalOpen(false)
    setSysPromptExpanded(false)
  }, [trace?.trace_id])

  const toggleDetail = useCallback((spanId: string) => {
    setExpandedDetails(prev => {
      const next = new Set(prev)
      if (next.has(spanId)) next.delete(spanId)
      else next.add(spanId)
      return next
    })
  }, [])

  if (!trace) {
    return (
      <div style={{ padding: 32, color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
        从左侧表格选择一条 Trace 查看详情
      </div>
    )
  }

  const usage = trace.total_usage

  return (
    <div style={{ height: '100%', overflow: 'auto', position: 'relative' }}>
      {loading && (
        <div style={{ position: 'absolute', top: 8, right: 12, fontSize: 11, color: 'var(--text-muted)' }}>
          加载中...
        </div>
      )}

      {/* 顶部：trace 元信息 */}
      <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <TriggerBadge type={trace.trigger.type} />
          <AuditBadge taskType={trace.trigger.task_type} />
          <span
            style={{
              background: statusColor(trace.status),
              color: 'var(--text-on-primary)',
              borderRadius: 3,
              padding: '2px 8px',
              fontSize: 11,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: 0.3,
            }}
          >
            {trace.status}
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
            {formatDateTimeLocal(trace.started_at)} · {formatDuration(trace.duration_ms)}
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            {trace.trace_id.slice(0, 8)}
          </span>
        </div>

        {trace.trigger.type === 'task' && trace.resume_checkpoint && (
          <div style={{ marginTop: 6 }}>
            <Button variant="secondary" onClick={() => setConvModalOpen(true)}>
              📄 完整对话（{trace.resume_checkpoint.messages.length} 条）
            </Button>
          </div>
        )}

        {trace.parent_trace_id && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
            父 trace: <TraceLink traceId={trace.parent_trace_id} onNavigate={onNavigateTrace} />
          </div>
        )}

        <div style={{ marginTop: 6, fontSize: 13, color: 'var(--text-primary)', wordBreak: 'break-word' }}>
          {trace.trigger.summary}
        </div>

        {trace.related_task_id && (
          <RelatedTraceTree
            taskId={trace.related_task_id}
            currentTraceId={trace.trace_id}
            focusWindow={focusWindow}
            onJumpToTrace={onNavigateTrace}
          />
        )}

        {trace.related_task_id && <TaskBgShells taskId={trace.related_task_id} />}

        {trace.outcome && (
          <div
            style={{
              marginTop: 8,
              padding: '6px 10px',
              borderRadius: 4,
              background: trace.outcome.error ? 'var(--error-glow)' : 'var(--success-glow)',
              borderLeft: `3px solid ${trace.outcome.error ? 'var(--error)' : 'var(--success)'}`,
              fontSize: 12,
              color: trace.outcome.error ? 'var(--error)' : 'var(--text-primary)',
            }}
          >
            <div>
              <strong>结果:</strong> {trace.outcome.summary}
            </div>
            {trace.outcome.error && (
              <div style={{ marginTop: 4, fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                {trace.outcome.error}
              </div>
            )}
          </div>
        )}

        {/* Token 统计区 */}
        {usage && (
          <div
            style={{
              marginTop: 10,
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
              gap: 8,
              padding: '10px 12px',
              background: 'var(--bg-primary)',
              border: '1px solid var(--border)',
              borderRadius: 4,
            }}
          >
            <UsageStat
              label="未命中输入"
              value={usage.input_tokens}
              color="#3b82f6"
              hint="实际计费的 prompt 部分"
            />
            <UsageStat
              label="输出"
              value={usage.output_tokens}
              color="#8b5cf6"
            />
            {(usage.cache_read_tokens ?? 0) > 0 && (
              <UsageStat
                label="缓存命中"
                value={usage.cache_read_tokens!}
                color="#10b981"
                hint="享受缓存折扣价"
              />
            )}
            {(usage.cache_creation_tokens ?? 0) > 0 && (
              <UsageStat
                label="缓存写入"
                value={usage.cache_creation_tokens!}
                color="#0ea5e9"
                hint="本次请求写入缓存的 token（贵 25%）"
              />
            )}
            <UsageStat
              label="全量 prompt"
              value={totalPromptTokens(usage)}
              color="var(--text-secondary)"
              hint="未命中 + 命中 + 写入"
            />
            {((usage.cache_read_tokens ?? 0) > 0 || (usage.cache_creation_tokens ?? 0) > 0) && (
              <UsageStat
                label="命中率"
                value={Math.round(cacheHitRate(usage) * 100)}
                color={cacheHitRate(usage) > 0.5 ? '#10b981' : '#f59e0b'}
                suffix="%"
                hint="命中 token / 全量 prompt"
              />
            )}
          </div>
        )}
      </div>

      {/* Span 树 */}
      {(() => {
        const visibleSpans = focusWindow ? filterSpansByWindow(trace.spans, focusWindow) : trace.spans
        // 计算 orderedLlmSpans：所有 llm_call span 按 started_at 排序，携带 message_count_after
        const orderedLlmSpans = trace.resume_checkpoint
          ? visibleSpans
              .filter((s) => s.type === 'llm_call')
              .sort((a, b) => {
                if (a.started_at < b.started_at) return -1
                if (a.started_at > b.started_at) return 1
                return 0
              })
              .map((s) => ({
                span_id: s.span_id,
                message_count_after: (s.details as { message_count_after?: number }).message_count_after,
              }))
          : undefined
        const messages = trace.resume_checkpoint?.messages

        return (
          <div>
            {focusWindow && (
              <div
                style={{
                  padding: '7px 12px',
                  borderBottom: '1px solid var(--border)',
                  background: 'rgba(16,185,129,0.05)',
                  color: 'var(--text-secondary)',
                  fontSize: 12,
                  fontFamily: 'var(--font-mono)',
                }}
              >
                Span 已按 {focusWindow.epochLabel} 切片：{formatTime(focusWindow.startedAt)} - {focusWindow.endedAt ? formatTime(focusWindow.endedAt) : 'now'}
                <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>
                  {visibleSpans.length} / {trace.spans.length}
                </span>
              </div>
            )}
            {visibleSpans.length === 0 ? (
              <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 13 }}>暂无 Span 数据</div>
            ) : (
              <SpanTree
                spans={visibleSpans}
                parentSpanId={undefined}
                depth={0}
                expandedDetails={expandedDetails}
                toggleDetail={toggleDetail}
                onNavigateTrace={onNavigateTrace}
                messages={messages}
                orderedLlmSpans={orderedLlmSpans}
              />
            )}
          </div>
        )
      })()}

      {trace.trigger.type === 'task' && trace.resume_checkpoint && (
        <Modal
          open={convModalOpen}
          onClose={() => setConvModalOpen(false)}
          title="完整对话"
          size="full"
          contentClassName="conv-modal"
        >
          <div style={{ marginBottom: 10 }}>
            <button
              onClick={() => setSysPromptExpanded((v) => !v)}
              style={{ background: 'none', border: 'none', color: 'var(--primary-light)', cursor: 'pointer', padding: 0, fontSize: 12, fontFamily: 'var(--font-body)' }}
            >
              {sysPromptExpanded ? '▾' : '▸'} System Prompt
            </button>
            {sysPromptExpanded && (
              <pre style={{ marginTop: 6, maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'var(--font-mono)', fontSize: 12, background: 'var(--bg-primary)', border: '1px solid var(--border)', padding: '6px 8px', borderRadius: 4, color: 'var(--text-primary)', lineHeight: 1.55 }}>
                {trace.resume_checkpoint.system_prompt}
              </pre>
            )}
          </div>
          <MessageBlocks messages={trace.resume_checkpoint.messages} />
        </Modal>
      )}
    </div>
  )
}

function filterSpansByWindow(spans: AgentSpan[], window: TraceFocusWindow): AgentSpan[] {
  const start = new Date(window.startedAt).getTime()
  const end = window.endedAt ? new Date(window.endedAt).getTime() : Number.POSITIVE_INFINITY
  const byId = new Map(spans.map((span) => [span.span_id, span]))
  const keep = new Set<string>()
  for (const span of spans) {
    const spanStart = new Date(span.started_at).getTime()
    const spanEnd = span.ended_at ? new Date(span.ended_at).getTime() : spanStart + (span.duration_ms ?? 0)
    if (spanStart <= end && spanEnd >= start) {
      let cursor: AgentSpan | undefined = span
      while (cursor) {
        keep.add(cursor.span_id)
        cursor = cursor.parent_span_id ? byId.get(cursor.parent_span_id) : undefined
      }
    }
  }
  return spans.filter((span) => keep.has(span.span_id))
}

// ============================================================================
// 子组件：ConversationUnitRow — spec 2026-06-09 §4.3 异构行渲染
// task 行 + orphan_dispatcher 行用同一组件按 kind 分支
// ============================================================================

/** task_id 显示：去掉 trigger- 前缀（无意义且撑宽行），保留首 8 字符 */
function shortTaskId(taskId: string): string {
  const stripped = taskId.startsWith('trigger-') ? taskId.slice('trigger-'.length) : taskId
  return stripped.slice(0, 8)
}

/** task 持续时间：completed_at - started_at；缺则 - */
function taskDurationMs(t: ConvTaskBrief): number | undefined {
  if (t.started_at && t.completed_at) {
    return new Date(t.completed_at).getTime() - new Date(t.started_at).getTime()
  }
  return undefined
}

/**
 * ConversationUnitRow — 三角展开式 task 行 + 孤儿 dispatcher 单行。
 *
 * spec 2026-06-09 §4.3:
 * - task 行：[☑️ 多选] [▶ 展开] [⚫ 状态点] [Task badge] [短 id] [title] [时间] [持续] [渠道] [#msgs] [✕]
 *   点击展开三角 → lazy load getTraceTree(task_id) → 展开后显示子 trace 行（fronts/worker/subagents）
 *   点击子 trace 行 → loadDetail 到右侧详情面板
 * - 孤儿 dispatcher：[—] [—] [⚫] [对话 badge] [短 id] [trigger_summary] [时间] [—] [—] [—] [—]
 *   点击整行 → loadDetail
 */
function ConversationUnitRow({
  unit,
  selectedTraceId,
  selected,
  onToggleSelect,
  onSelectTrace,
  onDeleteTask,
  onLoadTree,
  treeCache,
}: {
  unit: ConversationUnit
  selectedTraceId: string | null
  /** 当前 unit 是否被多选 checkbox 选中（仅 task 行有效；orphan_dispatcher 不参与多选） */
  selected: boolean
  /** 切换 checkbox 选中状态（仅 task 行调） */
  onToggleSelect: (taskId: string) => void
  /** 点击 trace 行 → 加载 trace detail（task 展开后的子行 / 孤儿 dispatcher 整行都用） */
  onSelectTrace: (traceId: string, focusWindow?: TraceFocusWindow) => void
  /** 点击删除按钮 → confirm 后永久删除 task（活跃 task 后端会拒绝） */
  onDeleteTask: (taskId: string, title: string) => void
  /** 触发 lazy load trace tree（task 展开时调） */
  onLoadTree: (taskId: string) => void
  /** 当前 task 的 trace tree 缓存（undefined = 未加载 / 加载中） */
  treeCache: TraceTree | null | undefined
}) {
  const [expanded, setExpanded] = useState(false)

  if (unit.kind === 'orphan_dispatcher') {
    const tr = unit.trace
    const isSelected = selectedTraceId === tr.trace_id
    const cell: React.CSSProperties = {
      padding: '6px 10px',
      borderBottom: '1px solid var(--border)',
      verticalAlign: 'middle',
      fontSize: 12,
    }
    return (
      <tr
        style={{
          cursor: 'pointer',
          background: isSelected ? 'var(--bg-highlight, rgba(59,130,246,0.08))' : 'transparent',
        }}
        onClick={() => onSelectTrace(tr.trace_id)}
      >
        <td style={cell}>{/* 无 checkbox */}</td>
        <td style={cell}>{/* 无三角 */}</td>
        <td style={cell}><StatusDot status={tr.status} /></td>
        <td style={cell}>
          <Tooltip content="孤儿 dispatcher — dispatcher 决策为 reply/silent/forward_to_existing 不创建 task">
            <span style={{
              background: '#6b7280', color: 'var(--text-on-primary)', fontSize: 10,
              padding: '1px 6px', borderRadius: 3, fontWeight: 500,
            }}>对话</span>
          </Tooltip>
        </td>
        <td style={{ ...cell, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
          {tr.trace_id.slice(0, 8)}
        </td>
        <td style={{ ...cell, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <Tooltip content={tr.trigger_summary}>
            <span>{tr.trigger_summary || '(空)'}</span>
          </Tooltip>
        </td>
        <td style={{ ...cell, fontSize: 11, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
          {formatTime(tr.started_at)}
        </td>
        <td style={{ ...cell, fontSize: 11, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
          {formatDuration(tr.duration_ms)}
        </td>
        <td style={{ ...cell, fontSize: 11, color: 'var(--text-muted)' }}>—</td>
        <td style={{ ...cell, textAlign: 'right', fontSize: 11, color: 'var(--text-muted)' }}>—</td>
        <td style={cell}>{/* 孤儿 dispatcher 没对应 task 不能删，留空 */}</td>
      </tr>
    )
  }

  // kind === 'task'
  const t = unit.task
  const isTerminal = t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled'
  const channelLabel = t.source.channel_id
    ? `${t.source.channel_id.slice(0, 14)}${t.source.session_id ? ' / ' + t.source.session_id.slice(0, 6) : ''}`
    : '-'
  const dur = taskDurationMs(t)

  const tCell: React.CSSProperties = {
    padding: '6px 10px',
    borderBottom: '1px solid var(--border)',
    verticalAlign: 'middle',
    fontSize: 12,
  }

  const toggleExpand = () => {
    const next = !expanded
    setExpanded(next)
    if (next && treeCache === undefined) onLoadTree(t.id)
  }

  return (
    <>
      <tr
        style={{
          cursor: 'pointer',
          background: selected ? 'var(--bg-highlight, rgba(99,102,241,0.06))' : 'transparent',
        }}
        onClick={toggleExpand}
      >
        <td style={tCell}>
          <input
            type="checkbox"
            checked={selected}
            disabled={!isTerminal}
            onChange={() => onToggleSelect(t.id)}
            onClick={(e) => e.stopPropagation()}
            title={isTerminal ? '选中以批量删除' : '活跃 task 不能选择'}
            style={{ cursor: isTerminal ? 'pointer' : 'not-allowed' }}
          />
        </td>
        <td style={tCell}>
          <span style={{ color: '#6366f1', fontSize: 11, fontFamily: 'var(--font-mono)' }}>
            {expanded ? '▼' : '▶'}
          </span>
        </td>
        <td style={tCell}><StatusDot status={isTerminal ? t.status : 'running'} /></td>
        <td style={tCell}>
          <span style={{
            background: '#6366f1', color: 'var(--text-on-primary)', fontSize: 10,
            padding: '1px 6px', borderRadius: 3, fontWeight: 500,
          }}>Task</span>
        </td>
        <td style={{ ...tCell, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
          <Tooltip content={t.id}>
            <span>{shortTaskId(t.id)}</span>
          </Tooltip>
        </td>
        <td style={{ ...tCell, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <Tooltip content={`${unit.activity_summary}\n\nTask: ${t.title}`}>
            <span style={{ fontWeight: 500 }}>{unit.activity_summary}</span>
          </Tooltip>
        </td>
        <td style={{ ...tCell, fontSize: 11, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
          {formatTime(unit.activity_at)}
        </td>
        <td style={{ ...tCell, fontSize: 11, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
          {formatDuration(dur)}
        </td>
        <td style={{ ...tCell, fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
          <Tooltip content={`${t.source.channel_id ?? '-'} / ${t.source.session_id ?? '-'}`}>
            <span>{channelLabel}</span>
          </Tooltip>
        </td>
        <td style={{ ...tCell, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
          {t.messages?.length ?? 0}
        </td>
        <td style={tCell}>
          <Tooltip content={isTerminal ? '永久删除此任务（trace 数据不受影响）' : '活跃 task 不能直接删除'}>
            <button
              onClick={(e) => { e.stopPropagation(); onDeleteTask(t.id, t.title) }}
              disabled={!isTerminal}
              style={{
                background: 'transparent', border: 'none',
                cursor: isTerminal ? 'pointer' : 'not-allowed',
                color: isTerminal ? 'var(--error)' : 'var(--text-muted)',
                fontSize: 14, padding: '0 4px', opacity: isTerminal ? 0.6 : 0.3,
              }}
              onMouseEnter={(e) => { if (isTerminal) e.currentTarget.style.opacity = '1' }}
              onMouseLeave={(e) => { if (isTerminal) e.currentTarget.style.opacity = '0.6' }}
            >
              ✕
            </button>
          </Tooltip>
        </td>
      </tr>
      {expanded && (
        <ExpandedTraceRows
          tree={treeCache}
          selectedTraceId={selectedTraceId}
          onSelectTrace={onSelectTrace}
        />
      )}
    </>
  )
}

/** task 展开后渲染 fronts/worker/subagents 子 trace 行 */
export function ExpandedTraceRows({
  tree,
  selectedTraceId,
  onSelectTrace,
}: {
  tree: TraceTree | null | undefined
  selectedTraceId: string | null
  onSelectTrace: (traceId: string, focusWindow?: TraceFocusWindow) => void
}) {
  const [historyExpanded, setHistoryExpanded] = useState(false)
  if (tree === undefined) {
    return (
      <tr>
        <td colSpan={11} style={{ padding: '6px 24px', fontSize: 11, color: 'var(--text-muted)' }}>
          加载关联 trace 中…
        </td>
      </tr>
    )
  }
  if (tree === null) {
    return (
      <tr>
        <td colSpan={11} style={{ padding: '6px 24px', fontSize: 11, color: 'var(--error)' }}>
          关联 trace 加载失败
        </td>
      </tr>
    )
  }
  const total = tree.tree.fronts.length + tree.tree.workers.length + tree.tree.subagents.length
  const epochs = buildTraceEpochs({
    fronts: tree.tree.fronts,
    workers: tree.tree.workers,
    subagents: tree.tree.subagents,
    currentTraceId: selectedTraceId ?? '',
  })
  if (total === 0) {
    return (
      <tr>
        <td colSpan={11} style={{ padding: '6px 24px', fontSize: 11, color: 'var(--text-muted)' }}>
          (该 task 无关联 trace)
        </td>
      </tr>
    )
  }
  const visibleEpochs = epochs.filter((epoch) => epoch.isLatest || epoch.isCurrent)
  const historyEpochs = epochs.filter((epoch) => !visibleEpochs.includes(epoch))
  return (
    <>
      {visibleEpochs.map((epoch) => (
        <ExpandedEpochRows
          key={epoch.id}
          epoch={epoch}
          selectedTraceId={selectedTraceId}
          onSelectTrace={onSelectTrace}
        />
      ))}
      {historyEpochs.length > 0 && (
        <tr
          onClick={(e) => {
            e.stopPropagation()
            setHistoryExpanded((v) => !v)
          }}
          style={{ cursor: 'pointer' }}
        >
          <td colSpan={11} style={{
            padding: '6px 28px',
            borderBottom: '1px solid var(--border)',
            color: 'var(--text-muted)',
            fontSize: 11,
            background: 'rgba(15,23,42,0.03)',
          }}>
            <span style={{ fontFamily: 'var(--font-mono)', marginRight: 6 }}>
              {historyExpanded ? '▼' : '▶'}
            </span>
            历史 epoch ({historyEpochs.length})
          </td>
        </tr>
      )}
      {historyExpanded && historyEpochs.map((epoch) => (
        <ExpandedEpochRows
          key={epoch.id}
          epoch={epoch}
          selectedTraceId={selectedTraceId}
          onSelectTrace={onSelectTrace}
        />
      ))}
    </>
  )
}

function ExpandedEpochRows({
  epoch,
  selectedTraceId,
  onSelectTrace,
}: {
  epoch: TraceEpoch
  selectedTraceId: string | null
  onSelectTrace: (traceId: string, focusWindow?: TraceFocusWindow) => void
}) {
  const [expanded, setExpanded] = useState(epoch.isLatest || epoch.isCurrent)
  useEffect(() => {
    if (epoch.isLatest || epoch.isCurrent) setExpanded(true)
  }, [epoch.isLatest, epoch.isCurrent])

  const headerCell: React.CSSProperties = {
    padding: '5px 10px',
    borderBottom: '1px solid var(--border)',
    verticalAlign: 'middle',
    fontSize: 11,
    background: epoch.isLatest ? 'rgba(16,185,129,0.06)' : 'rgba(15,23,42,0.04)',
  }

  const roleLabel = { dispatcher: 'Dispatch', worker: 'Worker', subagent: 'Subagent' }
  const roleColor = { dispatcher: '#3b82f6', worker: '#8b5cf6', subagent: '#ec4899' }

  return (
    <>
      <tr
        onClick={(e) => {
          e.stopPropagation()
          setExpanded((v) => !v)
        }}
        style={{ cursor: 'pointer' }}
      >
        <td style={headerCell}>{/* checkbox 占位 */}</td>
        <td style={{ ...headerCell, paddingLeft: 28, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
          {expanded ? '▼' : '▶'}
        </td>
        <td style={headerCell}><StatusDot status={epoch.status} size={6} /></td>
        <td style={headerCell} colSpan={4}>
          <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>
            {epoch.label}{epoch.isLatest ? ' · 最新' : ''}{epoch.isCurrent && !epoch.isLatest ? ' · 当前' : ''}
          </span>
          <span style={{ marginLeft: 8, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            {formatTime(epoch.startedAt)} - {epoch.endedAt ? formatTime(epoch.endedAt) : 'now'} · {formatDuration(epoch.durationMs)}
          </span>
        </td>
        <td style={{ ...headerCell, color: 'var(--text-muted)', whiteSpace: 'nowrap' }} colSpan={2}>
          {epoch.roleCounts.dispatcher} Dispatch / {epoch.roleCounts.worker} Task / {epoch.roleCounts.subagent} Sub-agent
        </td>
        <td style={{ ...headerCell, textAlign: 'right', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
          {epoch.totalSpans}
        </td>
        <td style={headerCell}>{/* 单条 trace 不在此处删 */}</td>
      </tr>
      {expanded && epoch.traces.map((m) => {
        const isSelected = selectedTraceId === m.entry.trace_id
        const cell: React.CSSProperties = {
          padding: '4px 10px',
          borderBottom: '1px solid var(--border)',
          verticalAlign: 'middle',
          fontSize: 11,
        }
        return (
          <tr
            key={m.entry.trace_id}
            onClick={(e) => {
              e.stopPropagation()
              onSelectTrace(m.entry.trace_id, epochFocusWindow(epoch))
            }}
            style={{
              cursor: 'pointer',
              background: isSelected ? 'var(--bg-highlight, rgba(59,130,246,0.08))' : 'rgba(0,0,0,0.02)',
            }}
          >
            <td style={cell}>{/* checkbox 占位 */}</td>
            <td style={{ ...cell, paddingLeft: 42, color: 'var(--text-muted)' }}>↳</td>
            <td style={cell}><StatusDot status={m.entry.status} size={6} /></td>
            <td style={cell}>
              <span style={{
                background: roleColor[m.role], color: 'var(--text-on-primary)',
                fontSize: 9, padding: '1px 5px', borderRadius: 3, fontWeight: 500,
              }}>{roleLabel[m.role]}</span>
            </td>
            <td style={{ ...cell, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
              <Tooltip content={m.entry.trace_id}>
                <span>{m.entry.trace_id.slice(0, 8)}</span>
              </Tooltip>
            </td>
            <td style={{ ...cell, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>
              <Tooltip content={m.entry.trigger_summary}>
                <span>{m.entry.trigger_summary || '(空)'}</span>
              </Tooltip>
            </td>
            <td style={{ ...cell, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
              {formatTime(m.entry.started_at)}
            </td>
            <td style={{ ...cell, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
              {formatDuration(m.entry.duration_ms)}
            </td>
            <td style={cell}>{/* 渠道不需要 */}</td>
            <td style={{ ...cell, textAlign: 'right', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
              {m.entry.span_count}
            </td>
            <td style={cell}>{/* 单条 trace 不在此处删 */}</td>
          </tr>
        )
      })}
    </>
  )
}

// ============================================================================
// 主页面
// ============================================================================

const thStyle: React.CSSProperties = {
  padding: '8px 10px',
  textAlign: 'left',
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--text-secondary)',
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap',
}

export const Traces: React.FC = () => {
  const toast = useToast()

  const [filter, setFilter] = useState<FilterState>(() => {
    // URL ?task_id 支持：刷新页面时保留 task 过滤
    const url = new URL(window.location.href)
    const urlTaskId = url.searchParams.get('task_id') ?? ''
    return urlTaskId ? { ...DEFAULT_FILTER, taskId: urlTaskId } : DEFAULT_FILTER
  })
  const [page, setPage] = useState(1)

  const [units, setUnits] = useState<ConversationUnit[]>([])
  const [total, setTotal] = useState(0)
  const [listLoading, setListLoading] = useState(false)
  const [serviceError, setServiceError] = useState('')

  // spec §4.3 task 多选批量删除
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [batchDeleting, setBatchDeleting] = useState(false)

  // spec §4.3 lazy load trace tree（task 展开时加载）
  const [treesCache, setTreesCache] = useState<Map<string, TraceTree | null>>(new Map())

  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null)
  const [selectedTrace, setSelectedTrace] = useState<AgentTrace | null>(null)
  const [selectedFocusWindow, setSelectedFocusWindow] = useState<TraceFocusWindow | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const [autoRefresh, setAutoRefresh] = useState(true)
  const [clearing, setClearing] = useState(false)

  const [manualCleanupOpen, setManualCleanupOpen] = useState(false)
  const [autoCleanupOpen, setAutoCleanupOpen] = useState(false)
  const [statusRefreshKey, setStatusRefreshKey] = useState(0)

  const isFiltered =
    filter.keyword !== '' || filter.status !== '' || filter.range !== 'all' || filter.taskId !== ''

  // 自动刷新策略：第 1 页 + 无筛选时才刷新（避免被翻页或正在查特定 task 时打扰）
  const shouldAutoRefresh = autoRefresh && !isFiltered && page === 1

  const loadList = useCallback(async () => {
    setListLoading(true)
    try {
      const range = rangeToISO(filter.range, filter.customStart, filter.customEnd)
      const params: ListConversationUnitsParams = {
        page,
        page_size: PAGE_SIZE,
        ...(filter.status || filter.keyword || range.start || range.end ? {
          filter: {
            ...(filter.status ? { status: filter.status } : {}),
            ...(filter.keyword ? { search: filter.keyword } : {}),
            ...(range.start ? { created_after: range.start } : {}),
            ...(range.end ? { created_before: range.end } : {}),
          },
        } : {}),
      }
      const result = await traceService.listConversationUnits(params)
      // taskId filter: admin 侧暂无原生 task_id filter，前端二次过滤（含孤儿 dispatcher 排除）
      const filteredItems = filter.taskId
        ? result.items.filter((u) => u.kind === 'task' && u.task.id === filter.taskId)
        : result.items
      setUnits(filteredItems)
      setTotal(filter.taskId ? filteredItems.length : result.pagination.total_items)
      setServiceError('')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setServiceError(`服务未响应: ${msg}`)
      setUnits([])
      setTotal(0)
    } finally {
      setListLoading(false)
    }
  }, [filter, page])

  const loadDetail = useCallback(async (traceId: string, silent = false) => {
    if (!silent) setDetailLoading(true)
    try {
      const result = await traceService.getTrace(traceId)
      setSelectedTrace(result.trace)
    } catch {
      if (!silent) toast.error('无法加载 Trace 详情')
    } finally {
      if (!silent) setDetailLoading(false)
    }
  }, [toast])

  // 列表初次加载
  useEffect(() => { loadList() }, [loadList])

  // 列表自动轮询
  useEffect(() => {
    if (!shouldAutoRefresh) return
    const id = setInterval(loadList, LIST_REFRESH_MS)
    return () => clearInterval(id)
  }, [shouldAutoRefresh, loadList])

  // 详情自动轮询（仅 running trace）
  useEffect(() => {
    if (!selectedTrace || selectedTrace.status !== 'running' || !autoRefresh) return
    const id = setInterval(() => {
      if (selectedTraceId) loadDetail(selectedTraceId, true)
    }, DETAIL_REFRESH_MS)
    return () => clearInterval(id)
  }, [selectedTrace, selectedTraceId, autoRefresh, loadDetail])

  const handleSelectTrace = useCallback(async (traceId: string, focusWindow?: TraceFocusWindow) => {
    setSelectedTraceId(traceId)
    setSelectedFocusWindow(focusWindow ?? null)
    setSelectedTrace(null)
    await loadDetail(traceId)
  }, [loadDetail])

  const handleNavigateTrace = useCallback(async (traceId: string, focusWindow?: TraceFocusWindow) => {
    handleSelectTrace(traceId, focusWindow)
  }, [handleSelectTrace])

  // 永久删除单条 task。活跃 task 后端会拒绝。
  const handleDeleteTask = useCallback(async (taskId: string, title: string) => {
    if (!confirm(`永久删除任务「${title}」？\n（trace 数据不受影响）`)) return
    try {
      await traceService.deleteTask(taskId)
      toast.success('已删除')
      setSelectedIds((prev) => { const n = new Set(prev); n.delete(taskId); return n })
      await loadList()
    } catch (err) {
      toast.error(`删除失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [toast, loadList])

  // 多选 toggle
  const handleToggleSelect = useCallback((taskId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }, [])

  // 全选当前页（仅 task 行 + 终态）
  const handleToggleSelectAll = useCallback(() => {
    const selectable = units
      .filter((u): u is Extract<ConversationUnit, { kind: 'task' }> => u.kind === 'task')
      .filter((u) => u.task.status === 'completed' || u.task.status === 'failed' || u.task.status === 'cancelled')
      .map((u) => u.task.id)
    setSelectedIds((prev) => {
      const allSelected = selectable.every((id) => prev.has(id))
      if (allSelected) {
        const n = new Set(prev)
        selectable.forEach((id) => n.delete(id))
        return n
      }
      const n = new Set(prev)
      selectable.forEach((id) => n.add(id))
      return n
    })
  }, [units])

  // 批量删除
  // 串行执行：admin handleDeleteTask 每次都全量 saveTasks 覆盖 tasks.json，
  // 并发 Promise.all 会让多个 mutation 互相覆盖，晚到的 save 把已被删的 id 重新写回，
  // 下一次请求拿到的 tasks.get(id) 是 stale 的 → 误报 TASK_NOT_FOUND。串行写消除 race。
  const handleBatchDelete = useCallback(async () => {
    if (selectedIds.size === 0) return
    if (!confirm(`确认永久删除选中的 ${selectedIds.size} 个任务？\n（trace 数据不受影响）`)) return
    setBatchDeleting(true)
    const ids = Array.from(selectedIds)
    let ok = 0
    let activeCount = 0
    let notFoundCount = 0
    const otherErrors: string[] = []
    for (const id of ids) {
      try {
        await traceService.deleteTask(id)
        ok++
      } catch (err) {
        const e = err as { body?: { error?: string }; status?: number; message?: string }
        const code = e.body?.error ?? e.message ?? ''
        if (code.includes('TASK_STILL_ACTIVE')) activeCount++
        else if (code.includes('TASK_NOT_FOUND')) notFoundCount++
        else otherErrors.push(code || `HTTP ${e.status ?? '?'}`)
      }
    }
    setBatchDeleting(false)
    setSelectedIds(new Set())
    if (ok === ids.length) {
      toast.success(`已删除 ${ok} 个任务`)
    } else {
      const reasons: string[] = []
      if (activeCount > 0) reasons.push(`活跃 task ${activeCount}`)
      if (notFoundCount > 0) reasons.push(`已不存在 ${notFoundCount}`)
      if (otherErrors.length > 0) {
        // 列前 2 条原始错因，避免文案过长
        const sample = otherErrors.slice(0, 2).join(' / ')
        reasons.push(`其他 ${otherErrors.length}（${sample}）`)
      }
      toast.error(`成功 ${ok} / 失败 ${ids.length - ok} — ${reasons.join('，')}`)
    }
    await loadList()
  }, [selectedIds, toast, loadList])

  // task 行展开时 lazy load trace tree
  const handleLoadTree = useCallback(async (taskId: string) => {
    try {
      const result = await traceService.getTraceTree(taskId)
      setTreesCache((prev) => {
        const n = new Map(prev)
        n.set(taskId, result)
        return n
      })
    } catch {
      setTreesCache((prev) => {
        const n = new Map(prev)
        n.set(taskId, null)
        return n
      })
    }
  }, [])

  const handleClear = useCallback(async () => {
    if (!confirm('确认清理全部 Trace？\n（仅清空内存 ring buffer，磁盘 JSONL 不受影响）')) return
    setClearing(true)
    try {
      const result = await traceService.clearTraces()
      toast.success(`已清理 ${result.cleared_count} 条内存 Trace`)
      await loadList()
      setSelectedTrace(null)
      setSelectedTraceId(null)
      setSelectedFocusWindow(null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`清理失败: ${msg}`)
    } finally {
      setClearing(false)
    }
  }, [toast, loadList])

  const handleFilterChange = useCallback((next: FilterState) => {
    setFilter(next)
    setPage(1) // 改筛选时回到第 1 页
  }, [])

  const handleResetFilter = useCallback(() => {
    setFilter(DEFAULT_FILTER)
    setPage(1)
  }, [])

  // spec §4.3 URL ?task_id 单向同步：filter.taskId 变化 → URL；统一入口，避免散点 setHistory 漏同步
  useEffect(() => {
    const url = new URL(window.location.href)
    const current = url.searchParams.get('task_id') ?? ''
    if (filter.taskId === current) return
    if (filter.taskId) url.searchParams.set('task_id', filter.taskId)
    else url.searchParams.delete('task_id')
    window.history.replaceState({}, '', url.toString())
  }, [filter.taskId])

  // 自动刷新指示文案
  const refreshStatusText = useMemo(() => {
    if (!autoRefresh) return '已暂停自动刷新'
    if (page > 1) return `第 ${page} 页 · 已暂停（翻页时不刷新）`
    if (isFiltered) return '已筛选 · 已暂停（筛选时不刷新）'
    return `自动刷新中（${LIST_REFRESH_MS / 1000}s）`
  }, [autoRefresh, page, isFiltered])

  return (
    <MainLayout>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          gap: 12,
          padding: '8px 24px 16px',
        }}
      >
        {/* 顶部工具栏 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Agent Traces</h2>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            观察 Dispatch / Task / Sub-agent 的执行链路与 Token 用量
          </span>
          <span style={{ flex: 1 }} />
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              color: 'var(--text-secondary)',
              padding: '4px 8px',
              background: shouldAutoRefresh ? 'rgba(16,185,129,0.08)' : 'var(--bg-secondary, #f3f4f6)',
              borderRadius: 4,
            }}
          >
            <StatusDot status={shouldAutoRefresh ? 'completed' : 'failed'} size={6} />
            {refreshStatusText}
          </span>
          <Button
            variant="secondary"
            onClick={() => setAutoRefresh((v) => !v)}
          >
            {autoRefresh ? '⏸ 暂停' : '▶ 恢复'}
          </Button>
          <Button variant="secondary" onClick={loadList} disabled={listLoading}>
            {listLoading ? '加载中...' : '🔄 刷新'}
          </Button>
          <Button variant="danger" onClick={handleClear} disabled={clearing}>
            {clearing ? '清理中...' : '清理内存'}
          </Button>
        </div>

        {/* 磁盘占用状态栏 */}
        <StatusBar
          refreshKey={statusRefreshKey}
          onOpenManualCleanup={() => setManualCleanupOpen(true)}
          onOpenAutoCleanupSettings={() => setAutoCleanupOpen(true)}
        />
        <ManualCleanupDialog
          open={manualCleanupOpen}
          onClose={() => setManualCleanupOpen(false)}
          onDeleted={() => {
            setStatusRefreshKey((k) => k + 1)
            void loadList()
          }}
        />
        <AutoCleanupSettingsDialog
          open={autoCleanupOpen}
          onClose={() => setAutoCleanupOpen(false)}
        />

        {/* 批量操作 + 筛选栏 */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {selectedIds.size > 0 && (
            <Button
              variant="danger"
              onClick={() => void handleBatchDelete()}
              disabled={batchDeleting}
            >
              {batchDeleting ? `删除中…` : `🗑 删除选中 ${selectedIds.size}`}
            </Button>
          )}
          <div style={{ flex: 1, minWidth: 240 }}>
            <FilterBar filter={filter} onChange={handleFilterChange} onReset={handleResetFilter} />
          </div>
        </div>

        {serviceError && (
          <div
            style={{
              padding: '10px 16px',
              background: 'var(--error-glow)',
              border: '1px solid var(--error)',
              borderRadius: 6,
              color: 'var(--error)',
              fontSize: 13,
            }}
          >
            {serviceError}
          </div>
        )}

        {/* 主内容：左列表 + 右详情 */}
        <div style={{ display: 'flex', flex: 1, gap: 12, overflow: 'hidden', minHeight: 0 }}>
          {/* 左侧 Trace 表格 */}
          <div
            className="card"
            style={{
              width: 620,
              flexShrink: 0,
              overflow: 'hidden',
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div style={{ flex: 1, overflow: 'auto' }}>
              {listLoading && units.length === 0 ? (
                <div style={{ padding: 24 }}><Loading /></div>
              ) : units.length === 0 ? (
                <div style={{ padding: 32, color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
                  暂无任务{isFiltered && '（清除筛选试试？）'}
                </div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr
                      style={{
                        position: 'sticky',
                        top: 0,
                        background: 'var(--bg-secondary)',
                        zIndex: 1,
                      }}
                    >
                      <th style={{ ...thStyle, width: 28 }}>
                        <input
                          type="checkbox"
                          checked={units.length > 0 && units
                            .filter((u): u is Extract<ConversationUnit, { kind: 'task' }> => u.kind === 'task')
                            .filter((u) => u.task.status === 'completed' || u.task.status === 'failed' || u.task.status === 'cancelled')
                            .every((u) => selectedIds.has(u.task.id))}
                          onChange={handleToggleSelectAll}
                          title="全选/取消选中当前页所有终态 task"
                        />
                      </th>
                      <th style={{ ...thStyle, width: 22 }}></th>
                      <th style={{ ...thStyle, width: 22 }}></th>
                      <th style={thStyle}>类型</th>
                      <th style={thStyle}>标识</th>
                      <th style={thStyle}>标题 / 摘要</th>
                      <th style={thStyle}>时间</th>
                      <th style={thStyle}>持续</th>
                      <th style={thStyle}>渠道</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>消息</th>
                      <th style={{ ...thStyle, width: 28 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {units.map((u) => (
                      <ConversationUnitRow
                        key={u.kind === 'task' ? `t-${u.task.id}` : `o-${u.trace.trace_id}`}
                        unit={u}
                        selectedTraceId={selectedTraceId}
                        selected={u.kind === 'task' ? selectedIds.has(u.task.id) : false}
                        onToggleSelect={handleToggleSelect}
                        onSelectTrace={handleSelectTrace}
                        onDeleteTask={handleDeleteTask}
                        onLoadTree={handleLoadTree}
                        treeCache={u.kind === 'task' ? treesCache.get(u.task.id) : undefined}
                      />
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <PaginationBar
              page={page}
              pageSize={PAGE_SIZE}
              total={total}
              onChange={setPage}
            />
          </div>

          {/* 右侧详情 */}
          <div className="card" style={{ flex: 1, overflow: 'hidden', padding: 0 }}>
            <TraceDetailPanel
              trace={selectedTrace}
              loading={detailLoading}
              focusWindow={selectedFocusWindow}
              onNavigateTrace={handleNavigateTrace}
            />
          </div>
        </div>
      </div>
    </MainLayout>
  )
}
