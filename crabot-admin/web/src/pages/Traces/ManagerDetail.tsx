import React, { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Loading } from '../../components/Common/Loading'
import { MainLayout } from '../../components/Layout/MainLayout'
import {
  agentObservabilityService,
  type ManagerEpisodeTrace,
  type ManagerEpisodeSpan,
} from '../../services/agent-observability'

const SPAN_STATUS_COLOR: Record<ManagerEpisodeSpan['status'], string> = {
  running: 'var(--warning)', completed: 'var(--success)', failed: 'var(--error)',
}

function SpanRow({ span }: { span: ManagerEpisodeSpan }) {
  return (
    <div style={{ display: 'flex', gap: 8, fontFamily: 'var(--font-mono)', fontSize: 12, padding: '2px 0' }}>
      <span style={{ color: SPAN_STATUS_COLOR[span.status] }}>●</span>
      <span style={{ minWidth: 120 }}>{span.type}</span>
      <span style={{ color: 'var(--text-muted)' }}>{span.duration_ms !== undefined ? `${span.duration_ms}ms` : '…'}</span>
      <span style={{ color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 560 }}>
        {span.details === undefined ? '' : JSON.stringify(span.details).slice(0, 200)}
      </span>
    </div>
  )
}

function displayTime(iso: string): string {
  const date = new Date(iso)
  const today = new Date()
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
    : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}

function triggerText(episode: ManagerEpisodeTrace): string {
  const summary = episode.trigger.summary
  const excerpt = summary.includes('：') ? summary.slice(summary.indexOf('：') + 1).replace(/（合并 \d+ 个唤醒）$/, '') : ''
  switch (episode.trigger.type) {
    case 'human_message': return excerpt ? `你：「${excerpt}」` : '你发来一条消息（历史记录无摘要）'
    case 'attention_flush': return excerpt ? `群聊消息：「${excerpt}」` : '群聊注意力放行'
    case 'schedule': return `⏰ ${summary.replace(/^定时任务:/, '')}`
    case 'worker_event': return episode.worker_ref?.title
      ? `「${episode.worker_ref.title}」进展${episode.worker_ref.state_to ? `：${workerStateLabel(episode.worker_ref.state_to)}` : ''}`
      : summary
    case 'sub_agent_call': return `子代理调用：${summary}`
  }
}

function workerStateLabel(status: string): string {
  const labels: Record<string, string> = {
    queued: '排队', running: '执行中', waiting_input: '等输入',
    completed: '已完成', failed: '失败', cancelled: '已取消',
  }
  return labels[status] ?? status
}

function TechnicalDetails({ episode }: { episode: ManagerEpisodeTrace }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ marginTop: 8 }}>
      <button className="button button--secondary" style={{ fontSize: 11, padding: '3px 8px' }} onClick={() => setOpen(!open)}>
        {open ? '收起技术详情' : '技术详情'}
      </button>
      {open && (
        <div style={{ marginTop: 8, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
          <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', fontSize: 11, marginBottom: 6 }}>
            trace {episode.trace_id} · {episode.duration_ms ?? '—'}ms · {episode.status}
          </div>
          {episode.outcome && <div style={{ fontSize: 12, marginBottom: 6 }}>Outcome: {episode.outcome.summary}{episode.outcome.error ? ` · ${episode.outcome.error}` : ''}</div>}
          {episode.total_usage && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
              tokens: in {episode.total_usage.input_tokens} / out {episode.total_usage.output_tokens}
              {episode.total_usage.cache_read_tokens ? ` / cache-read ${episode.total_usage.cache_read_tokens}` : ''}
            </div>
          )}
          {episode.spans.map((span) => <SpanRow key={span.span_id} span={span} />)}
        </div>
      )}
    </div>
  )
}

function WorkerProgress({ episode }: { episode: ManagerEpisodeTrace }) {
  return (
    <div style={{ padding: '7px 0 7px 28px', display: 'flex', gap: 10, borderTop: '1px solid var(--border)', fontSize: 12 }}>
      <span style={{ color: 'var(--text-muted)', minWidth: 50 }}>{displayTime(episode.started_at)}</span>
      <span>⤷ {triggerText(episode)}</span>
      {episode.status === 'failed' && <strong style={{ color: 'var(--error)' }}>失败</strong>}
      {episode.worker_ref && (
        <Link style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 11 }} to={`/traces/workers/${encodeURIComponent(episode.worker_ref.worker_id)}`}>
          查看 worker
        </Link>
      )}
    </div>
  )
}

