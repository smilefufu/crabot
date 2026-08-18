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
  type WorkerTraceEvent,
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
const SOURCE_LABEL: Record<string, string> = { harness: 'harness', native: 'native', legacy: 'legacy' }
const KIND_LABEL: Record<WorkerTraceEvent['kind'], string> = {
  message: '消息', tool_call: '工具调用', tool_result: '工具结果', thinking: '思考', lifecycle: '生命周期',
}
const ACTIVITY_TONE_COLOR: Record<ActivityTone, string> = {
  manager: 'var(--info)', worker: 'var(--success)', tool: 'var(--warning)', status: 'var(--text-muted)', failure: 'var(--error)',
}

type DetailRecord = Record<string, unknown>
type ActivityTone = 'manager' | 'worker' | 'tool' | 'status' | 'failure'

interface ActivityEntry {
  event: WorkerTraceEvent
  label: string
  tone: ActivityTone
  body: string
  title?: string
  result?: string
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
  const value = asRecord(event.detail)?.call_id
  return typeof value === 'string' && value ? value : undefined
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
  if (event.summary.startsWith('spawned')) {
    const impl = typeof detail?.impl === 'string' ? IMPL_LABEL[detail.impl as WorkerIncarnation['impl']] ?? detail.impl : undefined
    return { event, label: 'Worker 状态', tone: 'status', body: impl ? `已由 ${impl} 启动` : '已启动' }
  }
  if (event.summary.startsWith('state_changed')) {
    const state = typeof detail?.to === 'string' ? INCARNATION_STATE_LABEL[detail.to] ?? detail.to : undefined
    const reason = typeof detail?.reason === 'string' ? detail.reason : undefined
    if (detail?.to === 'exited' && reason && reason !== 'completed') {
      return { event, label: 'Worker 异常退出', tone: 'failure', body: `已结束：${reason}` }
    }
    return { event, label: 'Worker 状态', tone: 'status', body: state ? `状态变为：${state}` : event.summary }
  }
  if (event.summary.startsWith('exited')) {
    const reason = failureReason(detail, event.summary)
    return { event, label: 'Worker 异常退出', tone: 'failure', body: `已结束：${reason}` }
  }
  if (event.summary.startsWith('killed')) {
    const reason = typeof detail?.reason === 'string' ? `：${detail.reason}` : ''
    return { event, label: 'Worker 状态', tone: 'status', body: `已停止${reason}` }
  }
  if (event.summary.startsWith('superseded')) {
    return { event, label: 'Worker 状态', tone: 'status', body: '已交接到新的化身' }
  }
  if (event.summary.startsWith('resumed')) {
    const fromSeq = typeof detail?.from_seq === 'number' ? `从化身 #${detail.from_seq} ` : ''
    return { event, label: 'Worker 状态', tone: 'status', body: `已${fromSeq}恢复执行` }
  }
  if (event.summary.startsWith('input_sent')) {
    return { event, label: '指令投递', tone: 'status', body: 'Manager 的补充指令已确认送达' }
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

function activityFor(event: WorkerTraceEvent): ActivityEntry | undefined {
  if (event.source === 'native' && event.kind === 'message' && event.role === 'user') {
    return { event, label: 'Manager 指令', tone: 'manager', body: messageText(event) }
  }
  if (event.source === 'native' && event.kind === 'message' && event.role === 'assistant') {
    return { event, label: 'Worker 输出', tone: 'worker', body: messageText(event) }
  }
  if (event.kind === 'tool_call') {
    return { event, label: '工具调用', tone: 'tool', title: toolName(event), body: toolArguments(event) }
  }
  if (event.kind === 'tool_result') {
    return { event, label: '工具结果', tone: 'tool', body: toolResult(event) }
  }
  if (event.kind === 'lifecycle') return lifecycleActivity(event)
  return undefined
}

function projectTimeline(events: WorkerTraceEvent[]): { human: ActivityEntry[]; technical: WorkerTraceEvent[] } {
  const human: ActivityEntry[] = []
  const technical: WorkerTraceEvent[] = []
  const calls = new Map<string, ActivityEntry>()

  for (const event of events) {
    const activity = activityFor(event)
    if (!activity) {
      technical.push(event)
      continue
    }
    if (event.kind === 'tool_result') {
      const id = callId(event)
      const pairedCall = id ? calls.get(id) : undefined
      if (pairedCall) {
        pairedCall.result = activity.body
        continue
      }
    }
    human.push(activity)
    if (event.kind === 'tool_call') {
      const id = callId(event)
      if (id) calls.set(id, activity)
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

function CollapsibleText({ children }: { children: string }) {
  const [expanded, setExpanded] = useState(false)
  const canCollapse = children.length > 360
  return (
    <>
      <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', ...(expanded || !canCollapse ? {} : { maxHeight: 88, overflow: 'hidden' }) }}>
        {children}
      </div>
      {canCollapse && (
        <button type="button" onClick={() => setExpanded((value) => !value)} style={{ marginTop: 6, fontSize: 12 }}>
          {expanded ? '收起' : '展开全文'}
        </button>
      )}
    </>
  )
}

function TimelineEvent({ entry }: { entry: ActivityEntry }) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap', padding: '12px 0', borderTop: '1px solid var(--border)' }}>
      <time style={{ color: 'var(--text-muted)', width: 56, paddingTop: 1, fontFamily: 'var(--font-mono)', fontSize: 12 }}>
        {entry.event.ts ? new Date(entry.event.ts).toLocaleTimeString('zh-CN', { hour12: false }) : ''}
      </time>
      <div style={{ color: ACTIVITY_TONE_COLOR[entry.tone], width: 100, paddingTop: 1, fontSize: 12, fontWeight: 600 }}>{entry.label}</div>
      <div style={{ flex: '1 1 360px', minWidth: 0, fontSize: 13 }}>
        {entry.title && <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, marginBottom: 4 }}>{entry.title}</div>}
        <CollapsibleText>{entry.body}</CollapsibleText>
        {entry.result && (
          <div style={{ borderLeft: '3px solid var(--warning)', marginTop: 10, paddingLeft: 10 }}>
            <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 4 }}>工具结果</div>
            <CollapsibleText>{entry.result}</CollapsibleText>
          </div>
        )}
      </div>
    </div>
  )
}

