import React, { useState, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { providerService } from '../../services/provider'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { StatusBadge } from '../../components/Common/StatusBadge'
import { Loading } from '../../components/Common/Loading'
import type { ModelProvider } from '../../types'
import { useToast } from '../../contexts/ToastContext'

export const ProviderDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const toast = useToast()
  const [provider, setProvider] = useState<ModelProvider | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!id) return
    setLoading(true)
    providerService
      .getProvider(id)
      .then(setProvider)
      .catch((err) => setError(err instanceof Error ? err.message : '加载失败'))
      .finally(() => setLoading(false))
  }, [id])

  const handleDelete = async () => {
    if (!id || !confirm('确定要删除此供应商吗？')) return
    try {
      await providerService.deleteProvider(id)
      navigate('/providers')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    }
  }

  if (loading) return <MainLayout><Loading /></MainLayout>
  if (!provider) return <MainLayout><div className="error-message">{error || '供应商不存在'}</div></MainLayout>

  return (
    <MainLayout>
      <div style={{ marginBottom: '2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <h1 style={{ fontSize: '2rem', fontWeight: 700 }}>{provider.name}</h1>
          <StatusBadge status={provider.status}>
            {provider.status === 'active' ? '正常' : provider.status === 'inactive' ? '未激活' : '错误'}
          </StatusBadge>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <Button variant="secondary" onClick={() => navigate('/providers')}>返回</Button>
          <Link to={`/providers/${id}/edit`}><Button variant="primary">编辑</Button></Link>
          <Button variant="danger" onClick={handleDelete}>删除</Button>
        </div>
      </div>

      {error && <div className="error-message">{error}</div>}

      <div style={{ display: 'grid', gap: '1.5rem' }}>
        <Card title="基本信息">
          <table className="table">
            <tbody>
              <tr><td style={{ width: '150px', color: 'var(--text-secondary)' }}>ID</td><td>{provider.id}</td></tr>
              <tr><td style={{ color: 'var(--text-secondary)' }}>类型</td><td>{provider.type}</td></tr>
              <tr><td style={{ color: 'var(--text-secondary)' }}>API 格式</td><td>{provider.format}</td></tr>
              <tr><td style={{ color: 'var(--text-secondary)' }}>端点</td><td>{provider.endpoint}</td></tr>
              <tr><td style={{ color: 'var(--text-secondary)' }}>API Key</td><td>{provider.api_key.slice(0, 8)}...{provider.api_key.slice(-4)}</td></tr>
              {provider.preset_vendor && <tr><td style={{ color: 'var(--text-secondary)' }}>预置厂商</td><td>{provider.preset_vendor}</td></tr>}
              {provider.validation_error && <tr><td style={{ color: 'var(--text-secondary)' }}>错误信息</td><td style={{ color: 'var(--error)' }}>{provider.validation_error}</td></tr>}
              <tr><td style={{ color: 'var(--text-secondary)' }}>创建时间</td><td>{new Date(provider.created_at).toLocaleString()}</td></tr>
              <tr><td style={{ color: 'var(--text-secondary)' }}>更新时间</td><td>{new Date(provider.updated_at).toLocaleString()}</td></tr>
            </tbody>
          </table>
        </Card>

        {provider.new_api_channel_id && (
          <Card title="New API 集成">
            <table className="table">
              <tbody>
                <tr><td style={{ width: '150px', color: 'var(--text-secondary)' }}>Channel ID</td><td>{provider.new_api_channel_id}</td></tr>
                <tr><td style={{ color: 'var(--text-secondary)' }}>Token</td><td>{provider.new_api_token?.slice(0, 8)}...</td></tr>
              </tbody>
            </table>
          </Card>
        )}

        <Card title={`模型列表 (${provider.models.length})`}>
          {provider.models.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)' }}>暂无模型</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>模型 ID</th>
                  <th>名称</th>
                  <th>类型</th>
                  <th>特性</th>
                </tr>
              </thead>
              <tbody>
                {provider.models.map((model) => (
                  <tr key={model.model_id}>
                    <td>{model.model_id}</td>
                    <td>{model.display_name}</td>
                    <td><span className={`badge badge-${model.type === 'llm' ? 'success' : 'warning'}`}>{model.type}</span></td>
                    <td>
                      {model.supports_vision && <span className="badge badge-secondary" style={{ marginRight: '0.25rem' }}>Vision</span>}
                      {model.context_window && <span className="badge badge-secondary">{model.context_window.toLocaleString()} ctx</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </MainLayout>
  )
}
