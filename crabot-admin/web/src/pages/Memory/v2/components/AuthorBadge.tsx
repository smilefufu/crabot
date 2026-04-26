import React from 'react'

export interface AuthorBadgeProps { author: string }

export const AuthorBadge: React.FC<AuthorBadgeProps> = ({ author }) => {
  const variant =
    author === 'user' ? 'mem-author--user'
    : author === 'system' ? 'mem-author--system'
    : 'mem-author--other'
  return <span className={`mem-author ${variant}`}>{author}</span>
}
