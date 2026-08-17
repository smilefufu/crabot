/**
 * P6-A §10.4：Worker 详情 —— owner/report_to/origin/workspace、化身链、
 * composite timeline（opaque cursor 增量）、terminal output（offset cursor）。
 * INVALID_PARAMS（cursor 失效/GC/化身变化）显式提示重载，不静默拼接重复数据。
 */
import React, { useCallback, useEffect, useState } from 'react'
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

const SOURCE_LABEL: Record<string, string> = { harness: 'harness', native: 'native', legacy: 'legacy' }
const KIND_LABEL: Record<WorkerTraceEvent['kind'], string> = {
  message: '消息', tool_call: '工具调用', tool_result: '结果', thinking: '思考', lifecycle: '生命周期',
}
const STATUS_LABEL: Record<WorkerTaskStatus, string> = {
  queued: '排队', running: '执行中', waiting_input: '等输入',
  completed: '已完成', failed: '失败', cancelled: '已取消',
}
const STATUS_COLOR: Record<WorkerTaskStatus, string> = {
  queued: 'var(--text-muted)', running: 'var(--info)', waiting_input: 'var(--warning)',
  completed: 'var(--success)', failed: 'var(--error)', cancelled: 'var(--text-muted)',
}

function TimelineEvent({ event }: { event: WorkerTraceEvent }) {
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 12, padding: '3px 0', fontFamily: 'var(--font-mono)' }}>
      <span style={{ color: 'var(--text-muted)', minWidth: 64 }}>{event.ts ? new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false }) : ''}</span>
      <span style={{ color: 'var(--text-muted)', minWidth: 56 }}>{event.source ? SOURCE_LABEL[event.source] ?? event.source : ''}</span>
      <span style={{ color: 'var(--text-muted)', minWidth: 88 }}>{KIND_LABEL[event.kind]}</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{event.summary}</span>
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
    setCursorInvalid(false)
    setError(null)
    void load(undefined)
  }, [load])

  if (error) return <div style={{ color: 'var(--text-muted)', padding: 12 }}>时间线暂不可用：{error}</div>

  return (
    <div>
      {unavailableReason && (
        <div style={{ fontSize: 12, color: 'var(--color-warning, #d97706)', padding: '4px 0' }}>{unavailableReason}</div>
      )}
      {events.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', padding: 12 }}>该化身暂无事件。</div>
      ) : (
        events.map((event, index) => <TimelineEvent key={index} event={event} />)
      )}
      {cursorInvalid && (
        <div style={{ fontSize: 12, color: 'var(--color-warning, #d97706)', padding: '8px 0' }}>
          游标已失效。
          <button onClick={() => { setCursorInvalid(false); setEvents([]); void load(undefined) }} style={{ marginLeft: 8 }}>
            从头重新加载
          </button>
        </div>
      )}
      {!cursorInvalid && hasMore && nextCursor && (
        <button onClick={() => void load(nextCursor)} style={{ marginTop: 8 }}>
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
      <pre style={{ background: 'var(--bg-muted, #f6f6f6)', padding: 12, borderRadius: 8, maxHeight: 320, overflow: 'auto', fontSize: 12 }}>
        {chunk || '（无输出）'}
      </pre>
      {cursorInvalid && (
        <div style={{ fontSize: 12, color: 'var(--color-warning, #d97706)' }}>
          游标已失效。
          <button onClick={() => { setCursorInvalid(false); setChunk(''); void load(undefined) }} style={{ marginLeft: 8 }}>从头重新加载</button>
        </div>
      )}
      {!cursorInvalid && hasMore && nextCursor && (
        <button onClick={() => void load(nextCursor)}>加载更多</button>
      )}
    </div>
  )
}

