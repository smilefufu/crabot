import React from 'react'

export interface ObservationPendingBadgeProps {
  count: number
  onClick: () => void
}

export const ObservationPendingBadge: React.FC<ObservationPendingBadgeProps> = ({ count, onClick }) => {
  if (count <= 0) return null
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-3 py-1 bg-amber-100 text-amber-800 rounded text-sm hover:bg-amber-200"
    >
      观察期：{count}
    </button>
  )
}
