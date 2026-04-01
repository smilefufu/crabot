import React, { useState, useEffect } from 'react'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Card } from '../../components/Common/Card'
import { Loading } from '../../components/Common/Loading'
import { api } from '../../services/api'

interface ConfigStatus {
  configured: boolean
  missing: string[]
  warnings: string[]
}

export const GlobalSettings: React.FC = () => {
  const [status, setStatus] = useState<ConfigStatus | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.get<ConfigStatus>('/config/status')
      .then(setStatus)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <MainLayout><Loading /></MainLayout>

  return (
    <MainLayout>
      <div style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 700 }}>全局设置</h1>
      </div>

      {status && !status.configured && (
        <div style={{
          backgroundColor: 'var(--warning-bg, #fff3cd)',
          border: '1px solid var(--warning-border, #ffc107)',
          borderRadius: '4px',
          padding: '1rem',
          marginBottom: '1.5rem',
        }}>
          <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '1.1rem', fontWeight: 600 }}>配置清单</h3>
          <ul style={{ margin: '0.5rem 0', paddingLeft: '1.5rem' }}>
            {(status.missing ?? []).map(msg => (
              <li key={msg} style={{ color: 'var(--error-color, #dc3545)' }}>❌ {msg}</li>
            ))}
            {(status.warnings ?? []).map(msg => (
              <li key={msg} style={{ color: 'var(--warning-color, #ffc107)' }}>⚠️ {msg}</li>
            ))}
          </ul>
        </div>
      )}

      <Card>
        <p style={{ color: 'var(--text-secondary)' }}>
          默认模型配置已移至"模型供应商"页面顶部。
        </p>
      </Card>
    </MainLayout>
  )
}
