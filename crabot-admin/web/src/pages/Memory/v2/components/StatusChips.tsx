import React from 'react'
import type { MemoryStatus } from '../../../../services/memoryV2'

export interface StatusChipsProps {
  value: MemoryStatus
  onChange: (v: MemoryStatus) => void
}

const OPTIONS: Array<{ value: MemoryStatus; label: string }> = [
  { value: 'inbox', label: '待审' },
  { value: 'confirmed', label: '已确认' },
  { value: 'trash', label: '回收站' },
]

export const StatusChips: React.FC<StatusChipsProps> = ({ value, onChange }) => (
  <div className="mem-filter-row">
    <span className="mem-filter-row__label">状态</span>
    {OPTIONS.map(opt => {
      const active = opt.value === value
      return (
        <button
          key={opt.value}
          type="button"
          aria-pressed={active}
          onClick={() => onChange(opt.value)}
          className={'mem-chip' + (active ? ' mem-chip--active' : '')}
        >
          {opt.label}
        </button>
      )
    })}
  </div>
)
