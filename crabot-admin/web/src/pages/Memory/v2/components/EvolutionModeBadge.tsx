import React from 'react'
import type { EvolutionMode } from '../../../../services/memoryV2'

export interface EvolutionModeBadgeProps {
  mode: EvolutionMode
  onClick: () => void
}

const MODE_CLASS: Record<EvolutionMode, string> = {
  balanced: 'mem-evo-badge--balanced',
  innovate: 'mem-evo-badge--innovate',
  harden: 'mem-evo-badge--harden',
  'repair-only': 'mem-evo-badge--repair',
}

const LABEL: Record<EvolutionMode, string> = {
  balanced: '平衡',
  innovate: '偏创新',
  harden: '偏稳固',
  'repair-only': '仅修复',
}

export const EvolutionModeBadge: React.FC<EvolutionModeBadgeProps> = ({ mode, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={`mem-evo-badge ${MODE_CLASS[mode]}`}
  >
    演化模式：{LABEL[mode]}
  </button>
)
