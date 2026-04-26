import React, { useCallback, useEffect, useState } from 'react'
import { memoryV2Service, type ObservationPendingItem } from '../../../../services/memoryV2'

const TYPE_LABEL: Record<string, string> = { fact: '事实', lesson: '经验', concept: '概念' }

function daysLeft(promotedAt: string, windowDays: number, now: Date = new Date()): number {
  const start = new Date(promotedAt).getTime()
  if (Number.isNaN(start)) return windowDays
  const elapsedDays = Math.floor((now.getTime() - start) / (24 * 60 * 60 * 1000))
  return Math.max(0, windowDays - elapsedDays)
}

export const ObservationPendingPanel: React.FC = () => {
  const [items, setItems] = useState<ObservationPendingItem[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const r = await memoryV2Service.getObservationPending()
      setItems(r.items ?? [])
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  async function markPass(id: string) {
    setBusyId(id)
    try { await memoryV2Service.markObservationPass(id); await refresh() }
    finally { setBusyId(null) }
  }

  async function extend(id: string) {
    setBusyId(id)
    try { await memoryV2Service.extendObservationWindow(id); await refresh() }
    finally { setBusyId(null) }
  }

  async function drop(id: string) {
    if (!confirm('确认删除？将进入回收站。')) return
    setBusyId(id)
    try { await memoryV2Service.deleteEntry(id); await refresh() }
    finally { setBusyId(null) }
  }

  if (loading) return <div className="mem-observation-panel__state">加载中…</div>
  if (err) return <div className="mem-observation-panel__state mem-observation-panel__state--error">{err}</div>
  if (items.length === 0) return <div className="mem-observation-panel__state">暂无观察期记忆</div>

  return (
    <div className="mem-observation-panel">
      {items.map(item => {
        const left = daysLeft(item.promoted_at, item.observation_window_days)
        const busy = busyId === item.id
        return (
          <div key={item.id} className="mem-observation-card">
            <div>
              <div className="mem-observation-card__brief">{item.brief}</div>
              <div className="mem-observation-card__meta">
                <span>{TYPE_LABEL[item.type] ?? item.type}</span>
                <span aria-hidden="true">·</span>
                <span>观察期剩余 <em>{left}</em> 天 / 共 {item.observation_window_days} 天</span>
                <span aria-hidden="true">·</span>
                <span title="用户在引用此记忆的任务上累计表达正向态度（pass）次数；strong_pass 计 2 次">
                  正反馈 <em>{item.observation_pass_count ?? 0}</em>
                </span>
                <span aria-hidden="true">·</span>
                <span title="用户在引用此记忆的任务上累计表达负向态度（fail）次数；strong_fail 计 2 次">
                  负反馈 <em>{item.observation_fail_count ?? 0}</em>
                </span>
              </div>
            </div>
            <div className="mem-observation-card__actions">
              <button
                type="button"
                disabled={busy}
                className="mem-observation-card__btn mem-observation-card__btn--pass"
                onClick={() => markPass(item.id)}
              >标记通过</button>
              <button
                type="button"
                disabled={busy}
                className="mem-observation-card__btn"
                onClick={() => extend(item.id)}
              >延长观察</button>
              <button
                type="button"
                disabled={busy}
                className="mem-observation-card__btn mem-observation-card__btn--drop"
                onClick={() => drop(item.id)}
              >删除</button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