function EpisodeCard({ episode, progress }: { episode: ManagerEpisodeTrace; progress: ManagerEpisodeTrace[] }) {
  const [showProgress, setShowProgress] = useState(false)
  return (
    <div style={{ border: `1px solid ${episode.status === 'failed' ? 'var(--error)' : 'var(--border)'}`, borderRadius: 8, padding: 12, marginBottom: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '64px minmax(0, 1fr)', gap: 8 }}>
        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{displayTime(episode.started_at)}</span>
        <div>
          <div style={{ fontWeight: 600 }}>{triggerText(episode)}</div>
          {episode.reply_excerpt && <div style={{ marginTop: 6, color: 'var(--text-secondary)' }}>→ 回复：{episode.reply_excerpt}</div>}
          {episode.actions?.map((action, index) => (
            <div key={`${action.kind}-${action.worker_id ?? index}`} style={{ marginTop: 4, color: 'var(--text-secondary)' }}>
              → {action.worker_id ? <Link to={`/traces/workers/${encodeURIComponent(action.worker_id)}`}>{action.label}</Link> : action.label}
            </div>
          ))}
          {episode.status === 'failed' && <div style={{ color: 'var(--error)', marginTop: 5 }}>失败：{episode.outcome?.error ?? episode.outcome?.summary ?? '未知原因'}</div>}
        </div>
      </div>
      {progress.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <button className="button button--secondary" style={{ fontSize: 11, padding: '3px 8px' }} onClick={() => setShowProgress(!showProgress)}>
            {showProgress ? '收起' : `展开 ${progress.length} 条 worker 进展`}
          </button>
          {showProgress && progress.map((child) => <WorkerProgress key={child.trace_id} episode={child} />)}
        </div>
      )}
      <TechnicalDetails episode={episode} />
    </div>
  )
}

function groupEpisodes(episodes: ManagerEpisodeTrace[]): Array<{ episode: ManagerEpisodeTrace; progress: ManagerEpisodeTrace[] }> {
  const nodes = new Map(episodes.map((episode) => [episode.trace_id, episode]))

  // Current page may contain only a late worker event; materialize its minimal parent context.
  for (const episode of episodes) {
    const parent = episode.causal_parent
    if (!parent || nodes.has(parent.trace_id)) continue
    nodes.set(parent.trace_id, {
      trace_id: parent.trace_id,
      manager_key: episode.manager_key,
      started_at: parent.started_at,
      status: parent.status,
      trigger: parent.trigger,
      spans: [],
      spawned_worker_ids: episode.worker_ref ? [episode.worker_ref.worker_id] : [],
      ...(parent.outcome ? { outcome: parent.outcome } : {}),
      ...(parent.reply_excerpt ? { reply_excerpt: parent.reply_excerpt } : {}),
      ...(parent.actions ? { actions: parent.actions } : {}),
    })
  }

  // Every episode (including worker_event) may spawn another worker. Build the full edge map first.
  const ownerByWorker = new Map<string, string>()
  for (const episode of nodes.values()) {
    for (const action of episode.actions ?? []) {
      if (action.kind === 'spawn_worker' && action.worker_id) ownerByWorker.set(action.worker_id, episode.trace_id)
    }
  }
  const parentOf = new Map<string, string>()
  for (const episode of nodes.values()) {
    if (episode.trigger.type !== 'worker_event' || !episode.worker_ref) continue
    const parentId = ownerByWorker.get(episode.worker_ref.worker_id) ?? episode.causal_parent?.trace_id
    if (parentId && parentId !== episode.trace_id && nodes.has(parentId)) parentOf.set(episode.trace_id, parentId)
  }

  const rootOf = (id: string): string => {
    const seen = new Set<string>()
    let current = id
    while (parentOf.has(current) && !seen.has(current)) {
      seen.add(current)
      current = parentOf.get(current)!
    }
    return current
  }

  const progressByRoot = new Map<string, ManagerEpisodeTrace[]>()
  for (const [id, episode] of nodes) {
    const root = rootOf(id)
    if (root === id) continue
    progressByRoot.set(root, [...(progressByRoot.get(root) ?? []), episode])
  }
  return Array.from(nodes.entries())
    .filter(([id]) => !parentOf.has(id))
    .map(([id, episode]) => ({
      episode,
      progress: (progressByRoot.get(id) ?? []).sort((a, b) => a.started_at.localeCompare(b.started_at)),
    }))
    .sort((a, b) => b.episode.started_at.localeCompare(a.episode.started_at))
}

const ManagerDetailContent: React.FC = () => {
  const { managerKey = '' } = useParams()
  const [episodes, setEpisodes] = useState<ManagerEpisodeTrace[]>([])
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const grouped = useMemo(() => groupEpisodes(episodes), [episodes])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    agentObservabilityService.listManagerEpisodes(managerKey, page, 20)
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
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [managerKey, page])

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Link to="/traces" style={{ color: 'var(--text-muted)', fontSize: 12 }}>← 返回会话列表</Link>
        <h2 style={{ fontFamily: 'var(--font-mono)', fontSize: 16, margin: '8px 0' }}>{managerKey}</h2>
      </div>
      {loading ? <Loading /> : error ? (
        <div style={{ color: 'var(--text-muted)', padding: 24 }}>运行记录暂不可用：{error}</div>
      ) : grouped.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', padding: 24 }}>该会话暂无运行记录。</div>
      ) : (
        <>
          {grouped.map(({ episode, progress }) => <EpisodeCard key={episode.trace_id} episode={episode} progress={progress} />)}
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

export const ManagerDetail: React.FC = () => <MainLayout><ManagerDetailContent /></MainLayout>
