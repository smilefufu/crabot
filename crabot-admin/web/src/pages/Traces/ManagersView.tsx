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
    let inFlight = false
    let generation = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const isVisible = () => document.visibilityState !== 'hidden'
    setLoading(true)
    setError(null)
    setItems([])
    const refresh = async () => {
      if (cancelled || inFlight || !isVisible()) return
      inFlight = true
      const requestedGeneration = generation
      try {
        const result = await agentObservabilityService.listManagers(page, 20)
        if (cancelled || requestedGeneration !== generation) return
        setItems(result.items)
        setTotalPages(Math.max(1, result.pagination.total_pages))
        setError(null)
      } catch (err) {
        if (cancelled || requestedGeneration !== generation) return
        setError(err instanceof Error ? err.message : String(err))
        setItems(previous => previous.map(item => ({ ...item, execution_status: 'unknown' })))
      } finally {
        inFlight = false
        if (!cancelled) {
          if (requestedGeneration === generation) setLoading(false)
          if (isVisible()) {
            timer = setTimeout(() => { void refresh() }, requestedGeneration === generation ? 5_000 : 0)
          }
        }
      }
    }
    const onVisibilityChange = () => {
      clearTimeout(timer)
      generation++
      if (isVisible()) void refresh()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    void refresh()
    return () => {
      cancelled = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [page])

  if (loading) return <Loading />
  if (error && items.length === 0) {
    return <div className="trace-list__empty">会话列表暂不可用，请稍后重试。</div>
  }
  if (items.length === 0) {
    return <div className="trace-list__empty">暂无会话记录。</div>
  }

  return (
    <section className="trace-list" aria-label="会话列表">
      {error && <div className="trace-list__summary" role="status">执行状态刷新失败</div>}
      <div className="trace-list__table-wrap">
        <table className="trace-table trace-table--managers">
          <thead>
            <tr>
              <th>会话</th>
              <th>执行状态</th>
              <th>任务板</th>
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
                  <span className={`trace-execution-status is-${item.execution_status ?? 'unknown'}`}>
                    {item.execution_status === 'running' ? '执行中' : item.execution_status === 'idle' ? '当前无执行' : '暂不可用'}
                  </span>
                </td>
                <td className="trace-table__count">
                  <Link className="trace-table__workboard-link" to={`/traces/managers/${encodeURIComponent(item.manager_key)}/workboard`}>
                    {item.workboard.status === 'unknown'
                      ? '暂不可用'
                      : item.workboard.current_objective_count === 0
                        ? '空'
                        : <span className="trace-workboard-counts">
                            <span>{item.workboard.current_objective_count} 个目标</span>
                            <span>{item.workboard.current_work_item_count} 项</span>
                            {item.workboard.blocked_work_item_count > 0 && <span>{item.workboard.blocked_work_item_count} 项阻塞</span>}
                          </span>}
                  </Link>
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
