/**
 * Worker 详情：以主线化身为默认视角，把已归一化的 trace 投影为人能理解的活动流。
 * 默认隐藏的协议事件仍可在「技术事件」模式查看，cursor 与读接口语义不变。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Loading } from '../../components/Common/Loading'
import { MainLayout } from '../../components/Layout/MainLayout'
import {
  agentObservabilityService,
  type LedgerWorker,
  type WorkerIncarnation,
  type WorkerTaskStatus,
  type WorkerTerminalView,
  type WorkerTraceEvent,
  type WorkerSubagentSummary,
} from '../../services/agent-observability'

const IMPL_LABEL: Record<WorkerIncarnation['impl'], string> = {
  builtin: '内置',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  legacy: '旧版记录',
}
const STATUS_LABEL: Record<WorkerTaskStatus, string> = {
  queued: '排队', running: '执行中', waiting_input: '等输入',
  completed: '已完成', failed: '失败', cancelled: '已取消',
}
const STATUS_COLOR: Record<WorkerTaskStatus, string> = {
  queued: 'var(--text-muted)', running: 'var(--info)', waiting_input: 'var(--warning)',
  completed: 'var(--success)', failed: 'var(--error)', cancelled: 'var(--text-muted)',
}
const INCARNATION_STATE_LABEL: Record<string, string> = {
  running: '执行中', idle: '等输入', exited: '已结束',
}
const SOURCE_LABEL: Record<string, string> = { harness: '执行器', native: '原生记录', legacy: '旧版记录' }
const ORIGIN_LABEL: Record<LedgerWorker['origin']['trigger_type'], string> = {
  message: '消息', scheduled: '定时任务', system: '系统',
}
const KIND_LABEL: Record<WorkerTraceEvent['kind'], string> = {
  message: '消息', llm_call: '模型调用', tool_call: '工具调用', tool_result: '工具结果', thinking: '思考', lifecycle: '生命周期', error: '错误',
}
const ACTIVITY_TONE_COLOR: Record<ActivityTone, string> = {
  manager: 'var(--info)', worker: 'var(--success)', tool: 'var(--warning)', status: 'var(--text-muted)', failure: 'var(--error)',
}
const ACTIVITY_PAGE_SIZE = 20

type DetailRecord = Record<string, unknown>
type ActivityTone = 'manager' | 'worker' | 'tool' | 'status' | 'failure'

interface ActivityEntry {
  event: WorkerTraceEvent
  label: string
  tone: ActivityTone
  body: string
  title?: string
  result?: string
  subagentId?: string
}

function asRecord(value: unknown): DetailRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as DetailRecord : undefined
}

function textBlocks(content: unknown): string | undefined {
  if (typeof content === 'string' && content.trim()) return content
  if (!Array.isArray(content)) return undefined
  const text = content
    .flatMap((item) => {
      const block = asRecord(item)
      return typeof block?.text === 'string' ? [block.text] : []
    })
    .filter(Boolean)
    .join('\n')
  return text || undefined
}

function messageText(event: WorkerTraceEvent): string {
  const detail = asRecord(event.detail)
  return textBlocks(detail?.content) ?? textBlocks(asRecord(detail?.message)?.content) ?? event.summary
}

function toolName(event: WorkerTraceEvent): string | undefined {
  const name = asRecord(event.detail)?.name
  return typeof name === 'string' && name.trim() ? name : undefined
}

function toolArguments(event: WorkerTraceEvent): string {
  const detail = asRecord(event.detail)
  if (typeof detail?.arguments === 'string' && detail.arguments.trim()) return detail.arguments
  if (typeof detail?.input === 'string' && detail.input.trim()) return detail.input
  const input = asRecord(detail?.input)
  return input ? JSON.stringify(input) : event.summary
}

function toolResult(event: WorkerTraceEvent): string {
  const detail = asRecord(event.detail)
  const output = detail?.output
  if (typeof output === 'string' && output.trim()) return output
  if (typeof detail?.content === 'string' && detail.content.trim()) return detail.content
  if (typeof event.detail === 'string' && event.detail.trim()) return event.detail
  return event.summary
}

function callId(event: WorkerTraceEvent): string | undefined {
  const detail = asRecord(event.detail)
  const value = detail?.call_id
    ?? detail?.tool_use_id
    ?? detail?.tool_call_id
    ?? ((detail?.type === 'tool_use' || detail?.type === 'function_call') ? detail.id : undefined)
  if (typeof value !== 'string' || !value) return undefined
  // Responses API 的内部 tool id 可能编码为 call_id|item_id；结果只带 call_id。
  return value.split('|', 1)[0]
}

function subagentId(event: WorkerTraceEvent): string | undefined {
  if (typeof event.subagent_id === 'string' && event.subagent_id) return event.subagent_id
  const value = asRecord(event.detail)?.subagent_id
  return typeof value === 'string' && value ? value : undefined
}

function isUncorrelatedNativeToolCall(event: WorkerTraceEvent): boolean {
  return event.source === 'native' && asRecord(event.detail)?.type === 'tool_use'
}

function failureReason(detail: DetailRecord | undefined, fallback: string): string {
  if (typeof detail?.message === 'string' && detail.message) return detail.message
  if (typeof detail?.error === 'string' && detail.error) return detail.error
  if (typeof detail?.reason === 'string' && detail.reason) return detail.reason
  return fallback
}

function lifecycleActivity(event: WorkerTraceEvent): ActivityEntry | undefined {
  if (event.source !== 'harness') return undefined
  const detail = asRecord(event.detail)
  if (event.summary.startsWith('legacy_imported')) {
    return { event, label: '历史记录', tone: 'status', body: '已导入旧版运行记录' }
  }
  if (event.summary.startsWith('spawned')) {
    const impl = typeof detail?.impl === 'string' ? IMPL_LABEL[detail.impl as WorkerIncarnation['impl']] ?? detail.impl : undefined
    return { event, label: '任务状态', tone: 'status', body: impl ? `已由 ${impl} 启动` : '已启动' }
  }
  if (event.summary.startsWith('state_changed')) {
    const state = typeof detail?.to === 'string' ? INCARNATION_STATE_LABEL[detail.to] ?? detail.to : undefined
    const reason = typeof detail?.reason === 'string' ? detail.reason : undefined
    if (detail?.to === 'exited' && reason && reason !== 'completed') {
      return { event, label: '任务异常退出', tone: 'failure', body: `已结束：${reason}` }
    }
    return { event, label: '任务状态', tone: 'status', body: state ? `状态变为：${state}` : event.summary }
  }
  if (event.summary.startsWith('exited')) {
    const reason = failureReason(detail, event.summary)
    return { event, label: '任务异常退出', tone: 'failure', body: `已结束：${reason}` }
  }
  if (event.summary.startsWith('killed')) {
    const reason = typeof detail?.reason === 'string' ? `：${detail.reason}` : ''
    return { event, label: '任务状态', tone: 'status', body: `已停止${reason}` }
  }
  if (event.summary.startsWith('superseded')) {
    return { event, label: '任务状态', tone: 'status', body: '已交接到新的化身' }
  }
  if (event.summary.startsWith('resumed')) {
    const fromSeq = typeof detail?.from_seq === 'number' ? `从化身 #${detail.from_seq} ` : ''
    return { event, label: '任务状态', tone: 'status', body: `已${fromSeq}恢复执行` }
  }
  if (event.summary.startsWith('input_sent')) {
    const preview = typeof detail?.text_preview === 'string' && detail.text_preview.trim()
      ? detail.text_preview
      : undefined
    return {
      event,
      label: '指令投递',
      tone: 'status',
      body: preview ?? '管理会话的补充指令已确认送达',
    }
  }
  if (event.summary.startsWith('input_delivery_failed')) {
    return { event, label: '投递失败', tone: 'failure', body: failureReason(detail, event.summary) }
  }
  if (event.summary.startsWith('query_completed')) {
    return { event, label: '侧问完成', tone: 'status', body: '临时侧问已完成，可在相应化身中查看结果' }
  }
  if (event.summary.startsWith('query_failed')) {
    return { event, label: '侧问失败', tone: 'failure', body: failureReason(detail, event.summary) }
  }
  return undefined
}

function activityFor(event: WorkerTraceEvent, actorLabel: string, isSubagentTrace: boolean): ActivityEntry | undefined {
  if (event.source === 'legacy') {
    return { event, label: '历史记录', tone: 'status', body: event.summary }
  }
  if (event.kind === 'message' && event.role === 'user') {
    return { event, label: !isSubagentTrace && event.source === 'native' ? '管理会话指令' : `${actorLabel} 指令`, tone: 'manager', body: messageText(event) }
  }
  if (event.kind === 'message' && event.role === 'assistant') {
    return { event, label: `${actorLabel} 文本`, tone: 'worker', body: messageText(event) }
  }
  if (event.kind === 'tool_call') {
    return { event, label: '工具调用', tone: 'tool', title: toolName(event), body: toolArguments(event) }
  }
  if (event.kind === 'tool_result') {
    return { event, label: '工具结果', tone: 'tool', body: toolResult(event) }
  }
  if (event.kind === 'error') {
    return { event, label: '执行器错误', tone: 'failure', body: failureReason(asRecord(event.detail), event.summary) }
  }
  if (event.kind === 'lifecycle') return lifecycleActivity(event)
  return undefined
}

function projectTimeline(events: WorkerTraceEvent[], actorLabel: string, isSubagentTrace: boolean): { human: ActivityEntry[]; technical: WorkerTraceEvent[] } {
  const human: ActivityEntry[] = []
  const technical: WorkerTraceEvent[] = []
  const calls = new Map<string, ActivityEntry>()
  const uncorrelatedNativeCalls: ActivityEntry[] = []

  for (const event of events) {
    const activity = activityFor(event, actorLabel, isSubagentTrace)
    if (!activity) {
      technical.push(event)
      continue
    }
    if (event.kind === 'tool_result') {
      const id = callId(event)
      const pairedCall = id ? calls.get(id) : undefined
      // Claude Code 的 toolUseResult 不携带 tool_use id。其原生记录严格保持调用/结果顺序，
      // 因此仅在没有关联 ID 时按未结算的 tool_use FIFO 配对；带 ID 但找不到调用的结果仍单列。
      const fallbackCall = id === undefined ? uncorrelatedNativeCalls.shift() : undefined
      const targetCall = pairedCall ?? fallbackCall
      if (targetCall) {
        targetCall.result = activity.body
        targetCall.subagentId ??= subagentId(event)
        if (pairedCall) {
          const fallbackIndex = uncorrelatedNativeCalls.indexOf(pairedCall)
          if (fallbackIndex >= 0) uncorrelatedNativeCalls.splice(fallbackIndex, 1)
        }
        continue
      }
    }
    activity.subagentId = subagentId(event)
    human.push(activity)
    if (event.kind === 'tool_call') {
      const id = callId(event)
      if (id) calls.set(id, activity)
      if (isUncorrelatedNativeToolCall(event)) uncorrelatedNativeCalls.push(activity)
    }
  }
  return { human, technical }
}

function mainlineIncarnation(incarnations: WorkerIncarnation[]): WorkerIncarnation | undefined {
  for (let index = incarnations.length - 1; index >= 0; index -= 1) {
    if (incarnations[index].forked_from === undefined) return incarnations[index]
  }
  return incarnations[incarnations.length - 1]
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim() || '（无摘要）'
}

function formatDetail(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

function activityPreview(entry: ActivityEntry): string {
  if (entry.event.kind === 'tool_call') {
    const name = entry.title ? `调用 ${entry.title}` : '工具调用'
    return entry.result ? `${name} · 已返回结果` : name
  }
  if (entry.event.kind === 'tool_result') return '工具结果'
  return oneLine(entry.body)
}

function DetailText({ children }: { children: string }) {
  return (
    <pre style={{ margin: 0, padding: '9px 10px', background: 'var(--bg-muted)', borderTop: '1px solid var(--border)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
      {formatDetail(children)}
    </pre>
  )
}

function TimelineEvent({ entry, expanded, onToggle, workerId }: { entry: ActivityEntry; expanded: boolean; onToggle: () => void; workerId: string }) {
  const preview = activityPreview(entry)
  const action = expanded ? '收起详情' : '展开详情'
  return (
    <article style={{ borderBottom: '1px solid var(--border)' }}>
      <button type="button" aria-expanded={expanded} aria-label={`${entry.label}：${preview}，${action}`} onClick={onToggle} style={{ display: 'grid', gridTemplateColumns: 'minmax(44px, 62px) minmax(76px, 112px) minmax(0, 1fr) auto', gap: 10, alignItems: 'center', width: '100%', padding: '9px 0', border: 0, borderRadius: 0, background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 13, textAlign: 'left', cursor: 'pointer' }}>
        <time style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
          {entry.event.ts ? new Date(entry.event.ts).toLocaleTimeString('zh-CN', { hour12: false }) : ''}
        </time>
        <span style={{ color: ACTIVITY_TONE_COLOR[entry.tone], fontSize: 12, fontWeight: 700 }}>{entry.label}</span>
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{preview}</span>
        <span aria-hidden="true" style={{ color: 'var(--text-muted)', fontSize: 12 }}>{expanded ? '收起' : '展开'}</span>
      </button>
      {expanded && (
        <div style={{ padding: '0 0 12px 72px', minWidth: 0 }}>
          {entry.event.kind === 'tool_call' ? (
            <>
              <div style={{ color: 'var(--text-muted)', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>输入{entry.title ? ` · ${entry.title}` : ''}</div>
              <DetailText>{entry.body}</DetailText>
              {entry.result && (
                <>
                  <div style={{ color: 'var(--text-muted)', fontSize: 12, fontWeight: 600, margin: '10px 0 4px' }}>输出</div>
                  <DetailText>{entry.result}</DetailText>
                </>
              )}
            </>
          ) : entry.event.kind === 'tool_result' ? (
            <>
              <div style={{ color: 'var(--text-muted)', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>输出</div>
              <DetailText>{entry.body}</DetailText>
            </>
          ) : (
            <DetailText>{entry.body}</DetailText>
          )}
          {entry.subagentId && (
            <Link to={`/traces/workers/${encodeURIComponent(workerId)}/subagents/${encodeURIComponent(entry.subagentId)}`} style={{ display: 'inline-block', marginTop: 10, color: 'var(--primary)', fontSize: 12 }}>
              查看子 Agent
            </Link>
          )}
        </div>
      )}
    </article>
  )
}

function TechnicalEvent({ event, expanded, onToggle, workerId }: { event: WorkerTraceEvent; expanded: boolean; onToggle: () => void; workerId: string }) {
  const source = event.source ? SOURCE_LABEL[event.source] ?? event.source : '—'
  const label = `${source} · ${KIND_LABEL[event.kind]}`
  const action = expanded ? '收起详情' : '展开详情'
  const childId = subagentId(event)
  return (
    <article style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>
      <button type="button" aria-expanded={expanded} aria-label={`${label}：${oneLine(event.summary)}，${action}`} onClick={onToggle} style={{ display: 'grid', gridTemplateColumns: 'minmax(44px, 62px) minmax(76px, 112px) minmax(0, 1fr) auto', gap: 10, alignItems: 'center', width: '100%', padding: '9px 0', border: 0, borderRadius: 0, background: 'transparent', color: 'inherit', fontFamily: 'var(--font-mono)', fontSize: 12, textAlign: 'left', cursor: 'pointer' }}>
        <time>{event.ts ? new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false }) : ''}</time>
        <span>{label}</span>
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{oneLine(event.summary)}</span>
        <span aria-hidden="true">{expanded ? '收起' : '展开'}</span>
      </button>
      {expanded && (
        <div style={{ padding: '0 0 12px 72px' }}>
          {event.detail !== undefined && <DetailText>{JSON.stringify(event.detail)}</DetailText>}
          {childId && (
            <Link to={`/traces/workers/${encodeURIComponent(workerId)}/subagents/${encodeURIComponent(childId)}`} style={{ display: 'inline-block', marginTop: 10, color: 'var(--primary)', fontSize: 12 }}>
              查看子 Agent
            </Link>
          )}
        </div>
      )}
    </article>
  )
}

export function Timeline({
  workerId,
  seq,
  heading = '活动记录',
  actorLabel = 'Worker',
  isSubagentTrace = false,
  loadTrace,
}: {
  workerId: string
  seq?: number
  heading?: string
  actorLabel?: string
  isSubagentTrace?: boolean
  loadTrace?: (cursor?: string) => Promise<{ events: WorkerTraceEvent[]; next_cursor?: string; unavailable_reason?: string }>
}) {
  const [events, setEvents] = useState<WorkerTraceEvent[]>([])
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined)
  const [unavailableReason, setUnavailableReason] = useState<string | undefined>(undefined)
  const [cursorInvalid, setCursorInvalid] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<'human' | 'technical'>('human')
  const [page, setPage] = useState(1)
  const [expandedEntry, setExpandedEntry] = useState<string | undefined>(undefined)
  const [refreshing, setRefreshing] = useState(false)
  const projected = useMemo(() => projectTimeline(events, actorLabel, isSubagentTrace), [events, actorLabel, isSubagentTrace])

  const load = useCallback(async (cursor?: string) => {
    try {
      const result = loadTrace
        ? await loadTrace(cursor)
        : await agentObservabilityService.getWorkerTrace(workerId, {
          ...(seq !== undefined ? { seq } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
        })
      setUnavailableReason(result.unavailable_reason)
      if (cursor === undefined) setEvents(result.events)
      else setEvents((previous) => [...previous, ...result.events])
      setNextCursor(result.next_cursor)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('INVALID_PARAMS') || message.includes('cursor')) {
        // cursor 失效（Agent restart/GC/化身变化）：显式提示，不静默拼接重复数据。
        setCursorInvalid(true)
      } else {
        setError(message)
      }
    }
  }, [workerId, seq, loadTrace])

  useEffect(() => {
    setEvents([])
    setNextCursor(undefined)
    setUnavailableReason(undefined)
    setCursorInvalid(false)
    setError(null)
    setMode('human')
    setPage(1)
    setExpandedEntry(undefined)
    void load(undefined)
  }, [load])

  if (error) return <div style={{ color: 'var(--text-muted)', padding: 12 }}>活动记录暂不可用：{error}</div>

  const visibleEvents = mode === 'human' ? projected.human : projected.technical
  const pageCount = Math.max(1, Math.ceil(visibleEvents.length / ACTIVITY_PAGE_SIZE))
  const pageStart = (page - 1) * ACTIVITY_PAGE_SIZE
  const humanPageEvents = projected.human.slice(pageStart, pageStart + ACTIVITY_PAGE_SIZE)
  const technicalPageEvents = projected.technical.slice(pageStart, pageStart + ACTIVITY_PAGE_SIZE)
  const checkNewActivity = async () => {
    if (!nextCursor || refreshing) return
    setRefreshing(true)
    await load(nextCursor)
    setRefreshing(false)
  }
  const selectMode = (nextMode: 'human' | 'technical') => {
    setMode(nextMode)
    setPage(1)
    setExpandedEntry(undefined)
  }
  return (
    <section style={{ maxWidth: 930 }} aria-label="任务活动">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 11 }}>
        <h2 style={{ fontSize: 15, margin: 0 }}>{heading}</h2>
        <div style={{ display: 'inline-flex', gap: 2, padding: 2, border: '1px solid var(--border-highlight)', borderRadius: 6, background: 'var(--bg-primary)' }}>
          <button type="button" aria-pressed={mode === 'human'} onClick={() => selectMode('human')} style={{ border: 0, borderRadius: 4, padding: '5px 9px', background: mode === 'human' ? 'var(--primary)' : 'transparent', color: mode === 'human' ? 'var(--text-on-primary)' : 'var(--text-secondary)', fontWeight: mode === 'human' ? 600 : 400, transition: 'background 0.15s ease, color 0.15s ease' }}>
            对话与操作
          </button>
          <button type="button" aria-pressed={mode === 'technical'} onClick={() => selectMode('technical')} style={{ border: 0, borderRadius: 4, padding: '5px 9px', background: mode === 'technical' ? 'var(--primary)' : 'transparent', color: mode === 'technical' ? 'var(--text-on-primary)' : 'var(--text-secondary)', fontWeight: mode === 'technical' ? 600 : 400, transition: 'background 0.15s ease, color 0.15s ease' }}>
            技术事件 {projected.technical.length}
          </button>
        </div>
      </div>
      <div style={{ borderTop: '1px solid var(--border)' }}>
        {unavailableReason && <div style={{ fontSize: 12, color: 'var(--color-warning, #d97706)', padding: '4px 0' }}>{unavailableReason}</div>}
        {visibleEvents.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', padding: 12 }}>{mode === 'human' ? '该化身暂无可读活动。' : '该化身暂无技术事件。'}</div>
        ) : mode === 'human' ? (
          humanPageEvents.map((entry, index) => {
            const entryKey = `activity-${pageStart + index}-${entry.event.ts}-${entry.event.kind}-${callId(entry.event) ?? ''}`
            return <TimelineEvent key={entryKey} entry={entry} workerId={workerId} expanded={expandedEntry === entryKey} onToggle={() => setExpandedEntry((current) => current === entryKey ? undefined : entryKey)} />
          })
        ) : (
          technicalPageEvents.map((event, index) => {
            const entryKey = `technical-${pageStart + index}-${event.ts}-${event.kind}`
            return <TechnicalEvent key={entryKey} event={event} workerId={workerId} expanded={expandedEntry === entryKey} onToggle={() => setExpandedEntry((current) => current === entryKey ? undefined : entryKey)} />
          })
        )}
        {cursorInvalid && (
          <div style={{ fontSize: 12, color: 'var(--color-warning, #d97706)', padding: '8px 0' }}>
            游标已失效。
            <button type="button" onClick={() => { setCursorInvalid(false); setEvents([]); setPage(1); setExpandedEntry(undefined); void load(undefined) }} style={{ marginLeft: 8 }}>
              从头重新加载
            </button>
          </div>
        )}
        {!cursorInvalid && (visibleEvents.length > 0 || nextCursor) && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', paddingTop: 10 }}>
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>第 {page} / {pageCount} 页</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" disabled={page === 1} onClick={() => { setPage((current) => current - 1); setExpandedEntry(undefined) }}>上一页</button>
              <button type="button" disabled={page === pageCount} onClick={() => { setPage((current) => current + 1); setExpandedEntry(undefined) }}>下一页</button>
              {nextCursor && <button type="button" disabled={refreshing} onClick={() => void checkNewActivity()}>{refreshing ? '读取中…' : '检查新活动'}</button>}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

const SUBAGENT_STATUS_LABEL: Record<WorkerSubagentSummary['status'], string> = {
  running: '执行中', completed: '已完成', failed: '失败', stopped: '已停止', interrupted: '已中断', unknown: '状态未知',
}

function formatSubagentStartedAt(value: string | undefined): string {
  if (!value) return '开始时间未知'
  return new Date(value).toLocaleString('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

function formatSubagentDuration(subagent: WorkerSubagentSummary): string | undefined {
  if (!subagent.started_at) return undefined
  const start = Date.parse(subagent.started_at)
  const end = Date.parse(subagent.ended_at ?? new Date().toISOString())
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined
  const minutes = Math.floor((end - start) / 60_000)
  if (minutes < 1) return subagent.status === 'running' ? '已运行不足 1 分钟' : '用时不足 1 分钟'
  const hours = Math.floor(minutes / 60)
  const label = subagent.status === 'running' ? '已运行' : '用时'
  return hours > 0 ? `${label} ${hours} 小时 ${minutes % 60} 分钟` : `${label} ${minutes} 分钟`
}

function WorkerSubagentsPanel({ workerId }: { workerId: string }) {
  const [subagents, setSubagents] = useState<WorkerSubagentSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setSubagents((await agentObservabilityService.listWorkerSubagents(workerId)).subagents)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [workerId])

  useEffect(() => { void load() }, [load])

  if (!error && subagents.length === 0) return null

  return (
    <section aria-label="子 Agent" style={{ maxWidth: 930, marginTop: 30 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
        <div>
          <h2 style={{ fontSize: 15, margin: 0 }}>子 Agent</h2>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 3 }}>该 Worker 直接启动的子 Agent</div>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading}>{loading ? '读取中…' : '刷新'}</button>
      </div>
      {error && <div style={{ color: 'var(--color-warning, #d97706)', fontSize: 12, padding: '8px 0' }}>子 Agent 暂不可用：{error}</div>}
      {subagents.length > 0 && (
        <div style={{ borderTop: '1px solid var(--border)' }}>
          {subagents.map((subagent) => {
            const duration = formatSubagentDuration(subagent)
            return (
              <Link key={subagent.subagent_id} to={`/traces/workers/${encodeURIComponent(workerId)}/subagents/${encodeURIComponent(subagent.subagent_id)}`} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(126px, .55fr) minmax(70px, auto) auto', gap: 12, alignItems: 'center', padding: '12px 0', borderBottom: '1px solid var(--border)', color: 'inherit', textDecoration: 'none' }}>
                <span style={{ minWidth: 0 }}>
                  <strong style={{ display: 'block', overflowWrap: 'anywhere' }}>{subagent.name}</strong>
                  <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 12, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subagent.task ?? subagent.subagent_id}</span>
                </span>
                <span style={{ minWidth: 0, color: 'var(--text-muted)', fontSize: 12 }}>
                  <span style={{ display: 'block', whiteSpace: 'nowrap' }}>{formatSubagentStartedAt(subagent.started_at)}</span>
                  {duration && <span style={{ display: 'block', marginTop: 3 }}>{duration}</span>}
                </span>
                <span style={{ fontSize: 12 }}>{SUBAGENT_STATUS_LABEL[subagent.status]}</span>
                <span aria-hidden="true" style={{ color: 'var(--text-muted)' }}>查看 →</span>
              </Link>
            )
          })}
        </div>
      )}
    </section>
  )
}

function terminalLabel(view: WorkerTerminalView): string {
  switch (view.kind) {
    case 'live_terminal': return '当前终端画面'
    case 'final_terminal': return '最终终端画面'
    case 'headless_text': return '无头文本输出'
    case 'unavailable': return '终端画面不可用'
  }
}

function OutputPanel({ workerId, seq }: { workerId: string; seq?: number }) {
  const [terminal, setTerminal] = useState<WorkerTerminalView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setTerminal(await agentObservabilityService.getWorkerTerminal(workerId, seq === undefined ? {} : { seq }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [workerId, seq])

  useEffect(() => {
    setTerminal(null)
    void load()
  }, [load])

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{terminal ? terminalLabel(terminal) : '读取终端画面'}</span>
        <button type="button" onClick={() => void load()} disabled={loading}>{loading ? '刷新中' : '刷新画面'}</button>
      </div>
      {error && <div style={{ color: 'var(--color-warning, #d97706)', fontSize: 12, marginBottom: 8 }}>终端画面暂不可用：{error}</div>}
      {terminal?.kind === 'unavailable' ? (
        <div style={{ color: 'var(--text-muted)', padding: 12 }}>不可用原因：{terminal.unavailable_reason}</div>
      ) : (
      <pre style={{ background: 'var(--bg-muted, #f6f6f6)', padding: 12, borderRadius: 8, maxHeight: 320, overflow: 'auto', fontSize: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {terminal?.text || '（无内容）'}
      </pre>
      )}
    </div>
  )
}

function formatTimestamp(value: string | undefined): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '—'
}

function incarnationRole(incarnation: WorkerIncarnation, mainline: boolean): string {
  if (mainline) return '主线'
  if (incarnation.forked_from !== undefined) return `临时侧问（来自 #${incarnation.forked_from}）`
  return '历史化身'
}

function OverviewFact({ label, children, accent = false, separated = false }: {
  label: string
  children: React.ReactNode
  accent?: boolean
  separated?: boolean
}) {
  return (
    <div style={{ minWidth: 0, padding: `12px 14px 13px ${separated ? 14 : 0}px`, borderLeft: separated ? '1px solid var(--border)' : undefined }}>
      <div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 3 }}>{label}</div>
      <div style={{ overflowWrap: 'anywhere', color: accent ? 'var(--info)' : undefined, fontSize: 13, fontWeight: 600 }}>{children}</div>
    </div>
  )
}

function IncarnationRow({ incarnation, mainline, onSelect, selected }: {
  incarnation: WorkerIncarnation
  mainline: boolean
  selected: boolean
  onSelect: () => void
}) {
  const role = incarnationRole(incarnation, mainline)
  return (
    <button type="button" onClick={onSelect} aria-pressed={selected} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(118px, 1fr))', gap: 12, width: '100%', padding: '10px 12px', border: 0, borderTop: '1px solid var(--border)', borderRadius: 0, background: selected ? 'var(--bg-muted)' : 'transparent', color: 'inherit', font: 'inherit', fontSize: 12, textAlign: 'left', cursor: 'pointer' }}>
      <span style={{ fontWeight: 700 }}>#{incarnation.seq} · {role}</span>
      <span>{IMPL_LABEL[incarnation.impl]}</span>
      <span style={{ color: 'var(--text-muted)' }}>{INCARNATION_STATE_LABEL[incarnation.state] ?? incarnation.state}{incarnation.ended_reason ? ` · ${incarnation.ended_reason}` : ''}</span>
      <span style={{ color: 'var(--text-muted)' }}>{formatTimestamp(incarnation.started_at)}{incarnation.ended_at ? ` → ${formatTimestamp(incarnation.ended_at)}` : ' → 现在'}</span>
    </button>
  )
}

const WorkerDetailContent: React.FC = () => {
  const { workerId = '' } = useParams()
  const [worker, setWorker] = useState<LedgerWorker | null>(null)
  const [selectedSeq, setSelectedSeq] = useState<number | undefined>(undefined)
  const [managerDisplayName, setManagerDisplayName] = useState<string | null | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setManagerDisplayName(undefined)
    const managersRequest = agentObservabilityService.listManagers(1, 100).catch(() => undefined)
    agentObservabilityService
      .getWorkerDetail(workerId)
      .then((result) => {
        if (cancelled) return
        setWorker(result.worker)
        setSelectedSeq(mainlineIncarnation(result.worker.incarnations)?.seq)
        void managersRequest
          .then((managerResult) => {
            if (cancelled) return
            const displayName = managerResult?.items.find((item) => item.manager_key === result.worker.manager_key)?.display_name
            setManagerDisplayName(displayName && displayName !== result.worker.manager_key ? displayName : null)
          })
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [workerId])

  if (loading) return <Loading />
  if (error || !worker) return <div style={{ color: 'var(--text-muted)', padding: 24 }}>任务详情暂不可用：{error ?? '未找到'}</div>

  const mainline = mainlineIncarnation(worker.incarnations)
  const mainlineSeq = mainline?.seq
  const selectedIncarnation = worker.incarnations.find((incarnation) => incarnation.seq === selectedSeq) ?? mainline
  return (
    <div style={{ maxWidth: 980 }}>
      <div style={{ marginBottom: 18 }}>
        <Link to="/traces" style={{ color: 'var(--text-muted)', fontSize: 12 }}>← 返回任务列表</Link>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginTop: 8, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <h1 style={{ fontSize: 22, lineHeight: 1.3, margin: 0 }}>{worker.task.title}</h1>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', marginTop: 5 }}>{worker.worker_id}</div>
          </div>
          <span style={{ flex: '0 0 auto', color: STATUS_COLOR[worker.task.status], border: `1px solid ${STATUS_COLOR[worker.task.status]}`, padding: '4px 8px', fontSize: 12, fontWeight: 700 }}>
            {STATUS_LABEL[worker.task.status]}
          </span>
        </div>
      </div>

      <section aria-label="任务概览" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', margin: '22px 0 28px', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)' }}>
        <OverviewFact label="主线实现" accent>{mainline ? IMPL_LABEL[mainline.impl] : '—'}</OverviewFact>
        <OverviewFact label="当前化身" separated>{selectedIncarnation ? `#${selectedIncarnation.seq} ${incarnationRole(selectedIncarnation, selectedIncarnation.seq === mainlineSeq)}` : '—'}</OverviewFact>
        <OverviewFact label="回报目标" separated>{worker.report_to.channel_id} / {worker.report_to.session_id}</OverviewFact>
        <OverviewFact label="最近活动" separated>{formatTimestamp(worker.updated_at)}</OverviewFact>
      </section>

      {worker.legacy_source && (
        <div style={{ background: 'var(--warning-bg)', border: '1px solid var(--warning-border)', borderRadius: 6, padding: 10, margin: '-12px 0 24px', color: 'var(--warning-text)' }}>
          这是从旧版运行时导入的旧版记录，不代表当前可运行的任务化身。
          {worker.legacy_source.trace_ids?.length ? ` 保留 ${worker.legacy_source.trace_ids.length} 条旧版追踪记录引用。` : ''}
        </div>
      )}

      <section aria-label="化身链" style={{ maxWidth: 930 }}>
        <h2 style={{ fontSize: 15, margin: '0 0 11px' }}>化身链</h2>
        <div style={{ borderBottom: '1px solid var(--border)' }}>
          {worker.incarnations.map((incarnation) => (
            <IncarnationRow key={incarnation.seq} incarnation={incarnation} mainline={incarnation.seq === mainlineSeq} selected={incarnation.seq === selectedSeq} onSelect={() => setSelectedSeq(incarnation.seq)} />
          ))}
        </div>
      </section>

      <div style={{ marginTop: 30 }}>
        <Timeline workerId={worker.worker_id} seq={selectedSeq} />
      </div>

      <WorkerSubagentsPanel workerId={worker.worker_id} />

      <details style={{ maxWidth: 930, marginTop: 28, padding: '12px 14px', border: '1px solid var(--border)', background: 'var(--bg-muted)' }}>
        <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>终端画面</summary>
        <div style={{ marginTop: 12 }}><OutputPanel workerId={worker.worker_id} seq={selectedSeq} /></div>
      </details>

      <details style={{ maxWidth: 930, marginTop: 14, color: 'var(--text-muted)', fontSize: 12 }}>
        <summary style={{ cursor: 'pointer' }}>运行上下文</summary>
        <div style={{ display: 'grid', gap: 4, marginTop: 10 }}>
          <div>所属会话：<Link to={`/traces/managers/${encodeURIComponent(worker.manager_key)}`}>{managerDisplayName === undefined ? '正在读取名称…' : managerDisplayName ?? '名称暂不可用'}</Link></div>
          {mainline?.workspace && <div>工作区：<span style={{ fontFamily: 'var(--font-mono)' }}>{mainline.workspace}</span></div>}
          <div>来源：{ORIGIN_LABEL[worker.origin.trigger_type]}{worker.origin.spawned_by_episode ? ` · 执行轮次 ${worker.origin.spawned_by_episode.slice(0, 8)}` : ''}</div>
        </div>
      </details>
    </div>
  )
}

/** 详情页也包 MainLayout（不丢侧边导航）。 */
export const WorkerDetail: React.FC = () => (
  <MainLayout>
    <WorkerDetailContent />
  </MainLayout>
)
