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
    return <div className="trace-list__empty">会话列表暂不可用（unknown）：{error}</div>
  }
  if (items.length === 0) {
    return <div className="trace-list__empty">暂无会话记录。</div>
  }

  return (
    <section className="trace-list" aria-label="会话列表">
      <div className="trace-list__table-wrap">
        <table className="trace-table trace-table--managers">
          <thead>
            <tr>
              <th>会话</th>
              <th>在办</th>
              <th>最近动态</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.manager_key}>
                <td>
                  <Link className="trace-table__primary-link" to={`/traces/managers/${encodeURIComponent(item.manager_key)}`}>
                    {item.display_name || item.manager_key}
                  </Link>
                  <div className="trace-table__identifier" title={item.manager_key}>
                    {item.manager_key}
                  </div>
                </td>
                <td className="trace-table__count">
                  <span className={item.active_worker_count > 0 ? 'trace-count is-active' : 'trace-count'}>
                    {item.active_worker_count > 0 ? `${item.active_worker_count} 个` : '—'}
                  </span>
                </td>
                <td className="trace-table__activity-cell">
                  <div className={item.recent_activity_summary ? 'trace-table__activity' : 'trace-table__activity is-empty'}>{item.recent_activity_summary || '暂无活动摘要'}</div>
                  <time title={item.last_activity_at ? new Date(item.last_activity_at).toLocaleString() : undefined} className="trace-table__time">
                    {item.last_activity_at ? relativeTime(item.last_activity_at) : '—'}
                  </time>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="trace-pagination" aria-label="会话分页">
        <button disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
        <span>第 {page} / {totalPages} 页</span>
        <button disabled={page >= totalPages} onClick={() => setPage(page + 1)}>下一页</button>
      </div>
    </section>
  )
}
