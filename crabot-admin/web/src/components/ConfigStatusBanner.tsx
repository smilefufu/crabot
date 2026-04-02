import React, { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../services/api'

interface ConfigStatus {
  configured: boolean
  missing: string[]
  warnings: string[]
}

const styles = {
  banner: {
    background: 'linear-gradient(135deg, rgba(232, 180, 74, 0.08) 0%, rgba(217, 124, 74, 0.04) 100%)',
    border: '1px solid rgba(232, 180, 74, 0.2)',
    borderRadius: '12px',
    padding: '1.25rem 1.5rem',
    marginBottom: '1.5rem',
    backdropFilter: 'blur(8px)',
  } as React.CSSProperties,
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.6rem',
    marginBottom: '0.75rem',
  } as React.CSSProperties,
  icon: {
    width: '20px',
    height: '20px',
    borderRadius: '50%',
    background: 'rgba(232, 180, 74, 0.15)',
    border: '1px solid rgba(232, 180, 74, 0.3)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '11px',
    flexShrink: 0,
  } as React.CSSProperties,
  title: {
    fontSize: '0.9rem',
    fontWeight: 600,
    color: 'var(--warning, #e8b44a)',
    letterSpacing: '0.02em',
  } as React.CSSProperties,
  list: {
    listStyle: 'none',
    padding: 0,
    margin: '0 0 1rem 0',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '0.4rem',
  } as React.CSSProperties,
  listItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    fontSize: '0.85rem',
    color: 'var(--text-secondary, #7d7872)',
  } as React.CSSProperties,
  dot: {
    width: '5px',
    height: '5px',
    borderRadius: '50%',
    backgroundColor: 'var(--warning, #e8b44a)',
    opacity: 0.6,
    flexShrink: 0,
  } as React.CSSProperties,
  link: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.4rem',
    padding: '0.45rem 1rem',
    fontSize: '0.82rem',
    fontWeight: 500,
    fontFamily: 'var(--font-body)',
    color: 'var(--bg-primary, #0b0b0d)',
    backgroundColor: 'var(--warning, #e8b44a)',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    letterSpacing: '0.01em',
    transition: 'opacity 0.15s ease, transform 0.1s ease',
    textDecoration: 'none',
  } as React.CSSProperties,
}

export const ConfigStatusBanner: React.FC = () => {
  const [status, setStatus] = useState<ConfigStatus | null>(null)

  useEffect(() => {
    api.get<ConfigStatus>('/config/status')
      .then(data => setStatus(data))
      .catch(() => {})
  }, [])

  if (!status || status.configured) return null
  if (!Array.isArray(status.missing) || status.missing.length === 0) return null

  return (
    <div style={styles.banner}>
      <div style={styles.header}>
        <div style={styles.icon}>!</div>
        <span style={styles.title}>配置未完成</span>
      </div>
      <ul style={styles.list}>
        {status.missing.map(msg => (
          <li key={msg} style={styles.listItem}>
            <span style={styles.dot} />
            {msg}
          </li>
        ))}
      </ul>
      <Link
        to="/providers"
        style={styles.link}
        onMouseEnter={e => { e.currentTarget.style.opacity = '0.85' }}
        onMouseLeave={e => { e.currentTarget.style.opacity = '1' }}
      >
        前往配置
        <span style={{ fontSize: '0.75rem' }}>→</span>
      </Link>
    </div>
  )
}
