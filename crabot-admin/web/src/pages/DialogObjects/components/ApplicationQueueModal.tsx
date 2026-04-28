import React, { useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '../../../components/Common/Button'
import type { DialogObjectApplication } from '../../../types'

interface ApplicationQueueModalProps {
  open: boolean
  onClose: () => void
  applications: DialogObjectApplication[]
  selectedApplicationId: string | null
  masterFriendCount: number
  actionLoading: boolean
  onSelectApplication: (id: string) => void
  onAssignExistingFriend: (application: DialogObjectApplication) => void
  onCreateFriend: (application: DialogObjectApplication) => void
  onLinkMaster: (application: DialogObjectApplication) => void
  onReject: (application: DialogObjectApplication) => void
}

type Intent = DialogObjectApplication['intent']

const INTENT_LABEL: Record<Intent, string> = {
  pair: '认主申请',
  apply: '普通申请',
}

export const ApplicationQueueModal: React.FC<ApplicationQueueModalProps> = ({
  open,
  onClose,
  applications,
  selectedApplicationId,
  masterFriendCount,
  actionLoading,
  onSelectApplication,
  onAssignExistingFriend,
  onCreateFriend,
  onLinkMaster,
  onReject,
}) => {
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [open, onClose])

  const groupedApplications = useMemo(() => ({
    pair: applications.filter((item) => item.intent === 'pair'),
    apply: applications.filter((item) => item.intent === 'apply'),
  }), [applications])

  const selectedApplication =
    applications.find((item) => item.id === selectedApplicationId) ?? applications[0] ?? null

  if (!open) return null

  const renderListColumn = () => (
    <aside className="dlg-queue-list">
      {([
        ['认主申请', 'pair', groupedApplications.pair],
        ['普通申请', 'apply', groupedApplications.apply],
      ] as const).map(([title, variant, items]) => (
        <section key={title} className="dlg-queue-list__group">
          <header className="dlg-queue-list__group-header">
            <h3>{title}</h3>
            <span className="dlg-queue-list__count">{items.length}</span>
          </header>
          {items.length === 0 ? (
            <div className="dlg-queue-list__empty">暂无</div>
          ) : (
            <ul className="dlg-queue-list__items">
              {items.map((item) => {
                const active = item.id === selectedApplication?.id
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => onSelectApplication(item.id)}
                      className={`dlg-queue-list__item${active ? ' is-active' : ''}`}
                    >
                      <span className={`dlg-intent-badge dlg-intent-badge--${variant}`}>
                        {variant === 'pair' ? '认主' : '申请'}
                      </span>
                      <span className="dlg-queue-list__item-name">
                        {item.platform_display_name}
                      </span>
                      <span className="dlg-queue-list__item-channel">{item.channel_id}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      ))}
    </aside>
  )

  const renderDetailColumn = () => {
    if (!selectedApplication) {
      return (
        <div className="dlg-queue-detail dlg-queue-detail--empty">
          <div className="dlg-queue-detail__empty-icon">∅</div>
          <p>暂无申请，等待新事件接入。</p>
        </div>
      )
    }

    const isPair = selectedApplication.intent === 'pair'
    const hint = isPair
      ? (masterFriendCount > 0
          ? `当前已有 ${masterFriendCount} 个 Master，可直接并入现有 Master。`
          : '当前没有 Master，可直接创建新的 Master。')
      : '普通申请可以归到已有好友，或按当前申请直接新建好友。'

    return (
      <div className="dlg-queue-detail">
        <header className="dlg-queue-detail__header">
          <span className={`dlg-intent-badge dlg-intent-badge--${selectedApplication.intent}`}>
            {INTENT_LABEL[selectedApplication.intent]}
          </span>
          <h3>{selectedApplication.platform_display_name}</h3>
        </header>

        <dl className="dlg-queue-detail__meta">
          <div>
            <dt>来源渠道</dt>
            <dd className="mono">{selectedApplication.channel_id}</dd>
          </div>
          <div>
            <dt>来源私聊</dt>
            <dd className="mono">{selectedApplication.source_session_id}</dd>
          </div>
          <div>
            <dt>内容预览</dt>
            <dd>{selectedApplication.content_preview || '（无）'}</dd>
          </div>
        </dl>

        <p className="dlg-queue-detail__hint">{hint}</p>

        <div className="dlg-queue-detail__actions">
          {isPair ? (
            <>
              <Button
                variant="primary"
                onClick={() => onLinkMaster(selectedApplication)}
                disabled={actionLoading}
              >
                {masterFriendCount > 0 ? '并入现有 Master' : '新建 Master'}
              </Button>
              <Button
                variant="secondary"
                onClick={() => onReject(selectedApplication)}
                disabled={actionLoading}
              >
                拒绝申请
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="primary"
                onClick={() => onCreateFriend(selectedApplication)}
                disabled={actionLoading}
              >
                新建好友
              </Button>
              <Button
                variant="secondary"
                onClick={() => onAssignExistingFriend(selectedApplication)}
                disabled={actionLoading}
              >
                归到已有好友
              </Button>
              <Button
                variant="secondary"
                onClick={() => onReject(selectedApplication)}
                disabled={actionLoading}
              >
                拒绝申请
              </Button>
            </>
          )}
        </div>
      </div>
    )
  }

  return createPortal(
    <div className="dlg-modal-overlay" onClick={onClose}>
      <div
        className="dlg-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dlg-queue-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="dlg-modal__header">
          <div>
            <span className="dlg-modal__eyebrow">事件归属</span>
            <h2 id="dlg-queue-title">申请队列</h2>
            <p>
              集中处理 <code>/认主</code> 与 <code>/apply</code> 事件，按当前对话对象模型完成归属。
            </p>
          </div>
          <button type="button" className="dlg-modal__close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>
        <div className="dlg-modal__body">
          {renderListColumn()}
          {renderDetailColumn()}
        </div>
      </div>
    </div>,
    document.body,
  )
}
