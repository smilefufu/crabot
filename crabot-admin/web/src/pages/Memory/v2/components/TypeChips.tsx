import React from 'react'
import type { MemoryType } from '../../../../services/memoryV2'

export interface TypeChipsProps {
  value: MemoryType | null
  onChange: (v: MemoryType | null) => void
}

const OPTIONS: Array<{ value: MemoryType | null; label: string }> = [
  { value: 'fact', label: '事实' },
  { value: 'lesson', label: '经验' },
  { value: 'concept', label: '概念' },
  { value: null, label: '全部' },
]

export const TypeChips: React.FC<TypeChipsProps> = ({ value, onChange }) => (
  <div className="mem-filter-row">
    <span className="mem-filter-row__label">类型</span>
    {OPTIONS.map(opt => {
      const active = opt.value === value
      return (
        <button
          key={opt.label}
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
