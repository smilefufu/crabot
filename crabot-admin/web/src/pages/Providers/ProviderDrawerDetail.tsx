import React, { useState } from 'react'
import { providerService } from '../../services/provider'
import { Button } from '../../components/Common/Button'
import { StatusBadge } from '../../components/Common/StatusBadge'
import { useToast } from '../../contexts/ToastContext'
import type { ModelProvider } from '../../types'

interface ProviderDrawerDetailProps {
  provider: ModelProvider
  onEdit: () => void
  onDelete: () => void
  onRefresh: () => void
}

export const ProviderDrawerDetail: React.FC<ProviderDrawerDetailProps> = ({
  provider,
  onEdit,
  onDelete,
  onRefresh,
}) => {
  const toast = useToast()
  const [refreshing, setRefreshing] = useState(false)
  const [togglingVision, setTogglingVision] = useState<string | null>(null)
  const [modelTestResults, setModelTestResults] = useState<
    Record<string, { status: 'pending' | 'success' | 'error'; latency_ms?: number; error?: string }>
  >({})

  const handleRefreshModels = async () => {
    try {
      setRefreshing(true)
      const result = await providerService.refreshModels(provider.id)
      if (result.added.length > 0 || result.removed.length > 0) {
        toast.success(`模型已同步：新增 ${result.added.length} 个，移除 ${result.removed.length} 个`)
      } else {
        toast.success('模型列表已是最新')
      }
      onRefresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '同步失败')
    } finally {
      setRefreshing(false)
    }
  }

  const handleTestModel = async (modelId: string) => {
    setModelTestResults(prev => ({
      ...prev,
      [modelId]: { status: 'pending' },
    }))

    try {
      const result = await providerService.testProvider(provider.id, modelId)
      setModelTestResults(prev => ({
        ...prev,
        [modelId]: {
          status: result.success ? 'success' : 'error',
          latency_ms: result.latency_ms,
          error: result.error,
        },
      }))
    } catch (err) {
      setModelTestResults(prev => ({
        ...prev,
        [modelId]: {
          status: 'error',
          error: err instanceof Error ? err.message : '测试失败',
        },
      }))
    }
  }

  const handleToggleVision = async (modelId: string, currentValue: boolean) => {
    try {
      setTogglingVision(modelId)
      const updatedModels = provider.models.map(m =>
        m.model_id === modelId ? { ...m, supports_vision: !currentValue } : m
      )
      await providerService.updateProvider(provider.id, { models: updatedModels })
      toast.success(`已${!currentValue ? '启用' : '关闭'} ${modelId} 的视觉能力标记`)
      onRefresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新失败')
    } finally {
      setTogglingVision(null)
    }
  }

  const maskApiKey = (key: string) => {
    if (key.length <= 12) return '****'
    return `${key.slice(0, 8)}...${key.slice(-4)}`
  }

  return (
    <div>
      <h3 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1rem' }}>{provider.name}</h3>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1.25rem' }}>
        <div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>类型</div>
          <div>{provider.type} ({provider.format})</div>
        </div>
        <div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>端点</div>
          <div style={{ fontSize: '0.85rem', wordBreak: 'break-all' }}>{provider.endpoint}</div>
        </div>
        {provider.auth_type === 'oauth' ? (
          <div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>OAuth 登录</div>
            {provider.oauth_info?.email ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span>{provider.oauth_info.email}</span>
                {provider.oauth_info.expires_at && (
                  <span style={{
                    fontSize: '0.75rem',
                    color: Date.now() > provider.oauth_info.expires_at ? 'var(--error)' : 'var(--success)',
                  }}>
                    {Date.now() > provider.oauth_info.expires_at ? '已过期' : '有效'}
                  </span>
                )}
              </div>
            ) : (
              <div style={{ color: 'var(--text-secondary)' }}>未登录</div>
            )}
          </div>
        ) : (
          <div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>API Key</div>
            <div>{maskApiKey(provider.api_key)}</div>
          </div>
        )}
        <div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>状态</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <StatusBadge status={provider.status}>
              {provider.status === 'active' ? '正常' : provider.status === 'inactive' ? '未激活' : '错误'}
            </StatusBadge>
            {provider.last_validated_at && (
              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                验证于 {new Date(provider.last_validated_at).toLocaleString()}
              </span>
            )}
          </div>
        </div>
        {provider.validation_error && (
          <div style={{ color: 'var(--error)', fontSize: '0.85rem' }}>{provider.validation_error}</div>
        )}
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem' }}>
        <Button variant="secondary" onClick={onEdit}>编辑</Button>
        {provider.type === 'preset' && provider.preset_vendor && (
          <Button variant="secondary" onClick={handleRefreshModels} disabled={refreshing}>
            {refreshing ? '同步中...' : '同步模型'}
          </Button>
        )}
        <Button variant="danger" onClick={onDelete}>删除</Button>
      </div>

      <h4 style={{ marginBottom: '0.5rem' }}>模型列表 ({provider.models.length})</h4>
      {provider.models.length === 0 ? (
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>暂无模型</p>
      ) : (
        <div className="model-table">
          <div className="model-table-header">
            <span className="model-table-col-id">模型 ID</span>
            <span className="model-table-col-type">类型</span>
            <span className="model-table-col-test">测试</span>
          </div>
          {provider.models.map(model => {
            const testResult = modelTestResults[model.model_id]
            return (
              <div className="model-table-row" key={model.model_id}>
                <span className="model-table-col-id">{model.model_id}</span>
                <span className="model-table-col-type">
                  <span className={`badge badge-${model.type === 'llm' ? 'success' : 'warning'}`}>
                    {model.type === 'llm' ? 'LLM' : 'Embedding'}
                  </span>
                  {model.type === 'llm' && (
                    <span
                      className={`badge ${model.supports_vision ? 'badge-info' : 'badge-muted'}`}
                      title={model.supports_vision ? '支持视觉/图片理解（点击关闭）' : '不支持视觉（点击启用）'}
                      style={{
                        marginLeft: '0.25rem',
                        cursor: togglingVision === model.model_id ? 'wait' : 'pointer',
                        opacity: model.supports_vision ? 1 : 0.4,
                      }}
                      onClick={() => !togglingVision && handleToggleVision(model.model_id, !!model.supports_vision)}
                    >
                      VLM
                    </span>
                  )}
                </span>
                <span className="model-table-col-test">
                  {testResult?.status === 'pending' ? (
                    <span className="provider-test-result pending">测试中...</span>
                  ) : testResult?.status === 'success' ? (
                    <span className="provider-test-result success">✓ {testResult.latency_ms}ms</span>
                  ) : testResult?.status === 'error' ? (
                    <span className="provider-test-result error" title={testResult.error}>✗</span>
                  ) : (
                    <button
                      className="btn btn-secondary"
                      style={{ padding: '0.15rem 0.5rem', fontSize: '0.75rem' }}
                      onClick={() => handleTestModel(model.model_id)}
                    >
                      测试
                    </button>
                  )}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