function IncarnationRow({ incarnation, current, onSelect, selected }: {
  incarnation: WorkerIncarnation
  current: boolean
  selected: boolean
  onSelect: () => void
}) {
  return (
    <tr
      onClick={onSelect}
      style={{ borderTop: '1px solid var(--border)', cursor: 'pointer', background: selected ? 'var(--bg-muted, #eef2ff)' : undefined }}
    >
      <td style={{ padding: '6px 12px' }}>#{incarnation.seq}{current ? '（主线）' : ''}{incarnation.forked_from ? ` fork←#${incarnation.forked_from}` : ''}</td>
      <td style={{ padding: '6px 12px' }}>{incarnation.impl}</td>
      <td style={{ padding: '6px 12px' }}>{incarnation.state}{incarnation.ended_reason ? ` · ${incarnation.ended_reason}` : ''}</td>
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
        const mainline = result.worker.incarnations[result.worker.incarnations.length - 1]
        setSelectedSeq(mainline?.seq)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [workerId])

  if (loading) return <Loading />
  if (error || !worker) {
    return <div style={{ color: 'var(--text-muted)', padding: 24 }}>Worker 详情暂不可用（unknown）：{error ?? 'not found'}</div>
  }

  const mainlineSeq = worker.incarnations[worker.incarnations.length - 1]?.seq
  const mainline = worker.incarnations[worker.incarnations.length - 1]

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Link to="/traces" style={{ color: 'var(--text-muted)', fontSize: 12 }}>← 返回 Workers</Link>
        <h2 style={{ fontFamily: 'var(--font-mono)', fontSize: 16, margin: '8px 0' }}>{worker.worker_id}</h2>
      </div>
      <div style={{ fontSize: 13, marginBottom: 16, display: 'grid', gap: 4 }}>
        <div><strong>标题：</strong>{worker.task.title}</div>
        <div><strong>状态：</strong><span style={{ color: STATUS_COLOR[worker.task.status] }}>{STATUS_LABEL[worker.task.status]}</span>{worker.task.outcome ? ` · ${worker.task.outcome}` : ''}</div>
        <div>
          <strong>Owner：</strong>
          <Link to={`/traces/managers/${encodeURIComponent(worker.manager_key)}`} style={{ fontFamily: 'var(--font-mono)' }}>{worker.manager_key}</Link>
        </div>
        <div><strong>回报目标：</strong>{worker.report_to.channel_id} / {worker.report_to.session_id}</div>
        {mainline?.workspace && (
          <div><strong>工作区：</strong><span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{mainline.workspace}</span></div>
        )}
        <div>
          <strong>来源：</strong>
          {worker.origin.trigger_type}
          {worker.origin.spawned_by_episode ? (
            <>
              {' · episode '}
              <Link to={`/traces/managers/${encodeURIComponent(worker.manager_key)}`} style={{ fontFamily: 'var(--font-mono)' }}>
                {worker.origin.spawned_by_episode.slice(0, 8)}
              </Link>
            </>
          ) : null}
        </div>
        {worker.legacy_source && (
          <div style={{ background: 'var(--warning-bg)', border: '1px solid var(--warning-border)', borderRadius: 6, padding: 10, margin: '8px 0', color: 'var(--warning-text)' }}>
            这是从旧版运行时导入的 legacy 记录，不代表当前可运行的 Worker 化身。
            {worker.legacy_source.trace_ids?.length ? ` 保留 ${worker.legacy_source.trace_ids.length} 条旧 trace 引用。` : ''}
          </div>
        )}
      </div>

      <h3 style={{ fontSize: 14, margin: '12px 0 8px' }}>化身链</h3>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 16 }}>
        <tbody>
          {worker.incarnations.map((incarnation) => (
            <IncarnationRow
              key={incarnation.seq}
              incarnation={incarnation}
              current={incarnation.seq === mainlineSeq && incarnation.impl === worker.incarnations[worker.incarnations.length - 1]?.impl}
              selected={incarnation.seq === selectedSeq}
              onSelect={() => setSelectedSeq(incarnation.seq)}
            />
          ))}
        </tbody>
      </table>

      <h3 style={{ fontSize: 14, margin: '12px 0 8px' }}>时间线（化身 #{selectedSeq ?? '—'}）</h3>
      <Timeline workerId={worker.worker_id} seq={selectedSeq} />

      <h3 style={{ fontSize: 14, margin: '16px 0 8px' }}>终端输出</h3>
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
