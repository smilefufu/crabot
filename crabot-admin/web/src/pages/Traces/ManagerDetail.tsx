import React, { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Loading } from '../../components/Common/Loading'
import { MainLayout } from '../../components/Layout/MainLayout'
import {
  agentObservabilityService,
  type LedgerWorker,
  type ManagerAdminSummary,
  type ManagerEpisodeSpan,
  type ManagerEpisodeTrace,
} from '../../services/agent-observability'
import './ManagerDetail.css'

type ViewMode = 'conversation' | 'technical'
type ManagerAction = NonNullable<ManagerEpisodeTrace['actions']>[number]
type RunningWorkers =
  | { status: 'loading' }
  | { status: 'ready'; items: LedgerWorker[] }
  | { status: 'unknown' }

const SPAN_STATUS_COLOR: Record<ManagerEpisodeSpan['status'], string> = {
  running: 'var(--warning)', completed: 'var(--success)', failed: 'var(--error)',
}

const TRIGGER_LABEL: Record<ManagerEpisodeTrace['trigger']['type'], string> = {
  human_message: '你发来消息',
  attention_flush: '群聊消息',
  schedule: '定时触发',
  worker_event: '执行器进展',
  sub_agent_call: '子代理调用',
}

function SpanRow({ span }: { span: ManagerEpisodeSpan }) {
  return (
    <div className="manager-detail__span-row">
      <span style={{ color: SPAN_STATUS_COLOR[span.status] }}>●</span>
      <span>{span.type}</span>
      <span>{span.duration_ms !== undefined ? `${span.duration_ms} 毫秒` : '进行中'}</span>
      <span>{span.details === undefined ? '' : JSON.stringify(span.details)}</span>
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

function channelLabel(managerKey: string): string {
  if (managerKey.startsWith('feishu-') || managerKey.startsWith('feishu::')) return '飞书'
  if (managerKey.startsWith('wechat-') || managerKey.startsWith('wechat::')) return '微信'
  return '会话'
}

function managerTitle(managerKey: string, summary?: ManagerAdminSummary): string {
  const displayName = summary?.display_name?.trim()
  return displayName && displayName !== managerKey ? displayName : `${channelLabel(managerKey)}会话`
}

function triggerText(episode: ManagerEpisodeTrace): string {
  const summary = episode.trigger.summary
  const excerpt = summary.includes('：') ? summary.slice(summary.indexOf('：') + 1).replace(/（合并 \d+ 个唤醒）$/, '') : ''
  switch (episode.trigger.type) {
    case 'human_message': return excerpt ? `你：「${excerpt}」` : '你发来一条消息（历史记录无摘要）'
    case 'attention_flush': return excerpt ? `群聊消息：「${excerpt}」` : '群聊注意力放行'
    case 'schedule': return `定时任务：${summary.replace(/^定时任务:/, '')}`
    case 'worker_event': return episode.worker_ref?.title
      ? `「${episode.worker_ref.title}」进展${episode.worker_ref.state_to ? `：${workerStateLabel(episode.worker_ref.state_to)}` : ''}`
      : summary
    case 'sub_agent_call': return `子代理调用：${summary}`
  }
}

function workerStateLabel(status: string): string {
  const labels: Record<string, string> = {
    queued: '排队', running: '执行中', waiting_input: '等待输入',
    completed: '已完成', failed: '失败', cancelled: '已取消',
  }
  return labels[status] ?? status
}

function episodeStatusLabel(status: ManagerEpisodeTrace['status']): string {
  return status === 'running' ? '执行中' : status === 'failed' ? '失败' : '已完成'
}

function TechnicalDetails({ episode }: { episode: ManagerEpisodeTrace }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="manager-detail__technical-details">
      <button className="manager-detail__technical-toggle" type="button" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? '收起技术详情' : '查看技术详情'}
      </button>
      {open && (
        <div className="manager-detail__technical-body">
          <div className="manager-detail__technical-meta">
            运行标识：{episode.trace_id} · 耗时：{episode.duration_ms === undefined ? '—' : `${episode.duration_ms} 毫秒`} · 状态：{episodeStatusLabel(episode.status)}
          </div>
          {episode.outcome && <div>处理结果：{episode.outcome.summary}{episode.outcome.error ? ` · ${episode.outcome.error}` : ''}</div>}
          {episode.total_usage && (
            <div>
              用量：输入 {episode.total_usage.input_tokens} / 输出 {episode.total_usage.output_tokens}
              {episode.total_usage.cache_read_tokens ? ` / 缓存读取 ${episode.total_usage.cache_read_tokens}` : ''}
            </div>
          )}
          {episode.spans.map((span) => <SpanRow key={span.span_id} span={span} />)}
        </div>
      )}
    </div>
  )
}