function TechnicalEvent({ event }: { event: WorkerTraceEvent }) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap', padding: '8px 0', borderTop: '1px solid var(--border)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
      <time style={{ width: 56 }}>{event.ts ? new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false }) : ''}</time>
      <span style={{ width: 64 }}>{event.source ? SOURCE_LABEL[event.source] ?? event.source : '—'}</span>
      <span style={{ width: 72 }}>{KIND_LABEL[event.kind]}</span>
      <span style={{ flex: '1 1 280px', minWidth: 0, overflowWrap: 'anywhere' }}>{event.summary || '（无摘要）'}</span>
    </div>
  )
}

function Timeline({ workerId, seq }: { workerId: string; seq?: number }) {
  const [events, setEvents] = useState<WorkerTraceEvent[]>([])
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined)
  const [hasMore, setHasMore] = useState(true)
  const [unavailableReason, setUnavailableReason] = useState<string | undefined>(undefined)
  const [cursorInvalid, setCursorInvalid] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<'human' | 'technical'>('human')
  const projected = useMemo(() => projectTimeline(events), [events])

  const load = useCallback(async (cursor?: string) => {
    try {
      const result = await agentObservabilityService.getWorkerTrace(workerId, {
        ...(seq !== undefined ? { seq } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
      })
      setUnavailableReason(result.unavailable_reason)
      if (cursor === undefined) setEvents(result.events)
      else setEvents((previous) => [...previous, ...result.events])
      setNextCursor(result.next_cursor)
      // 空页=当前追平（不是"没有更多"）——活跃 worker 之后还可能有新事件，
      // 按钮切换为刷新语义而不是永久消失。
      setHasMore(result.next_cursor !== undefined)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('INVALID_PARAMS') || message.includes('cursor')) {
        // cursor 失效（Agent restart/GC/化身变化）：显式提示，不静默拼接重复数据。
        setCursorInvalid(true)
      } else {
        setError(message)
      }
    }
  }, [workerId, seq])

  useEffect(() => {
    setEvents([])
    setNextCursor(undefined)
    setHasMore(true)
    setUnavailableReason(undefined)
    setCursorInvalid(false)
    setError(null)
    setMode('human')
    void load(undefined)
  }, [load])

  if (error) return <div style={{ color: 'var(--text-muted)', padding: 12 }}>活动记录暂不可用：{error}</div>

  const visibleEvents = mode === 'human' ? projected.human : projected.technical
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <div style={{ display: 'inline-flex', border: '1px solid var(--border)' }}>
          <button type="button" aria-pressed={mode === 'human'} onClick={() => setMode('human')} style={{ border: 0, padding: '5px 8px', background: mode === 'human' ? 'var(--bg-muted)' : undefined }}>
            对话与操作
          </button>
          <button type="button" aria-pressed={mode === 'technical'} onClick={() => setMode('technical')} style={{ border: 0, borderLeft: '1px solid var(--border)', padding: '5px 8px', background: mode === 'technical' ? 'var(--bg-muted)' : undefined }}>
            技术事件 {projected.technical.length}
          </button>
        </div>
      </div>
      {unavailableReason && <div style={{ fontSize: 12, color: 'var(--color-warning, #d97706)', padding: '4px 0' }}>{unavailableReason}</div>}
      {visibleEvents.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', padding: 12 }}>{mode === 'human' ? '该化身暂无可读活动。' : '该化身暂无技术事件。'}</div>
      ) : mode === 'human' ? (
        projected.human.map((entry, index) => <TimelineEvent key={`${entry.event.ts}-${entry.event.kind}-${index}`} entry={entry} />)
      ) : (
        projected.technical.map((event, index) => <TechnicalEvent key={`${event.ts}-${event.kind}-${index}`} event={event} />)
      )}
      {cursorInvalid && (
        <div style={{ fontSize: 12, color: 'var(--color-warning, #d97706)', padding: '8px 0' }}>
          游标已失效。
          <button type="button" onClick={() => { setCursorInvalid(false); setEvents([]); void load(undefined) }} style={{ marginLeft: 8 }}>
            从头重新加载
          </button>
        </div>
      )}
      {!cursorInvalid && hasMore && nextCursor && (
        <button type="button" onClick={() => void load(nextCursor)} style={{ marginTop: 8 }}>
          {events.length === 0 ? '刷新/检查新内容' : '加载更多'}
        </button>
      )}
    </div>
  )
}

