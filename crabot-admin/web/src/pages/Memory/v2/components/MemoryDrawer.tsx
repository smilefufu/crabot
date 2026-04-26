import React, { useEffect } from 'react'

export interface MemoryDrawerProps {
  open: boolean
  title: string
  eyebrow?: string
  onClose: () => void
  children: React.ReactNode
  widthPx?: number
}

export const MemoryDrawer: React.FC<MemoryDrawerProps> = ({
  open, title, eyebrow, onClose, children, widthPx = 720,
}) => {
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="mem-drawer-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <aside
        className="mem-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ width: `min(${widthPx}px, 92vw)` }}
      >
        <header className="mem-drawer__header">
          <div className="mem-drawer__headings">
            {eyebrow && <div className="mem-drawer__eyebrow">{eyebrow}</div>}
            <h2 className="mem-drawer__title">{title}</h2>
          </div>
          <button
            type="button"
            className="mem-drawer__close"
            aria-label="关闭"
            onClick={onClose}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path d="M4 4l10 10M14 4L4 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <div className="mem-drawer__body">{children}</div>
      </aside>
    </div>
  )
}
