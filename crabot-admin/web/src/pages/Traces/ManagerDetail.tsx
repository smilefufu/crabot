/**
 * P6-A §10.3：Manager 详情 —— episode 列表 + span 展开 + spawned worker 双向链接。
 */
import React, { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Loading } from '../../components/Common/Loading'
import {
  agentObservabilityService,
  type ManagerEpisodeTrace,
  type ManagerEpisodeSpan,
} from '../../services/agent-observability'

const TRIGGER_LABELS: Record<ManagerEpisodeTrace['trigger']['type'], string> = {
  human_message: '人类消息',
  worker_event: 'worker 事件',
  schedule: '定时任务',
  attention_flush: '注意力放行',
  sub_agent_call: '子代理调用',
}

const SPAN_STATUS_COLOR: Record<ManagerEpisodeSpan['status'], string> = {
  running: 'var(--color-warning, #d97706)',
  completed: 'var(--color-success, #16a34a)',
  failed: 'var(--color-danger, #dc2626)',
}

function SpanRow({ span }: { span: ManagerEpisodeSpan }) {
  return (
    <div style={{ display: 'flex', gap: 8, fontFamily: 'var(--font-mono)', fontSize: 12, padding: '2px 0' }}>
      <span style={{ color: SPAN_STATUS_COLOR[span.status] }}>●</span>
      <span style={{ minWidth: 120 }}>{span.type}</span>
      <span style={{ color: 'var(--text-muted)' }}>
        {span.duration_ms !== undefined ? `${span.duration_ms}ms` : '…'}
      </span>
      <span style={{ color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 480 }}>
        {span.details === undefined ? '' : JSON.stringify(span.details).slice(0, 160)}
      </span>
    </div>
  )
}

function EpisodeCard({ episode }: { episode: ManagerEpisodeTrace }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', cursor: 'pointer' }} onClick={() => setExpanded(!expanded)}>
        <span style={{ color: episode.status === 'failed' ? 'var(--color-danger, #dc2626)' : episode.status === 'running' ? 'var(--color-warning, #d97706)' : 'var(--color-success, #16a34a)' }}>
          {episode.status}
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{episode.trace_id.slice(0, 8)}</span>
        <span>{TRIGGER_LABELS[episode.trigger.type]}</span>
        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{episode.trigger.summary}</span>
        <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 12 }}>
          {new Date(episode.started_at).toLocaleString()}
          {episode.duration_ms !== undefined ? ` · ${episode.duration_ms}ms` : ''}
        </span>
      </div>
      {expanded && (
        <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
          {episode.outcome && (
            <div style={{ fontSize: 12, marginBottom: 8 }}>
              <strong>Outcome:</strong> {episode.outcome.summary}
              {episode.outcome.error && <span style={{ color: 'var(--color-danger, #dc2626)' }}> · {episode.outcome.error}</span>}
            </div>
          )}
          {episode.total_usage && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
              tokens: in {episode.total_usage.input_tokens} / out {episode.total_usage.output_tokens}
              {episode.total_usage.cache_read_tokens ? ` / cache-read ${episode.total_usage.cache_read_tokens}` : ''}
            </div>
          )}
          {episode.spawned_worker_ids.length > 0 && (
            <div style={{ fontSize: 12, marginBottom: 8 }}>
              <strong>Spawned workers:</strong>{' '}
              {episode.spawned_worker_ids.map((workerId) => (
                <Link key={workerId} to={`/traces/workers/${encodeURIComponent(workerId)}`} style={{ fontFamily: 'var(--font-mono)', marginRight: 8 }}>
                  {workerId.slice(0, 12)}
                </Link>
              ))}
            </div>
          )}
          <div>
            {episode.spans.map((span) => (
              <SpanRow key={span.span_id} span={span} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export const ManagerDetail: React.FC = () => {
  const { managerKey = '' } = useParams()
  const [episodes, setEpisodes] = useState<ManagerEpisodeTrace[]>([])
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    agentObservabilityService
      .listManagerEpisodes(managerKey, page, 20)
      .then((result) => {
        if (cancelled) return
        setEpisodes(result.items)
        setTotalPages(Math.max(1, result.pagination.total_pages))
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setEpisodes([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [managerKey, page])

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Link to="/traces" style={{ color: 'var(--text-muted)', fontSize: 12 }}>← 返回 Managers</Link>
        <h2 style={{ fontFamily: 'var(--font-mono)', fontSize: 16, margin: '8px 0' }}>{managerKey}</h2>
      </div>
      {loading ? (
        <Loading />
      ) : error ? (
        <div style={{ color: 'var(--text-muted)', padding: 24 }}>Episodes 暂不可用：{error}</div>
      ) : episodes.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', padding: 24 }}>该 Manager 暂无 episode。</div>
      ) : (
        <>
          {episodes.map((episode) => (
            <EpisodeCard key={episode.trace_id} episode={episode} />
          ))}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{page} / {totalPages}</span>
            <button disabled={page >= totalPages} onClick={() => setPage(page + 1)}>下一页</button>
          </div>
        </>
      )}
    </div>
  )
}
