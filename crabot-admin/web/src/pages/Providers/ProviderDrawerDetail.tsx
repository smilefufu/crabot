import React, { useState } from 'react'
import { providerService } from '../../services/provider'
import { Button } from '../../components/Common/Button'
import { StatusBadge } from '../../components/Common/StatusBadge'
import { Tooltip } from '../../components/Common/Tooltip'
import { Popover } from '../../components/Common/Popover'
import { useToast } from '../../contexts/ToastContext'
import type { ModelProvider, ModelInfo } from '../../types'
import { ProviderTestBadge, type ProviderTestState } from './ProviderTestBadge'

interface ProviderDrawerDetailProps {
  provider: ModelProvider
  onEdit: () => void
  onDelete: () => void
  onRefresh: () => void
}

// --- 上下文窗口：常用档位 + 自定义（2026-08 主流档位调研：1M 旗舰标配，256K/200K 中档，128K 上代主力） ---
const CONTEXT_PRESETS: ReadonlyArray<{ label: string; value: number }> = [
  { label: '32K', value: 32_000 },
  { label: '128K', value: 128_000 },
  { label: '200K', value: 200_000 },
  { label: '256K', value: 256_000 },
  { label: '1M', value: 1_000_000 },
  { label: '2M', value: 2_000_000 },
]

