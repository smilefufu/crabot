import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loading } from '../../components/Common/Loading'
import { agentObservabilityService, type LedgerWorker, type WorkerTaskStatus } from '../../services/agent-observability'

// 键放宽为 string:历史 trace 数据可能携带旧状态值,缺键时回退原样显示
const STATUS_LABEL: Record<string, string> = {
  queued: '排队', running: '执行中', halted: '已停止待处置', closed: '已关闭', waiting_input: '等输入',
  completed: '已完成', failed: '失败', cancelled: '已取消',
}
const STATUS_COLOR: Record<string, string> = {
  queued: 'var(--text-muted)', running: 'var(--info)', halted: 'var(--warning)', closed: 'var(--text-muted)', waiting_input: 'var(--warning)',
  completed: 'var(--success)', failed: 'var(--error)', cancelled: 'var(--text-muted)',
}
const IMPLEMENTATION_LABEL: Record<string, string> = {
  builtin: '内置',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  legacy: '旧版',
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

function implementationLabel(worker: LedgerWorker): string {
  if (worker.legacy_source) return '旧版'
  const implementation = worker.incarnations.at(-1)?.impl
  return implementation ? IMPLEMENTATION_LABEL[implementation] ?? implementation : '—'
}

export const WorkersView: React.FC = () => {
  const [items, setItems] = useState<LedgerWorker[]>([])
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [counts, setCounts] = useState({ active: 0, terminal: 0, legacy: 0 })
  // 历史数据/旧下拉项仍可能携带旧状态值,过滤选择器放宽为 string
  const [status, setStatus] = useState<string>('')
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
      ...(includeTerminal || includeLegacy || status === 'closed' || status === 'completed' || status === 'failed' || status === 'cancelled'
        ? { include_terminal: true }  // closed 是唯一终态;旧终态键仅服务历史数据过滤
        : {}),
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
    <section className="trace-list" aria-label="执行器列表">
      <div className="trace-filters">
        <input
          className="trace-control trace-control--search"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setPage(1) }}
          placeholder="搜索任务标题"
          aria-label="标题搜索"
        />
        <select className="trace-control" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }} aria-label="状态过滤">
          {STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <input
          className="trace-control trace-control--manager"
          value={managerKey}
          onChange={(e) => { setManagerKey(e.target.value); setPage(1) }}
          placeholder="按会话标识过滤"
          aria-label="manager 过滤"
        />
        <label className="trace-toggle">
          <input type="checkbox" checked={includeTerminal} onChange={(e) => { setIncludeTerminal(e.target.checked); setPage(1) }} /> 显示终态历史
        </label>
        <label className="trace-toggle">
          <input type="checkbox" checked={includeLegacy} onChange={(e) => { setIncludeLegacy(e.target.checked); setPage(1) }} /> 显示旧记录
        </label>
      </div>
      <div className="trace-list__summary">
        正在执行 {counts.active} · 已结束 {counts.terminal} · 旧记录 {counts.legacy}
      </div>
      {loading ? <Loading /> : error ? (
        <div className="trace-list__empty">执行器列表暂不可用：{error}</div>
      ) : items.length === 0 ? (
        <div className="trace-list__empty">当前筛选下没有执行器。</div>
      ) : (
        <div className="trace-list__table-wrap">
          <table className="trace-table trace-table--workers">
          <thead>
            <tr>
              <th>任务</th>
              <th>状态</th>
              <th>实现</th>
              <th>所属会话</th>
              <th>更新时间</th>
            </tr>
          </thead>
          <tbody>
            {items.map((worker) => (
              <tr key={worker.worker_id}>
                <td className="trace-table__task">
                  <Link className="trace-table__primary-link" to={`/traces/workers/${encodeURIComponent(worker.worker_id)}`} title={worker.worker_id}>
                    {worker.task.title}
                  </Link>
                  <div className="trace-table__identifier">{worker.worker_id.slice(0, 12)}</div>
                </td>
                <td className="trace-table__status" style={{ color: STATUS_COLOR[worker.task.status] }}>
                  {STATUS_LABEL[worker.task.status]}
                </td>
                <td className="trace-table__implementation">{implementationLabel(worker)}</td>
                <td className="trace-table__manager">
                  <Link to={`/traces/managers/${encodeURIComponent(worker.manager_key)}`} title={worker.manager_key}>{worker.manager_key}</Link>
                </td>
                <td className="trace-table__updated" title={new Date(worker.updated_at).toLocaleString()}>
                  {relativeTime(worker.updated_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      <div className="trace-pagination" aria-label="执行器分页">
        <button disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
        <span>第 {page} / {totalPages} 页</span>
        <button disabled={page >= totalPages} onClick={() => setPage(page + 1)}>下一页</button>
      </div>
    </section>
  )
}
