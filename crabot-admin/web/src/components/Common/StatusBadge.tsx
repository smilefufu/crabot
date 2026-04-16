import React from 'react'

interface StatusBadgeProps {
  status: 'active' | 'inactive' | 'error' | 'success' | 'warning'
  children: React.ReactNode
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status, children }) => {
  const variantMap = {
    active: 'success',
    inactive: 'secondary',
    error: 'error',
    success: 'success',
    warning: 'warning',
  }

  return <span className={`badge badge-${variantMap[status]}`}>{children}</span>
}
