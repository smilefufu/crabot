import React, { useEffect, useRef, useState } from 'react'

export type MaintenanceScope = 'observation_check' | 'stale_aging' | 'trash_cleanup' | 'all'

export interface MaintenanceDropdownProps {
  onRun: (scope: MaintenanceScope) => Promise<void>
}

const OPTIONS: Array<{ scope: MaintenanceScope; label: string }> = [
  { scope: 'observation_check', label: '运行观察期检查' },
  { scope: 'stale_aging', label: '运行老化检查' },
  { scope: 'trash_cleanup', label: '清理回收站' },
  { scope: 'all', label: '全部运行' },
]

export const MaintenanceDropdown: React.FC<MaintenanceDropdownProps> = ({ onRun }) => {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [open])

  async function handle(scope: MaintenanceScope) {
    setBusy(true)
    setOpen(false)
    try { await onRun(scope) }
    finally { setBusy(false) }
  }

  return (
    <div className="mem-maint" ref={rootRef}>
      <button
        type="button"
        className="mem-maint__trigger"
        onClick={() => setOpen(o => !o)}
        disabled={busy}
      >
        手动维护 ▾
      </button>
      {open && (
        <div role="menu" className="mem-maint__menu">
          {OPTIONS.map(opt => (
            <button
              key={opt.scope}
              role="menuitem"
              type="button"
              className="mem-maint__item"
              disabled={busy}
              onClick={() => handle(opt.scope)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