function OutputPanel({ workerId, seq }: { workerId: string; seq?: number }) {
  const [chunk, setChunk] = useState('')
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined)
  const [hasMore, setHasMore] = useState(false)
  const [cursorInvalid, setCursorInvalid] = useState(false)

  const load = useCallback(async (cursor?: string) => {
    try {
      const result = await agentObservabilityService.readWorkerOutput(workerId, {
        ...(seq !== undefined ? { seq } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
      })
      if (cursor === undefined) setChunk(result.chunk)
      else setChunk((previous) => previous + result.chunk)
      setNextCursor(result.next_cursor)
      setHasMore(result.chunk.length > 0 && result.next_cursor !== undefined)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('INVALID_PARAMS') || message.includes('cursor')) setCursorInvalid(true)
    }
  }, [workerId, seq])

  useEffect(() => {
    setChunk('')
    setCursorInvalid(false)
    void load(undefined)
  }, [load])

  return (
    <div>
      <pre style={{ background: 'var(--bg-muted, #f6f6f6)', padding: 12, borderRadius: 8, maxHeight: 320, overflow: 'auto', fontSize: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {chunk || '（无输出）'}
      </pre>
      {cursorInvalid && (
        <div style={{ fontSize: 12, color: 'var(--color-warning, #d97706)' }}>
          游标已失效。
          <button type="button" onClick={() => { setCursorInvalid(false); setChunk(''); void load(undefined) }} style={{ marginLeft: 8 }}>从头重新加载</button>
        </div>
      )}
      {!cursorInvalid && hasMore && nextCursor && <button type="button" onClick={() => void load(nextCursor)}>加载更多</button>}
    </div>
  )
}

function IncarnationRow({ incarnation, mainline, onSelect, selected }: {
  incarnation: WorkerIncarnation
  mainline: boolean
  selected: boolean
  onSelect: () => void
}) {
  const role = mainline ? '主线' : incarnation.forked_from !== undefined ? `临时侧问（来自 #${incarnation.forked_from}）` : '历史化身'
  return (
    <tr style={{ borderTop: '1px solid var(--border)', background: selected ? 'var(--bg-muted, #eef2ff)' : undefined }}>
      <td style={{ padding: '6px 12px' }}>
        <button type="button" onClick={onSelect} style={{ font: 'inherit', padding: 0, border: 0, background: 'transparent', textAlign: 'left', cursor: 'pointer' }}>
          #{incarnation.seq} · {role}
        </button>
      </td>
      <td style={{ padding: '6px 12px' }}>{IMPL_LABEL[incarnation.impl]}</td>
      <td style={{ padding: '6px 12px' }}>{INCARNATION_STATE_LABEL[incarnation.state] ?? incarnation.state}{incarnation.ended_reason ? ` · ${incarnation.ended_reason}` : ''}</td>
      <td style={{ padding: '6px 12px', fontSize: 12, color: 'var(--text-muted)' }}>
        {new Date(incarnation.started_at).toLocaleString()}
        {incarnation.ended_at ? ` → ${new Date(incarnation.ended_at).toLocaleString()}` : ' → 现在'}
      </td>
    </tr>
  )
}

const WorkerDetailContent: React.FC = () => {
  const { workerId = '' } = useParams()
  const [worker, setWorker] = useState<LedgerWorker | null>(null)
  const [selectedSeq, setSelectedSeq] = useState<number | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    agentObservabilityService
      .getWorkerDetail(workerId)
      .then((result) => {
        if (cancelled) return
        setWorker(result.worker)
        setSelectedSeq(mainlineIncarnation(result.worker.incarnations)?.seq)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [workerId])

  if (loading) return <Loading />
  if (error || !worker) return <div style={{ color: 'var(--text-muted)', padding: 24 }}>Worker 详情暂不可用：{error ?? 'not found'}</div>

  const mainline = mainlineIncarnation(worker.incarnations)
  const mainlineSeq = mainline?.seq
  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <Link to="/traces" style={{ color: 'var(--text-muted)', fontSize: 12 }}>← 返回 Workers</Link>
        <h2 style={{ fontSize: 18, margin: '8px 0 4px' }}>{worker.task.title}</h2>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>{worker.worker_id}</div>
      </div>
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', padding: '10px 0', marginBottom: 16, borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
        <div><strong>状态：</strong><span style={{ color: STATUS_COLOR[worker.task.status] }}>{STATUS_LABEL[worker.task.status]}</span>{worker.task.outcome ? ` · ${worker.task.outcome}` : ''}</div>
        <div><strong>主线实现：</strong>{mainline ? IMPL_LABEL[mainline.impl] : '—'}</div>
        {worker.task.type && <div><strong>任务类型：</strong>{worker.task.type}</div>}
        <div><strong>回报目标：</strong>{worker.report_to.channel_id} / {worker.report_to.session_id}</div>
      </div>
      <div style={{ fontSize: 13, marginBottom: 16, display: 'grid', gap: 4 }}>
        <div><strong>Owner：</strong><Link to={`/traces/managers/${encodeURIComponent(worker.manager_key)}`} style={{ fontFamily: 'var(--font-mono)' }}>{worker.manager_key}</Link></div>
        {mainline?.workspace && <div><strong>工作区：</strong><span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{mainline.workspace}</span></div>}
        <div>
          <strong>来源：</strong>{worker.origin.trigger_type}
          {worker.origin.spawned_by_episode && <> · episode <Link to={`/traces/managers/${encodeURIComponent(worker.manager_key)}`} style={{ fontFamily: 'var(--font-mono)' }}>{worker.origin.spawned_by_episode.slice(0, 8)}</Link></>}
        </div>
        {worker.legacy_source && (
          <div style={{ background: 'var(--warning-bg)', border: '1px solid var(--warning-border)', borderRadius: 6, padding: 10, margin: '8px 0', color: 'var(--warning-text)' }}>
            这是从旧版运行时导入的 legacy 记录，不代表当前可运行的 Worker 化身。
            {worker.legacy_source.trace_ids?.length ? ` 保留 ${worker.legacy_source.trace_ids.length} 条旧 trace 引用。` : ''}
          </div>
        )}
      </div>

      <h3 style={{ fontSize: 14, margin: '12px 0 8px' }}>化身链</h3>
      <div style={{ overflowX: 'auto', marginBottom: 20 }}>
        <table style={{ width: '100%', minWidth: 620, borderCollapse: 'collapse' }}>
          <thead><tr style={{ textAlign: 'left', color: 'var(--text-muted)', fontSize: 12 }}><th style={{ padding: '6px 12px' }}>化身</th><th style={{ padding: '6px 12px' }}>实现</th><th style={{ padding: '6px 12px' }}>状态</th><th style={{ padding: '6px 12px' }}>时间</th></tr></thead>
          <tbody>
            {worker.incarnations.map((incarnation) => (
              <IncarnationRow key={incarnation.seq} incarnation={incarnation} mainline={incarnation.seq === mainlineSeq} selected={incarnation.seq === selectedSeq} onSelect={() => setSelectedSeq(incarnation.seq)} />
            ))}
          </tbody>
        </table>
      </div>

      <h3 style={{ fontSize: 14, margin: '12px 0 8px' }}>活动记录（化身 #{selectedSeq ?? '—'}）</h3>
      <Timeline workerId={worker.worker_id} seq={selectedSeq} />

      <h3 style={{ fontSize: 14, margin: '20px 0 8px' }}>终端原始输出</h3>
      <OutputPanel workerId={worker.worker_id} seq={selectedSeq} />
    </div>
  )
}

/** 详情页也包 MainLayout（不丢侧边导航）。 */
export const WorkerDetail: React.FC = () => (
  <MainLayout>
    <WorkerDetailContent />
  </MainLayout>
)
