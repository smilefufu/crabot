import React, { useState } from 'react'
import { providerService } from '../../services/provider'
import { Button } from '../../components/Common/Button'
import { StatusBadge } from '../../components/Common/StatusBadge'
import { Tooltip } from '../../components/Common/Tooltip'
import { useToast } from '../../contexts/ToastContext'
import type { ModelProvider } from '../../types'
import { ProviderTestBadge, type ProviderTestState } from './ProviderTestBadge'

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
  const [modelTestResults, setModelTestResults] = useState<Record<string, ProviderTestState>>({})
  // 上下文列内联编辑：editingCtx 记录正在编辑的 model_id，ctxInput 为输入框原始值
  const [editingCtx, setEditingCtx] = useState<string | null>(null)
  const [ctxInput, setCtxInput] = useState('')

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

  const formatContext = (n: number) => `${Math.round(n / 1000)}K`

  // 保存上下文：空输入 = 清除配置（回退默认 200K）；Enter/失焦触发，Esc 取消
  const handleSaveContext = async (modelId: string) => {
    const raw = ctxInput.trim()
    if (raw !== '' && (!/^\d+$/.test(raw) || parseInt(raw, 10) <= 0)) {
      toast.error('上下文必须为正整数 token 数')
      return
    }
    try {
      const updatedModels = provider.models.map(m =>
        m.model_id === modelId
          ? (raw === '' ? { ...m, context_window: undefined } : { ...m, context_window: parseInt(raw, 10) })
          : m
      )
      await providerService.updateProvider(provider.id, { models: updatedModels })
      toast.success(raw === ''
        ? `已清除 ${modelId} 的上下文配置（回退默认 200K）`
        : `已保存 ${modelId} 上下文为 ${formatContext(parseInt(raw, 10))}`)
      setEditingCtx(null)
      onRefresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新失败')
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
            <Tooltip content="模型上下文窗口 token 数；用于 Agent 上下文压缩触发阈值（约 80% 时压缩），缺省按 200000 处理" size="lg">
              <span className="model-table-col-ctx">上下文</span>
            </Tooltip>
            <Tooltip content="实战测速：和 Agent/Memory 实际调用一致的 payload 形态（带 system + tools + 真实 max_tokens）+ stream 拉首字节，能复现「中转不吃 tools / 大 max_tokens」等典型坑" size="lg">
              <span className="model-table-col-test">首字</span>
            </Tooltip>
          </div>
          {provider.models.map(model => {
            const testResult = modelTestResults[model.model_id]
            return (
              <div className="model-table-row" key={model.model_id}>
                <span className="model-table-col-id">{model.model_id}</span>
                <span className="model-table-col-type">
                  {model.type === 'image' ? (
                    <span className="badge badge-warning">生图</span>
                  ) : (
                    <>
                      <span className="badge badge-success">LLM</span>
                      <Tooltip content={model.supports_vision ? '支持视觉/图片理解（点击关闭）' : '不支持视觉（点击启用）'}>
                        <span
                          className={`badge ${model.supports_vision ? 'badge-info' : 'badge-muted'}`}
                          style={{
                            marginLeft: '0.25rem',
                            cursor: togglingVision === model.model_id ? 'wait' : 'pointer',
                            opacity: model.supports_vision ? 1 : 0.4,
                          }}
                          onClick={() => !togglingVision && handleToggleVision(model.model_id, !!model.supports_vision)}
                        >
                          VLM
                        </span>
                      </Tooltip>
                    </>
                  )}
                </span>
                <span className="model-table-col-ctx">
                  {model.type === 'image' ? (
                    <span style={{ color: 'var(--text-secondary)' }}>—</span>
                  ) : editingCtx === model.model_id ? (
                    <input
                      className="input"
                      style={{ width: '96px', padding: '0.1rem 0.4rem', fontSize: '0.8rem' }}
                      autoFocus
                      value={ctxInput}
                      placeholder="token 数"
                      onChange={(e) => setCtxInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                        if (e.key === 'Escape') setEditingCtx(null)
                      }}
                      onBlur={() => void handleSaveContext(model.model_id)}
                    />
                  ) : (
                    <Tooltip content={model.context_window
                      ? `已设置 ${formatContext(model.context_window)}（点击修改，清空即回退默认）`
                      : '未设置；Agent 按 200000 处理（点击设置）'}>
                      <span
                        style={{ cursor: 'pointer', color: model.context_window ? undefined : 'var(--text-secondary)' }}
                        onClick={() => {
                          setCtxInput(model.context_window ? String(model.context_window) : '')
                          setEditingCtx(model.model_id)
                        }}
                      >
                        {model.context_window ? formatContext(model.context_window) : '默认 200K'}
                      </span>
                    </Tooltip>
                  )}
                </span>
                <span className="model-table-col-test">
                  {model.type === 'image' ? null : (
                    <ProviderTestBadge
                      result={testResult}
                      successTooltip="首字到达耗时（TTFT）。payload 形态对齐生产 adapter（system + tools + 真实 max_tokens），中转兼容性问题在这里就会暴露"
                      showErrorText
                      idleButton={
                        <Tooltip content="按生产 adapter 的 payload 形态打一次 stream，记录首字到达时间">
                          <button
                            className="btn btn-secondary"
                            style={{ padding: '0.15rem 0.5rem', fontSize: '0.75rem' }}
                            onClick={() => handleTestModel(model.model_id)}
                          >
                            首字测速
                          </button>
                        </Tooltip>
                      }
                    />
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
