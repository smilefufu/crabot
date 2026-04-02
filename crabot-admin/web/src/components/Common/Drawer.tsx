import React, { useEffect } from 'react'

interface DrawerProps {
  open: boolean
  onClose: () => void
  width?: number
  children: React.ReactNode
}

export const Drawer: React.FC<DrawerProps> = ({ open, onClose, width = 420, children }) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    if (open) {
      document.addEventListener('keydown', handleKeyDown)
    }
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  return (
    <div className={`drawer-container ${open ? 'drawer-open' : ''}`} style={{ width: open ? width : 0 }}>
      <div className="drawer-panel" style={{ width }}>
        <button className="drawer-close" onClick={onClose} aria-label="关闭">×</button>
        <div className="drawer-content">
          {children}
        </div>
      </div>
    </div>
  )
}
