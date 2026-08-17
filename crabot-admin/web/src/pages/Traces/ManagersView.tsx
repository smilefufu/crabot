/**
 * P6-A §10.2：Managers 列表视图。
 * disk 持久 keys ∪ TraceStore keys 的去重 union，固定 last_activity_at desc 排序（服务端）。
 * Agent 不可达显示 unknown（不缓存旧数据冒充实时事实）。
 */
import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loading } from '../../components/Common/Loading'
import { agentObservabilityService, type ManagerAdminSummary } from '../../services/agent-observability'

function relativeTime(iso: string): string {
  const elapsed = Math.max(0, Date.now() - Date.parse(iso))
  const minute = 60_000
  if (elapsed < minute) return '刚刚'
  if (elapsed < 60 * minute) return `${Math.floor(elapsed / minute)} 分钟前`
  if (elapsed < 24 * 60 * minute) return `${Math.floor(elapsed / (60 * minute))} 小时前`
  if (elapsed < 7 * 24 * 60 * minute) return `${Math.floor(elapsed / (24 * 60 * minute))} 天前`
  return new Date(iso).toLocaleDateString()
}

export const ManagersView: React.FC = () => {
  const [items, setItems] = useState<ManagerAdminSummary[]>([])
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    agentObservabilityService
      .listManagers(page, 20)
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
  }, [page])

  if (loading) return <Loading />
  if (error) {
    return <div style={{ color: 'var(--text-muted)', padding: 24 }}>Manager 列表暂不可用（unknown）：{error}</div>
  }
  if (items.length === 0) {
    return <div style={{ color: 'var(--text-muted)', padding: 24 }}>暂无 Manager（尚无唤醒记录）。</div>
  }

  return (
    <div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--text-muted)', fontSize: 12 }}>
            <th style={{ padding: '8px 12px' }}>会话</th>
            <th style={{ padding: '8px 12px', width: 100 }}>进行中</th>
            <th style={{ padding: '8px 12px' }}>最近活动</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.manager_key} style={{ borderTop: '1px solid var(--border)' }}>
              <td style={{ padding: '10px 12px' }}>
                <Link to={`/traces/managers/${encodeURIComponent(item.manager_key)}`} style={{ fontWeight: 600 }}>
                  {item.display_name || item.manager_key}
                </Link>
                <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', fontSize: 11, marginTop: 3 }}>
                  {item.manager_key}
                </div>
              </td>
              <td style={{ padding: '10px 12px' }}>
                {item.active_worker_count > 0 ? `${item.active_worker_count} 个` : '—'}
              </td>
              <td style={{ padding: '10px 12px' }}>
                <div>{item.recent_activity_summary || '暂无活动摘要'}</div>
                <div
                  title={item.last_activity_at ? new Date(item.last_activity_at).toLocaleString() : undefined}
                  style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 3 }}
                >
                  {item.last_activity_at ? relativeTime(item.last_activity_at) : '—'}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
        <button disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{page} / {totalPages}</span>
        <button disabled={page >= totalPages} onClick={() => setPage(page + 1)}>下一页</button>
      </div>
    </div>
  )
}
