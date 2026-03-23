import React, { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../services/api'

interface ConfigStatus {
  configured: boolean
  missing: string[]
  warnings: string[]
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
    <div style={{
      backgroundColor: 'var(--warning-bg, #fff3cd)',
      border: '1px solid var(--warning-border, #ffc107)',
      borderRadius: '4px',
      padding: '1rem',
      marginBottom: '1.5rem',
    }}>
      <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '1.1rem', fontWeight: 600 }}>
        配置未完成
      </h3>
      <ul style={{ margin: '0.5rem 0', paddingLeft: '1.5rem' }}>
        {status.missing.map(msg => <li key={msg}>{msg}</li>)}
      </ul>
      <Link to="/settings">
        <button style={{
          marginTop: '0.5rem',
          padding: '0.5rem 1rem',
          backgroundColor: 'var(--primary-color, #007bff)',
          color: 'white',
          border: 'none',
          borderRadius: '4px',
          cursor: 'pointer',
        }}>
          前往配置
        </button>
      </Link>
    </div>
  )
}