/** 格式化显示：>=1M 用 M（如 1M / 1.5M），>=1K 用 K，其余原值 */
export function formatContext(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${m % 1 === 0 ? m : Math.round(m * 10) / 10}M`
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

/** 解析用户输入：200K / 1m / 1.5M / 128000 均可；非法返回 null */
export function parseContextInput(raw: string): number | null {
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*([kKmM])?$/)
  if (!m) return null
  const base = parseFloat(m[1])
  if (!Number.isFinite(base) || base <= 0) return null
  const unit = m[2]?.toLowerCase()
  const value = unit === 'k' ? base * 1_000 : unit === 'm' ? base * 1_000_000 : base
  return Math.round(value)
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
  // 上下文 chip 编辑器：ctxEditor 记录正在编辑的 model_id 与自定义输入草稿
  const [ctxEditor, setCtxEditor] = useState<{ modelId: string; draft: string } | null>(null)
  const [keyVisible, setKeyVisible] = useState(false)

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

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(`${label}已复制`)
    } catch {
      toast.error('复制失败')
    }
  }

  // --- 上下文 chip 编辑器 ---

  const patchContext = async (modelId: string, contextWindow: number | undefined) => {
    try {
      const updatedModels = provider.models.map(m =>
        m.model_id === modelId ? { ...m, context_window: contextWindow } : m
      )
      await providerService.updateProvider(provider.id, { models: updatedModels })
      onRefresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新失败')
    }
  }

  /** 点常用档位：立即保存并关闭 */
  const handlePresetContext = async (model: ModelInfo, value: number) => {
    await patchContext(model.model_id, value)
    toast.success(`已设置 ${model.model_id} 上下文为 ${formatContext(value)}`)
    setCtxEditor(null)
  }

  /** 自定义输入保存：支持 200K / 1M / 128000 */
  const handleSaveCustomContext = async (model: ModelInfo) => {
    if (!ctxEditor || ctxEditor.modelId !== model.model_id) return
    const parsed = parseContextInput(ctxEditor.draft)
    if (parsed === null) {
      toast.error('无法识别的值，支持 200K / 1M / 128000 形式')
      return
    }
    await patchContext(model.model_id, parsed)
    toast.success(`已设置 ${model.model_id} 上下文为 ${formatContext(parsed)}`)
    setCtxEditor(null)
  }

  /** 清除配置：回退 Agent 内置兜底 */
  const handleClearContext = async (model: ModelInfo) => {
    await patchContext(model.model_id, undefined)
    toast.success(`已清除 ${model.model_id} 的上下文配置`)
    setCtxEditor(null)
  }

  const editorOpen = (modelId: string) => ctxEditor?.modelId === modelId

  const ctxEditorPanel = (model: ModelInfo) => {
    const invalid = ctxEditor !== null && ctxEditor.draft.trim() !== '' && parseContextInput(ctxEditor.draft) === null
    return (
      <div className="ctx-editor">
        <div className="ctx-editor__title">上下文窗口（token 数）</div>
        <div className="ctx-editor__presets">
          {CONTEXT_PRESETS.map(p => (
            <button
              key={p.value}
              type="button"
              className={`ctx-editor__preset${model.context_window === p.value ? ' ctx-editor__preset--active' : ''}`}
              onClick={() => void handlePresetContext(model, p.value)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <input
          className={`input ctx-editor__input${invalid ? ' ctx-editor__input--invalid' : ''}`}
          value={ctxEditor?.draft ?? ''}
          placeholder="自定义：200K / 1M / 128000"
          onChange={(e) => setCtxEditor(prev => (prev && prev.modelId === model.model_id ? { ...prev, draft: e.target.value } : prev))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !invalid) void handleSaveCustomContext(model)
          }}
        />
        {invalid && <div className="ctx-editor__err">无法识别，支持 200K / 1M / 128000 形式</div>}
        <div className="ctx-editor__actions">
          {model.context_window !== undefined && (
            <Button size="sm" variant="secondary" onClick={() => void handleClearContext(model)}>清除</Button>
          )}
          <Button
            size="sm"
            variant="primary"
            disabled={ctxEditor?.draft.trim() === '' || invalid}
            onClick={() => void handleSaveCustomContext(model)}
          >
            保存
          </Button>
        </div>
        <div className="ctx-editor__hint">未设置时 Agent 按 200K 处理（约 80% 时触发上下文压缩）</div>
      </div>
    )
  }

  return (
    <div>
      {/* 头部：标题 + 状态 + 操作 */}
      <div className="provider-head">
        <div className="provider-head__titleline">
          <h3 className="provider-head__title">{provider.name}</h3>
          <StatusBadge status={provider.status}>
            {provider.status === 'active' ? '正常' : provider.status === 'inactive' ? '未激活' : '错误'}
          </StatusBadge>
          <span style={{ flex: 1 }} />
          <Button size="sm" variant="secondary" onClick={onEdit}>编辑</Button>
          <Button size="sm" variant="danger" onClick={onDelete}>删除</Button>
        </div>
        <div className="provider-head__sub">{provider.type} · {provider.format}</div>

        <div className="provider-head__meta">
          <span className="provider-head__meta-label">端点</span>
          <span className="provider-head__meta-value">
            <span className="provider-head__meta-text" title={provider.endpoint}>{provider.endpoint}</span>
            <button
              type="button"
              className="provider-head__meta-action"
              onClick={() => void copyText(provider.endpoint, '端点')}
            >
              复制
            </button>
          </span>
        </div>
        {provider.auth_type === 'oauth' ? (
          <div className="provider-head__meta">
            <span className="provider-head__meta-label">OAuth</span>
            <span className="provider-head__meta-value">
              {provider.oauth_info?.email ? (
                <>
                  <span>{provider.oauth_info.email}</span>
                  {provider.oauth_info.expires_at && (
                    <span style={{
                      fontSize: '0.75rem',
                      color: Date.now() > provider.oauth_info.expires_at ? 'var(--error)' : 'var(--success)',
                    }}>
                      {Date.now() > provider.oauth_info.expires_at ? '已过期' : '有效'}
                    </span>
                  )}
                </>
              ) : (
                <span style={{ color: 'var(--text-secondary)' }}>未登录</span>
              )}
            </span>
          </div>
        ) : (
          <div className="provider-head__meta">
            <span className="provider-head__meta-label">API Key</span>
            <span className="provider-head__meta-value">
              <span className="provider-head__meta-text">{keyVisible ? provider.api_key : maskApiKey(provider.api_key)}</span>
              <button
                type="button"
                className="provider-head__meta-action"
                onClick={() => setKeyVisible(v => !v)}
              >
                {keyVisible ? '隐藏' : '显示'}
              </button>
              <button
                type="button"
                className="provider-head__meta-action"
                onClick={() => void copyText(provider.api_key, 'API Key')}
              >
                复制
              </button>
            </span>
          </div>
        )}
        <div className="provider-head__meta">
          <span className="provider-head__meta-label">验证</span>
          <span className="provider-head__meta-value">
            {provider.last_validated_at ? (
              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                {new Date(provider.last_validated_at).toLocaleString()}
              </span>
            ) : (
              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>未验证</span>
            )}
            {provider.type === 'preset' && provider.preset_vendor && (
              <button
                type="button"
                className="provider-head__meta-action"
                disabled={refreshing}
                onClick={() => void handleRefreshModels()}
              >
                {refreshing ? '同步中…' : '同步模型'}
              </button>
            )}
          </span>
        </div>
        {provider.validation_error && (
          <div className="provider-head__error">{provider.validation_error}</div>
        )}
      </div>

      {/* 模型列表 */}
      <h4 className="provider-models-title">模型列表 ({provider.models.length})</h4>
      {provider.models.length === 0 ? (
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>暂无模型</p>
      ) : (
        <div className="model-table">
          <div className="model-table-header">
            <span className="model-table-col-id">模型</span>
            <span className="model-table-col-type">类型</span>
            <Tooltip content="上下文窗口 token 数；Agent 用于压缩触发阈值（约 80% 时压缩），未设置按 200K 处理。点击设置" size="lg">
              <span className="model-table-col-ctx">上下文</span>
            </Tooltip>
            <Tooltip content="实战测速：和 Agent/Memory 实际调用一致的 payload 形态（带 system + tools + 真实 max_tokens）+ stream 拉首字节，能复现「中转不吃 tools / 大 max_tokens」等典型坑" size="lg">
              <span className="model-table-col-test">测速</span>
            </Tooltip>
          </div>
          {provider.models.map(model => {
            const testResult = modelTestResults[model.model_id]
            return (
              <div className="model-table-row" key={model.model_id}>
                <span className="model-table-col-id" title={model.model_id}>{model.model_id}</span>
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
                  ) : (
                    <Popover
                      placement="bottom"
                      open={editorOpen(model.model_id)}
                      onOpenChange={(open) =>
                        setCtxEditor(open ? { modelId: model.model_id, draft: '' } : null)}
                      content={editorOpen(model.model_id) ? ctxEditorPanel(model) : null}
                    >
                      <button
                        type="button"
                        className={`ctx-chip${model.context_window ? ' ctx-chip--set' : ' ctx-chip--unset'}`}
                      >
                        {model.context_window ? formatContext(model.context_window) : '设置…'}
                      </button>
                    </Popover>
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
                            style={{ padding: '0.1rem 0.45rem', fontSize: '0.72rem' }}
                            onClick={() => handleTestModel(model.model_id)}
                          >
                            测速
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
