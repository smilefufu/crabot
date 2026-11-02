import React, { useState, useEffect } from 'react'
import { providerService } from '../../services/provider'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { Select } from '../../components/Common/Select'
import { useToast } from '../../contexts/ToastContext'
import type { GlobalModelConfig, ModelProvider } from '../../types'
import { ModelCapabilities } from '../../components/Common/ModelCapabilities'

interface GlobalModelConfigCardProps {
  providers: ModelProvider[]
  /** 嵌入到引导/摘要容器中：去掉外框，紧贴上下文 */
  embedded?: boolean
  /** 保存成功后的回调（外部用来收起展开态、刷新摘要） */
  onSaved?: () => void
}

export const GlobalModelConfigCard: React.FC<GlobalModelConfigCardProps> = ({
  providers,
  embedded = false,
  onSaved,
}) => {
  const toast = useToast()
  const [config, setConfig] = useState<GlobalModelConfig>({})
  const [saving, setSaving] = useState(false)
  const [readError, setReadError] = useState(false)
  const [loading, setLoading] = useState(true)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let active = true
    setLoading(true)
    setReadError(false)
    providerService.getGlobalConfig().then(value => { if (active) setConfig(value) })
      .catch(() => { if (active) setReadError(true) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [retry])

  const handleSave = async () => {
    try {
      setSaving(true)
      await providerService.updateGlobalConfig(config)
      toast.success('默认模型配置已保存')
      onSaved?.()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const llmProviders = providers.filter(p => p.models.some(m => m.type === 'llm'))
  const selectedLlmProvider = providers.find(p => p.id === config.default_llm_provider_id)
  const imageProviders = providers.filter(p => p.models.some(m => m.type === 'image'))
  const selectedImageProvider = providers.find(p => p.id === config.default_image_provider_id)
  const canSave = !!config.default_llm_provider_id && !!config.default_llm_model_id
  const selectedModel = selectedLlmProvider?.models.find(model => model.model_id === config.default_llm_model_id)

  if (loading) return <p role="status">正在读取默认模型配置…</p>
  if (readError) return <div role="alert">无法读取默认模型配置，已有设置保持保留。<Button variant="secondary" onClick={() => setRetry(value => value + 1)}>重新检查</Button></div>

  const body = (
    <div className="global-model-form">
      <div className="global-model-row">
        <Select
          label="供应商"
          options={[
            { value: '', label: '— 未设置 —' },
            ...llmProviders.map(p => ({ value: p.id, label: `${p.name}  ·  ${p.format}` })),
          ]}
          value={config.default_llm_provider_id || ''}
          onChange={e => {
            const providerId = e.target.value || undefined
            const provider = providers.find(p => p.id === providerId)
            const firstLlm = provider?.models.find(m => m.type === 'llm')
            setConfig({
              ...config,
              default_llm_provider_id: providerId,
              default_llm_model_id: firstLlm?.model_id,
            })
          }}
        />
        {selectedLlmProvider && (
          <Select
            label="模型"
            options={selectedLlmProvider.models
              .filter(m => m.type === 'llm')
              .map(m => ({
                value: m.model_id,
                label: m.display_name,
              }))}
            value={config.default_llm_model_id || ''}
            onChange={e => setConfig({ ...config, default_llm_model_id: e.target.value || undefined })}
          />
        )}
      </div>
      {selectedModel && <><ModelCapabilities model={selectedModel} /><p className="global-model-hint">能力自动填写，平时无需调整。</p></>}
      <details className="partner-advanced"><summary>高级：生图模型</summary><div className="global-model-row">
        <Select
          label="生图供应商"
          options={[
            { value: '', label: '— 未设置 —' },
            ...imageProviders.map(p => ({ value: p.id, label: `${p.name}  ·  ${p.format}` })),
          ]}
          value={config.default_image_provider_id || ''}
          onChange={e => {
            const providerId = e.target.value || undefined
            const provider = providers.find(p => p.id === providerId)
            const firstImage = provider?.models.find(m => m.type === 'image')
            setConfig({
              ...config,
              default_image_provider_id: providerId,
              default_image_model_id: firstImage?.model_id,
              image_slot_user_set: true,
            })
          }}
        />
        {selectedImageProvider && (
          <Select
            label="生图模型"
            options={selectedImageProvider.models
              .filter(m => m.type === 'image')
              .map(m => ({ value: m.model_id, label: m.display_name }))}
            value={config.default_image_model_id || ''}
            onChange={e => setConfig({
              ...config,
              default_image_model_id: e.target.value || undefined,
              image_slot_user_set: true,
            })}
          />
        )}
      </div>
      </details>
      <div className="global-model-actions">
        <Button variant="primary" onClick={handleSave} disabled={saving || !canSave}>
          {saving ? '保存中...' : '保存为全局默认'}
        </Button>
        {!canSave && (
          <span className="global-model-hint">
            选定供应商和模型后才能保存
          </span>
        )}
      </div>
    </div>
  )

  if (embedded) {
    return body
  }

  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
        <h3 style={{ margin: 0, color: 'var(--primary)' }}>默认模型配置</h3>
      </div>
      {body}
    </Card>
  )
}
