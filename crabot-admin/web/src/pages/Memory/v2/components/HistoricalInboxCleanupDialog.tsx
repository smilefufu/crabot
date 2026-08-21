import React, { useEffect, useState } from 'react'
import { Button } from '../../../../components/Common/Button'
import { Modal } from '../../../../components/Common/Modal'
import {
  memoryV2Service,
  type HistoricalInboxMigrationResult,
  type HistoricalInboxPreview,
} from '../../../../services/memoryV2'

interface HistoricalInboxCleanupDialogProps {
  open: boolean
  onClose: () => void
  onMigrated: (result: HistoricalInboxMigrationResult) => void | Promise<void>
}

const TYPE_LABELS = { fact: '事实', lesson: '经验', concept: '概念' } as const
const AGE_LABELS = {
  within_30_days: '30 天内',
  days_31_to_90: '31-90 天',
  days_91_to_365: '91-365 天',
  over_365_days: '超过 365 天',
} as const

export const HistoricalInboxCleanupDialog: React.FC<HistoricalInboxCleanupDialogProps> = ({
  open,
  onClose,
  onMigrated,
}) => {
  const [preview, setPreview] = useState<HistoricalInboxPreview | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<HistoricalInboxMigrationResult | null>(null)

  useEffect(() => {
    if (!open) return
    setConfirmed(false)
    setError(null)
    setLastResult(null)
    setLoading(true)
    memoryV2Service.previewHistoricalInbox()
      .then(setPreview)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '预览加载失败'))
      .finally(() => setLoading(false))
  }, [open])

  async function migrateNextBatch() {
    if (!confirmed || !preview || preview.estimated_move_count === 0) return
    setLoading(true)
    setError(null)
    try {
      const result = await memoryV2Service.migrateHistoricalInboxBatch(preview.selection.cutoff)
      setLastResult(result)
      setPreview(await memoryV2Service.previewHistoricalInbox(preview.selection.cutoff))
      setConfirmed(false)
      await onMigrated(result)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '迁移失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={loading ? () => {} : onClose}
      title="清理历史 inbox"
      description="仅处理新生命周期启用前的历史候选，不读取或改写正文。"
      size="md"
      dismissOnBackdrop={!loading}
      dismissOnEscape={!loading}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading}>关闭</Button>
          <Button
            variant="danger"
            onClick={() => { void migrateNextBatch() }}
            disabled={loading || !confirmed || !preview || preview.estimated_move_count === 0}
          >
            {loading ? '处理中…' : '迁移下一批（最多 200 条）'}
          </Button>
        </>
      }
    >
      {loading && !preview ? <div className="mem-history__loading">正在生成预览…</div> : null}
      {error ? <div className="mem-history__error" role="alert">{error}</div> : null}
      {preview ? (
        <div className="mem-history">
          <div className="mem-history__summary">
            <span>预计迁移</span>
            <strong>{preview.estimated_move_count}</strong>
            <span>条历史候选</span>
          </div>
          <div className="mem-history__grid" aria-label="历史 inbox 预览">
            <div>
              <h4>按类型</h4>
              {Object.entries(TYPE_LABELS).map(([key, label]) => (
                <p key={key}><span>{label}</span><strong>{preview.by_type[key as keyof typeof TYPE_LABELS]}</strong></p>
              ))}
            </div>
            <div>
              <h4>按年龄</h4>
              {Object.entries(AGE_LABELS).map(([key, label]) => (
                <p key={key}><span>{label}</span><strong>{preview.by_age[key as keyof typeof AGE_LABELS]}</strong></p>
              ))}
            </div>
          </div>
          {preview.estimated_move_count > 0 ? (
            <label className="mem-history__confirm">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={loading}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span>我确认将下一批候选移入回收站，并从本次迁移起保留 30 天恢复窗口。</span>
            </label>
          ) : <p className="mem-history__empty">没有可迁移的历史 inbox。</p>}
          {lastResult ? (
            <div className="mem-history__result">
              本批已迁移 {lastResult.moved} 条，剩余 {lastResult.remaining} 条。
              {lastResult.failed.length > 0 ? ` ${lastResult.failed.length} 条未迁移。` : ''}
            </div>
          ) : null}
        </div>
      ) : null}
    </Modal>
  )
}
