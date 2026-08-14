/**
 * P6-A §10.2：Workers 列表视图（status/impl/manager 过滤 + 分页）。
 */
import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loading } from '../../components/Common/Loading'
import { agentObservabilityService, type LedgerWorker } from '../../services/agent-observability'

const STATUS_OPTIONS = ['', 'executing', 'waiting_human', 'completed', 'failed', 'cancelled'] as const

export const WorkersView: React.FC = () => {
  const [items, setItems] = useState<LedgerWorker[]>([])
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [status, setStatus] = useState('')
  const [managerKey, setManagerKey] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    agentObservabilityService
      .listWorkers({
        ...(status ? { status } : {}),
        ...(managerKey ? { manager_key: managerKey } : {}),
        page,
        page_size: 20,
      })
      .then((result) => {
        if (cancelled) return
        setItems(result.items)
        setTotalPages(Math.max(1, result.pagination.total_pages))
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setItems([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [page, status, managerKey])

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 12, alignItems: 'center' }}>
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }} aria-label="status 过滤">
          {STATUS_OPTIONS.map((option) => (
            <option key={option} value={option}>{option === '' ? '全部状态' : option}</option>
          ))}
        </select>
        <input
          value={managerKey}
          onChange={(e) => { setManagerKey(e.target.value); setPage(1) }}
          placeholder="manager_key 过滤"
          aria-label="manager 过滤"
          style={{ fontFamily: 'var(--font-mono)', fontSize: 12, padding: '4px 8px', minWidth: 260 }}
        />
      </div>
      {loading ? (
        <Loading />
      ) : error ? (
        <div style={{ color: 'var(--text-muted)', padding: 24 }}>Worker 列表暂不可用（unknown）：{error}</div>
      ) : items.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', padding: 24 }}>暂无 worker。</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--text-muted)', fontSize: 12 }}>
              <th style={{ padding: '8px 12px' }}>Worker</th>
              <th style={{ padding: '8px 12px' }}>标题</th>
              <th style={{ padding: '8px 12px' }}>状态</th>
              <th style={{ padding: '8px 12px' }}>Owner Manager</th>
              <th style={{ padding: '8px 12px' }}>实现</th>
              <th style={{ padding: '8px 12px' }}>更新</th>
            </tr>
          </thead>
          <tbody>
            {items.map((worker) => (
              <tr key={worker.worker_id} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ padding: '8px 12px' }}>
                  <Link to={`/traces/workers/${encodeURIComponent(worker.worker_id)}`} style={{ fontFamily: 'var(--font-mono)' }}>
                    {worker.worker_id.slice(0, 12)}
                  </Link>
                </td>
                <td style={{ padding: '8px 12px', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {worker.task.title}
                </td>
                <td style={{ padding: '8px 12px' }}>{worker.task.status}</td>
                <td style={{ padding: '8px 12px' }}>
                  <Link to={`/traces/managers/${encodeURIComponent(worker.manager_key)}`} style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                    {worker.manager_key}
                  </Link>
                </td>
                <td style={{ padding: '8px 12px' }}>{worker.incarnations[worker.incarnations.length - 1]?.impl ?? '—'}</td>
                <td style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text-muted)' }}>
                  {new Date(worker.updated_at).toLocaleString()}
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
