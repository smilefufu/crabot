import React, { useEffect, useState } from 'react'
import { Modal } from '../../components/Common/Modal'
import { Button } from '../../components/Common/Button'
import { agentObservabilityService } from '../../services/agent-observability'
import { providerService } from '../../services/provider'
import { useToast } from '../../contexts/ToastContext'
import { formatBytes } from './utils'

export const ManualCleanupDialog: React.FC<{
  open: boolean
  onClose: () => void
  onDeleted: () => void
}> = ({ open, onClose, onDeleted }) => {
  const toast = useToast()
  const [days, setDays] = useState(30)
  const [preview, setPreview] = useState<{ count: number; bytes: number } | null>(null)
  const [busy, setBusy] = useState(false)

  const doPreview = async () => {
    setBusy(true)
    try {
      const r = await agentObservabilityService.cleanupOldTraces(days, true)
      setPreview({ count: r.affected_count, bytes: r.affected_bytes })
    } catch (err) {
      toast.error('预览失败：' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setBusy(false)
    }
  }

  const doDelete = async () => {
    setBusy(true)
    try {
      const r = await agentObservabilityService.cleanupOldTraces(days, false)
      toast.success(`已删除 ${r.affected_count} 条 trace`)
      onDeleted()
      onClose()
    } catch (err) {
      toast.error('删除失败：' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title="手动清理 trace"
      description="按天为单位预览将被删除的 trace 数量，确认后执行删除。"
      dismissOnBackdrop={!busy}
      dismissOnEscape={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>取消</Button>
          <Button
            variant="danger"
            onClick={() => void doDelete()}
            disabled={busy || preview === null || preview.count === 0}
          >
            {busy ? '处理中…' : '确认删除'}
          </Button>
        </>
      }
    >
      <div className="cleanup-row">
        <span className="cleanup-row__label">删除</span>
        <input
          aria-label="天前"
          type="number"
          className="input cleanup-input cleanup-input--narrow"
          value={days}
          onChange={(e) => { setDays(Number(e.target.value) || 0); setPreview(null) }}
          min={1}
        />
        <span className="cleanup-row__label">天前的 trace</span>
        <Button
          variant="secondary"
          onClick={() => void doPreview()}
          disabled={busy || days < 1}
        >
          预览
        </Button>
      </div>
      {preview && (
        <div className="cleanup-preview" role="status">
          将删除 <strong>{preview.count} 条 trace</strong>
          <span className="cleanup-preview__bytes">（占 {formatBytes(preview.bytes)}）</span>
        </div>
      )}
    </Modal>
  )
}

type CleanupMode = 'days' | 'count'

export const AutoCleanupSettingsDialog: React.FC<{
  open: boolean
  onClose: () => void
}> = ({ open, onClose }) => {
  const toast = useToast()
  const [enabled, setEnabled] = useState(false)
  const [mode, setMode] = useState<CleanupMode>('days')
  const [days, setDays] = useState(30)
  const [count, setCount] = useState(1000)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoaded(false)
    void providerService.getGlobalConfig().then((s) => {
      const d = s.trace_retention_days
      const c = s.task_retention_count
      if (d != null && d > 0) {
        setMode('days')
        setDays(d)
        setEnabled(true)
      } else if (c != null && c > 0) {
        setMode('count')
        setCount(c)
        setEnabled(true)
      } else {
        setMode('days')
        setEnabled(false)
      }
      setLoaded(true)
    }).catch(() => setLoaded(true))
  }, [open])

  const save = async () => {
    setBusy(true)
    try {
      // spec 2026-06-09 §4.4: trace_retention_count → task_retention_count（单位改 task 个数）
      const payload = enabled
        ? mode === 'days'
          ? { trace_retention_days: days, task_retention_count: null }
          : { trace_retention_days: null, task_retention_count: count }
        : { trace_retention_days: null, task_retention_count: null }
      await providerService.updateGlobalConfig(payload)
      toast.success('自动清理设置已保存')
      onClose()
    } catch (err) {
      toast.error('保存失败：' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title="自动清理设置"
      description="按时间或任务数为单位每天自动清理历史。"
      dismissOnBackdrop={!busy}
      dismissOnEscape={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>取消</Button>
          <Button onClick={() => void save()} disabled={busy || !loaded}>
            {busy ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      {!loaded ? (
        <div className="cleanup-loading">加载中…</div>
      ) : (
        <>
          <label className="cleanup-toggle">
            <input
              type="checkbox"
              aria-label="启用自动清理"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <span>启用自动清理</span>
          </label>
          <div role="radiogroup" aria-label="清理策略" className="cleanup-radio-group">
            <label className="cleanup-radio">
              <input
                type="radio"
                name="cleanup-mode"
                aria-label="按天清理"
                checked={mode === 'days'}
                onChange={() => setMode('days')}
                disabled={!enabled}
              />
              <span>保留最近</span>
              <input
                aria-label="保留最近天数"
                type="number"
                className="input cleanup-input cleanup-input--narrow"
                value={days}
                onChange={(e) => setDays(Number(e.target.value) || 0)}
                min={1}
                disabled={!enabled || mode !== 'days'}
              />
              <span>天的数据</span>
            </label>
            <label className="cleanup-radio">
              <input
                type="radio"
                name="cleanup-mode"
                aria-label="按任务数清理"
                checked={mode === 'count'}
                onChange={() => setMode('count')}
                disabled={!enabled}
              />
              <span>保留最近</span>
              <input
                aria-label="保留最近任务数"
                type="number"
                className="input cleanup-input"
                value={count}
                onChange={(e) => setCount(Number(e.target.value) || 0)}
                min={1}
                disabled={!enabled || mode !== 'count'}
              />
              <span>个任务</span>
            </label>
          </div>
          <div className="cleanup-hint">
            {mode === 'days'
              ? '超过此期限的 trace + task 每日自动删除'
              : 'spec 2026-06-09 §4.4：按 task 维度计数（活跃任务不计入配额）；按天文件粒度删除，实际保留可能略大于设定值'}
          </div>
        </>
      )}
    </Modal>
  )
}
