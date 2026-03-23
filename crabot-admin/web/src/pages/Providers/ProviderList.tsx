import React, { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { providerService } from '../../services/provider'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { StatusBadge } from '../../components/Common/StatusBadge'
import { Loading } from '../../components/Common/Loading'
import type { ModelProvider } from '../../types'
import { useToast } from '../../contexts/ToastContext'

export const ProviderList: React.FC = () => {
  const toast = useToast()
  const [providers, setProviders] = useState<ModelProvider[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    loadProviders()
  }, [])

  const loadProviders = async () => {
    try {
      setLoading(true)
      const response = await providerService.listProviders()
      setProviders(response.items)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('确定要删除此供应商吗？')) return

    try {
      await providerService.deleteProvider(id)
      await loadProviders()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    }
  }

  if (loading) return <MainLayout><Loading /></MainLayout>

  return (
    <MainLayout>
      <div style={{ marginBottom: '2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 700 }}>模型供应商</h1>
        <Link to="/providers/new">
          <Button variant="primary">创建供应商</Button>
        </Link>
      </div>

      {error && <div className="error-message">{error}</div>}

      {providers.length === 0 ? (
        <Card>
          <p style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
            暂无供应商，请创建一个
          </p>
        </Card>
      ) : (
        <div style={{ display: 'grid', gap: '1rem' }}>
          {providers.map((provider) => (
            <Card key={provider.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.5rem' }}>
                    <h3 style={{ fontSize: '1.25rem', fontWeight: 600 }}>{provider.name}</h3>
                    <StatusBadge status={provider.status}>
                      {provider.status === 'active' ? '正常' : provider.status === 'inactive' ? '未激活' : '错误'}
                    </StatusBadge>
                  </div>
                  <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                    <p>格式: {provider.format} | 端点: {provider.endpoint}</p>
                    <p>模型数量: {provider.models.length}</p>
                    {provider.validation_error && (
                      <p style={{ color: 'var(--error)' }}>错误: {provider.validation_error}</p>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <Link to={`/providers/${provider.id}`}>
                    <Button variant="secondary">查看</Button>
                  </Link>
                  <Link to={`/providers/${provider.id}/edit`}>
                    <Button variant="secondary">编辑</Button>
                  </Link>
                  <Button variant="danger" onClick={() => handleDelete(provider.id)}>
                    删除
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </MainLayout>
  )
}
