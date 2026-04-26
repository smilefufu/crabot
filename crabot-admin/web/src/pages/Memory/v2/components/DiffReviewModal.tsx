import React from 'react'

export interface DiffReviewModalProps {
  open: boolean
  title: string
  oldLabel: string
  newLabel: string
  oldText: string
  newText: string
  onClose: () => void
}

export const DiffReviewModal: React.FC<DiffReviewModalProps> = ({
  open, title, oldLabel, newLabel, oldText, newText, onClose,
}) => {
  if (!open) return null
  return (
    <div className="mem-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="mem-modal mem-diff" role="dialog" aria-modal="true">
        <h3 className="mem-modal__title">{title}</h3>
        <div className="mem-diff__grid">
          <div className="mem-diff__column">
            <div className="mem-diff__caption mem-diff__caption--old">{oldLabel}</div>
            <pre className="mem-diff__pre mem-diff__pre--old">{oldText}</pre>
          </div>
          <div className="mem-diff__column">
            <div className="mem-diff__caption mem-diff__caption--new">{newLabel}</div>
            <pre className="mem-diff__pre mem-diff__pre--new">{newText}</pre>
          </div>
        </div>
        <div className="mem-modal__actions">
          <button type="button" className="mem-modal__btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