const ACTION_LABEL: Partial<Record<ManagerAction['kind'], string>> = {
  spawn_worker: '派给执行器',
  send_to_worker: '继续交给执行器',
  cancel_worker: '停止执行器',
}

function actionWorkerTitle(action: ManagerAction): string {
  return action.label.replace(/^[^：:]+[：:]\s*/, '').trim() || action.worker_id || action.label
}

function ActionList({ episode, runningWorkerIds }: { episode: ManagerEpisodeTrace; runningWorkerIds: ReadonlySet<string> }) {
  if (!episode.actions?.length) return null
  return (
    <div className="manager-detail__actions">
      {episode.actions.map((action, index) => (
        <div key={`${index}-${action.kind}-${action.worker_id ?? ''}`} className="manager-detail__action">
          {action.worker_id ? (
            <>
              <span className="manager-detail__action-kind">{ACTION_LABEL[action.kind] ?? action.label}</span>
              <Link to={`/traces/workers/${encodeURIComponent(action.worker_id)}`}>{actionWorkerTitle(action)}</Link>
              <Link className="manager-detail__action-worker-id" to={`/traces/workers/${encodeURIComponent(action.worker_id)}`}>{action.worker_id}</Link>
              {runningWorkerIds.has(action.worker_id) && <span className="manager-detail__action-current">当前：执行中</span>}
            </>
          ) : action.label}
        </div>
      ))}
    </div>
  )
}

interface WorkerProgressGroup {
  latest: ManagerEpisodeTrace
  messageHistory: ManagerEpisodeTrace[]
  history: ManagerEpisodeTrace[]
}

function groupWorkerProgress(progress: ManagerEpisodeTrace[]): WorkerProgressGroup[] {
  const byWorker = new Map<string, Pick<WorkerProgressGroup, 'latest' | 'history'>>()
  for (const episode of progress) {
    const key = episode.worker_ref?.worker_id ?? episode.trace_id
    const existing = byWorker.get(key)
    if (existing) {
      existing.history.push(existing.latest)
      existing.latest = episode
    } else {
      byWorker.set(key, { latest: episode, history: [] })
    }
  }
  return Array.from(byWorker.values()).map(({ latest, history }) => ({
    latest,
    messageHistory: history.filter((episode) => episode.reply_excerpt),
    history: history.filter((episode) => !episode.reply_excerpt),
  }))
}

function WorkerProgressEntry({ episode, runningWorkerIds }: { episode: ManagerEpisodeTrace; runningWorkerIds: ReadonlySet<string> }) {
  const state = episode.worker_ref?.state_to ?? episode.status
  const title = episode.worker_ref?.title ?? triggerText(episode)
  const tone = state === 'failed' || episode.status === 'failed' ? ' is-failed' : state === 'cancelled' ? ' is-cancelled' : ''
  return (
    <div className={`manager-detail__worker-progress${tone}`}>
      <div className="manager-detail__worker-progress-row">
        <span className="manager-detail__worker-state">{workerStateLabel(state)}</span>
        <span className="manager-detail__worker-title">{title}</span>
        {episode.worker_ref && (
          <Link to={`/traces/workers/${encodeURIComponent(episode.worker_ref.worker_id)}`}>查看执行器</Link>
        )}
      </div>
      {episode.reply_excerpt && (
        <div className="manager-detail__worker-message-meta">
          <time dateTime={episode.started_at}>{displayTime(episode.started_at)}</time>
          <span>已发送消息</span>
        </div>
      )}
      {episode.reply_excerpt && <div className="manager-detail__worker-reply">管理会话回复：{episode.reply_excerpt}</div>}
      <ActionList episode={episode} runningWorkerIds={runningWorkerIds} />
      {episode.status === 'failed' && <div className="manager-detail__failure">失败原因：{episode.outcome?.error ?? episode.outcome?.summary ?? '未知原因'}</div>}
      <TechnicalDetails episode={episode} />
    </div>
  )
}

