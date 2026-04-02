import React, { useEffect } from 'react'
import { Button } from './Button'

interface ConfirmModalWarning {
  title: string
  items: string[]
  note: string
}

interface ConfirmModalProps {
  open: boolean
  onConfirm: () => void
  onCancel: () => void
  title: string
  message: string
  warning?: ConfirmModalWarning
  confirmText?: string
  confirmVariant?: 'danger' | 'primary'
  loading?: boolean
}

export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  open,
  onConfirm,
  onCancel,
  title,
  message,
  warning,
  confirmText = '确认',
  confirmVariant = 'primary',
  loading = false,
}) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    if (open) {
      document.addEventListener('keydown', handleKeyDown)
    }
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onCancel])

  if (!open) return null

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">{title}</h3>
        <p className="modal-message">{message}</p>
        {warning && (
          <div className="modal-warning">
            <div className="modal-warning-title">{warning.title}</div>
            <ul className="modal-warning-items">
              {warning.items.map((item, i) => <li key={i}>{item}</li>)}
            </ul>
            <div className="modal-warning-note">{warning.note}</div>
          </div>
        )}
        <div className="modal-actions">
          <Button variant="secondary" onClick={onCancel} disabled={loading}>取消</Button>
          <Button variant={confirmVariant} onClick={onConfirm} disabled={loading}>
            {loading ? '处理中...' : confirmText}
          </Button>
        </div>
      </div>
    </div>
  )
}
