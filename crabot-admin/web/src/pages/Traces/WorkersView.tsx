import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loading } from '../../components/Common/Loading'
import { agentObservabilityService, type LedgerWorker, type WorkerTaskStatus } from '../../services/agent-observability'

const STATUS_LABEL: Record<WorkerTaskStatus, string> = {
  queued: '排队', running: '执行中', waiting_input: '等输入',
  completed: '已完成', failed: '失败', cancelled: '已取消',
}
const STATUS_COLOR: Record<WorkerTaskStatus, string> = {
  queued: 'var(--text-muted)', running: 'var(--info)', waiting_input: 'var(--warning)',
  completed: 'var(--success)', failed: 'var(--error)', cancelled: 'var(--text-muted)',
}
const STATUS_OPTIONS: Array<{ value: '' | WorkerTaskStatus; label: string }> = [
  { value: '', label: '全部状态' },
  ...Object.entries(STATUS_LABEL).map(([value, label]) => ({ value: value as WorkerTaskStatus, label })),
]

function relativeTime(iso: string): string {
  const elapsed = Math.max(0, Date.now() - Date.parse(iso))
  if (elapsed < 60_000) return '刚刚'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)} 天前`
  return new Date(iso).toLocaleDateString()
}

export const WorkersView: React.FC = () => {
  const [items, setItems] = useState<LedgerWorker[]>([])
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [counts, setCounts] = useState({ active: 0, terminal: 0, legacy: 0 })
  const [status, setStatus] = useState<'' | WorkerTaskStatus>('')
  const [managerKey, setManagerKey] = useState('')
  const [query, setQuery] = useState('')
  const [includeTerminal, setIncludeTerminal] = useState(false)
  const [includeLegacy, setIncludeLegacy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    agentObservabilityService.listWorkers({
      ...(status ? { status } : {}),
      ...(managerKey ? { manager_key: managerKey } : {}),
      ...(query.trim() ? { q: query.trim() } : {}),
      ...(includeTerminal || includeLegacy ? { include_terminal: true } : {}),
      ...(includeLegacy ? { include_legacy: true } : {}),
      page,
      page_size: 20,
    }).then((result) => {
      if (cancelled) return
      setItems(result.items)
      setTotalPages(Math.max(1, result.pagination.total_pages))
      setCounts({ active: result.total_active, terminal: result.total_terminal, legacy: result.total_legacy })
    }).catch((err) => {
      if (cancelled) return
      setError(err instanceof Error ? err.message : String(err))
      setItems([])
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [page, status, managerKey, query, includeTerminal, includeLegacy])

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setPage(1) }}
          placeholder="按任务标题搜索"
          aria-label="标题搜索"
          style={{ fontSize: 12, padding: '5px 8px', minWidth: 220 }}
        />
        <select value={status} onChange={(e) => { setStatus(e.target.value as '' | WorkerTaskStatus); setPage(1) }} aria-label="状态过滤">
          {STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <input
          value={managerKey}
          onChange={(e) => { setManagerKey(e.target.value); setPage(1) }}
          placeholder="按会话 key 过滤"
          aria-label="manager 过滤"
          style={{ fontFamily: 'var(--font-mono)', fontSize: 12, padding: '5px 8px', minWidth: 220 }}
        />
        <label style={{ fontSize: 12 }}>
          <input type="checkbox" checked={includeTerminal} onChange={(e) => { setIncludeTerminal(e.target.checked); setPage(1) }} /> 显示终态历史
        </label>
        <label style={{ fontSize: 12 }}>
          <input type="checkbox" checked={includeLegacy} onChange={(e) => { setIncludeLegacy(e.target.checked); setPage(1) }} /> 显示 legacy
        </label>
      </div>
      <div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 8 }}>
        进行中 {counts.active} · 终态 {counts.terminal} · legacy {counts.legacy}
      </div>
      {loading ? <Loading /> : error ? (
        <div style={{ color: 'var(--text-muted)', padding: 24 }}>Worker 列表暂不可用：{error}</div>
      ) : items.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', padding: 24 }}>当前筛选下没有 worker。</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--text-muted)', fontSize: 12 }}>
              <th style={{ padding: '8px 12px' }}>任务</th>
              <th style={{ padding: '8px 12px' }}>状态</th>
              <th style={{ padding: '8px 12px' }}>实现</th>
              <th style={{ padding: '8px 12px' }}>Owner</th>
              <th style={{ padding: '8px 12px' }}>更新</th>
            </tr>
          </thead>
          <tbody>
            {items.map((worker) => (
              <tr key={worker.worker_id} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ padding: '9px 12px', maxWidth: 380 }}>
                  <Link to={`/traces/workers/${encodeURIComponent(worker.worker_id)}`} title={worker.worker_id} style={{ fontWeight: 600 }}>
                    {worker.task.title}
                  </Link>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{worker.worker_id.slice(0, 12)}</div>
                </td>
                <td style={{ padding: '9px 12px', color: STATUS_COLOR[worker.task.status] }}>{STATUS_LABEL[worker.task.status]}</td>
                <td style={{ padding: '9px 12px' }}>
                  {worker.legacy_source
                    ? <span title="不受支持的 legacy 记录">legacy</span>
                    : (worker.incarnations.at(-1)?.impl ?? <span title="无化身记录">—</span>)}
                </td>
                <td style={{ padding: '9px 12px' }}>
                  <Link to={`/traces/managers/${encodeURIComponent(worker.manager_key)}`} style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{worker.manager_key}</Link>
                </td>
                <td title={new Date(worker.updated_at).toLocaleString()} style={{ padding: '9px 12px', fontSize: 12, color: 'var(--text-muted)' }}>
                  {relativeTime(worker.updated_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
        <button disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{page} / {totalPages}</span>
        <button disabled={page >= totalPages} onClick={() => setPage(page + 1)}>下一页</button>
      </div>
    </div>
  )
}