function WorkerProgress({ progress, runningWorkerIds }: { progress: WorkerProgressGroup; runningWorkerIds: ReadonlySet<string> }) {
  const [historyOpen, setHistoryOpen] = useState(false)
  return (
    <div className="manager-detail__worker-progress-group">
      {progress.messageHistory.map((message) => (
        <WorkerProgressEntry key={message.trace_id} episode={message} runningWorkerIds={runningWorkerIds} />
      ))}
      <WorkerProgressEntry episode={progress.latest} runningWorkerIds={runningWorkerIds} />
      {progress.history.length > 0 && (
        <>
          <button
            className="manager-detail__worker-history-toggle"
            type="button"
            onClick={() => setHistoryOpen(!historyOpen)}
            aria-expanded={historyOpen}
          >
            {historyOpen ? `收起 ${progress.history.length} 次历史进展` : `展开 ${progress.history.length} 次历史进展`}
          </button>
          {historyOpen && (
            <div className="manager-detail__worker-history">
              {progress.history.map((history) => (
                <WorkerProgressEntry key={history.trace_id} episode={history} runningWorkerIds={runningWorkerIds} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function EpisodeEntry({ episode, progress, runningWorkerIds }: { episode: ManagerEpisodeTrace; progress: ManagerEpisodeTrace[]; runningWorkerIds: ReadonlySet<string> }) {
  const tone = episode.status === 'failed' ? ' is-failed' : episode.trigger.type === 'worker_event' ? ' is-worker' : ''
  const workerProgress = groupWorkerProgress(progress)
  return (
    <article className={`manager-detail__event${tone}`}>
      <time className="manager-detail__event-time">{displayTime(episode.started_at)}</time>
      <div className="manager-detail__event-body">
        <div className="manager-detail__event-header">
          <span>{TRIGGER_LABEL[episode.trigger.type]}</span>
          <TechnicalDetails episode={episode} />
        </div>
        <div className="manager-detail__event-title">{triggerText(episode)}</div>
        {episode.reply_excerpt && <div className="manager-detail__reply"><strong>管理会话回复</strong>：{episode.reply_excerpt}</div>}
        <ActionList episode={episode} runningWorkerIds={runningWorkerIds} />
        {episode.status === 'failed' && <div className="manager-detail__failure">失败原因：{episode.outcome?.error ?? episode.outcome?.summary ?? '未知原因'}</div>}
        {workerProgress.length > 0 && (
          <div className="manager-detail__worker-chain">
            {workerProgress.map((child) => <WorkerProgress key={child.latest.worker_ref?.worker_id ?? child.latest.trace_id} progress={child} runningWorkerIds={runningWorkerIds} />)}
          </div>
        )}
      </div>
    </article>
  )
}

function TechnicalEventList({ episodes }: { episodes: ManagerEpisodeTrace[] }) {
  return (
    <div className="manager-detail__technical-list" role="tabpanel" aria-label="技术事件">
      {episodes.map((episode) => (
        <article className="manager-detail__technical-event" key={episode.trace_id}>
          <time>{displayTime(episode.started_at)}</time>
          <div>
            <div className="manager-detail__technical-event-header">
              <span>{TRIGGER_LABEL[episode.trigger.type]}</span>
              <span>{episodeStatusLabel(episode.status)}</span>
            </div>
            <TechnicalDetails episode={episode} />
          </div>
        </article>
      ))}
    </div>
  )
}

function Pagination({ page, totalPages, onPageChange }: { page: number; totalPages: number; onPageChange: (page: number) => void }) {
  return (
    <div className="manager-detail__pagination">
      <button disabled={page <= 1} onClick={() => onPageChange(page - 1)}>上一页</button>
      <span>第 {page} / {totalPages} 页</span>
      <button disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>下一页</button>
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

async function listRunningWorkers(managerKey: string): Promise<LedgerWorker[]> {
  const items: LedgerWorker[] = []
  let page = 1

  while (true) {
    const result = await agentObservabilityService.listWorkers({
      manager_key: managerKey,
      status: 'running',
      page,
      page_size: 100,
    })
    items.push(...result.items)
    if (page >= result.pagination.total_pages) return items
    page += 1
  }
}

const ManagerDetailContent: React.FC = () => {
  const { managerKey = '' } = useParams()
  const [episodes, setEpisodes] = useState<ManagerEpisodeTrace[]>([])
  const [manager, setManager] = useState<ManagerAdminSummary | undefined>()
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<ViewMode>('conversation')
  const [runningWorkers, setRunningWorkers] = useState<RunningWorkers>({ status: 'loading' })
  const grouped = useMemo(() => groupEpisodes(episodes), [episodes])
  const runningWorkerIds = useMemo(
    () => new Set(runningWorkers.status === 'ready' ? runningWorkers.items.map((worker) => worker.worker_id) : []),
    [runningWorkers],
  )

  useEffect(() => {
    let cancelled = false
    agentObservabilityService.listManagers(1, 100)
      .then((result) => {
        if (!cancelled) setManager(result.items.find((item) => item.manager_key === managerKey))
      })
      .catch(() => {
        if (!cancelled) setManager(undefined)
      })
    return () => { cancelled = true }
  }, [managerKey])

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

  useEffect(() => {
    let cancelled = false
    setRunningWorkers({ status: 'loading' })
    listRunningWorkers(managerKey)
      .then((items) => {
        if (!cancelled) setRunningWorkers({ status: 'ready', items })
      })
      .catch(() => {
        if (!cancelled) setRunningWorkers({ status: 'unknown' })
      })
    return () => { cancelled = true }
  }, [managerKey])

  return (
    <div className="manager-detail">
      <header className="manager-detail__heading">
        <div>
          <Link to="/traces" className="manager-detail__back">返回会话列表</Link>
          <h1>{managerTitle(managerKey, manager)}</h1>
          <div className="manager-detail__session-id">会话标识：{managerKey}</div>
        </div>
        {manager?.last_activity_at && <div className="manager-detail__last-activity">最近活动：{displayTime(manager.last_activity_at)}</div>}
      </header>
      {loading ? <Loading /> : error ? (
        <div className="manager-detail__empty">运行记录暂不可用：{error}</div>
      ) : grouped.length === 0 ? (
        <div className="manager-detail__empty">该会话暂无运行记录。</div>
      ) : (
        <>
          <div className="manager-detail__tabs" role="tablist" aria-label="会话视图">
            <button className={view === 'conversation' ? 'is-active' : ''} type="button" role="tab" aria-selected={view === 'conversation'} onClick={() => setView('conversation')}>对话与操作</button>
            <button className={view === 'technical' ? 'is-active' : ''} type="button" role="tab" aria-selected={view === 'technical'} onClick={() => setView('technical')}>技术事件</button>
          </div>
          {view === 'conversation' ? (
            <div className="manager-detail__content-grid" role="tabpanel" aria-label="对话与操作">
              <section>
                <div className="manager-detail__stream-heading"><strong>活动记录</strong><span>按会话因果关系归并</span></div>
                <div className="manager-detail__event-list">
                  {grouped.map(({ episode, progress }) => <EpisodeEntry key={episode.trace_id} episode={episode} progress={progress} runningWorkerIds={runningWorkerIds} />)}
                </div>
                <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
              </section>
              <aside className="manager-detail__summary" aria-label="会话摘要">
                <section>
                  <h2>会话</h2>
                  <div className="manager-detail__summary-name">{managerTitle(managerKey, manager)}</div>
                  <div>{channelLabel(managerKey)} · 会话记录</div>
                </section>
                <section>
                  <h2>当前状态</h2>
                  <dl>
                    {manager && <div><dt>未结束</dt><dd>{manager.active_worker_count > 0 ? `${manager.active_worker_count} 个` : '—'}</dd></div>}
                    <div><dt>本页记录</dt><dd>{episodes.length} 条</dd></div>
                    <div><dt>当前页</dt><dd>{page} / {totalPages}</dd></div>
                  </dl>
                </section>
                <section>
                  <h2>正在执行</h2>
                  {runningWorkers.status === 'loading' && <div className="manager-detail__running-state">读取中…</div>}
                  {runningWorkers.status === 'unknown' && <div className="manager-detail__running-state is-unknown">暂不可用（unknown）</div>}
                  {runningWorkers.status === 'ready' && (runningWorkers.items.length > 0 ? (
                    <div className="manager-detail__running-list">
                      {runningWorkers.items.map((worker) => (
                        <div key={worker.worker_id} className="manager-detail__running-worker">
                          <span>执行中</span>
                          <Link to={`/traces/workers/${encodeURIComponent(worker.worker_id)}`}>{worker.task.title}</Link>
                          <code>{worker.worker_id}</code>
                        </div>
                      ))}
                    </div>
                  ) : <div className="manager-detail__running-state">无</div>)}
                  <div className="manager-detail__running-note">仅展示此刻状态为执行中的执行器；未结束包含排队与等待输入。</div>
                </section>
              </aside>
            </div>
          ) : (
            <>
              <TechnicalEventList episodes={episodes} />
              <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
            </>
          )}
        </>
      )}
    </div>
  )
}

export const ManagerDetail: React.FC = () => <MainLayout><ManagerDetailContent /></MainLayout>
