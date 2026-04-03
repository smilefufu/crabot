import React, { useState, useEffect } from 'react'
import { providerService } from '../../services/provider'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { Select } from '../../components/Common/Select'
import { useToast } from '../../contexts/ToastContext'
import type { GlobalModelConfig, ModelProvider } from '../../types'

interface GlobalModelConfigCardProps {
  providers: ModelProvider[]
}

export const GlobalModelConfigCard: React.FC<GlobalModelConfigCardProps> = ({ providers }) => {
  const toast = useToast()
  const [config, setConfig] = useState<GlobalModelConfig>({})
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    providerService.getGlobalConfig()
      .then(c => { setConfig(c); setLoaded(true) })
      .catch(() => setLoaded(true))
  }, [])

  const handleSave = async () => {
    try {
      setSaving(true)
      await providerService.updateGlobalConfig(config)
      toast.success('默认模型配置已保存')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  if (!loaded) return null

  const llmProviders = providers.filter(p => p.models.some(m => m.type === 'llm'))
  const embeddingProviders = providers.filter(p => p.models.some(m => m.type === 'embedding'))
  const selectedLlmProvider = providers.find(p => p.id === config.default_llm_provider_id)
  const selectedEmbeddingProvider = providers.find(p => p.id === config.default_embedding_provider_id)

  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h3 style={{ margin: 0, color: 'var(--primary)' }}>默认模型配置</h3>
        <Button variant="primary" onClick={handleSave} disabled={saving}>
          {saving ? '保存中...' : '保存'}
        </Button>
      </div>
      <div style={{ display: 'flex', gap: '1rem' }}>
        <div style={{ flex: 1 }}>
          <Select
            label="默认 LLM"
            options={[
              { value: '', label: '未设置' },
              ...llmProviders.map(p => ({ value: p.id, label: p.name })),
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
                .map(m => ({ value: m.model_id, label: m.display_name + (m.supports_vision ? ' [VLM]' : '') }))}
              value={config.default_llm_model_id || ''}
              onChange={e => setConfig({ ...config, default_llm_model_id: e.target.value || undefined })}
            />
          )}
        </div>
        <div style={{ flex: 1 }}>
          <Select
            label="默认 Embedding"
            options={[
              { value: '', label: '未设置' },
              ...embeddingProviders.map(p => ({ value: p.id, label: p.name })),
            ]}
            value={config.default_embedding_provider_id || ''}
            onChange={e => {
              const providerId = e.target.value || undefined
              const provider = providers.find(p => p.id === providerId)
              const firstEmb = provider?.models.find(m => m.type === 'embedding')
              setConfig({
                ...config,
                default_embedding_provider_id: providerId,
                default_embedding_model_id: firstEmb?.model_id,
              })
            }}
          />
          {selectedEmbeddingProvider && (
            <Select
              label="模型"
              options={selectedEmbeddingProvider.models
                .filter(m => m.type === 'embedding')
                .map(m => ({ value: m.model_id, label: m.display_name }))}
              value={config.default_embedding_model_id || ''}
              onChange={e => setConfig({ ...config, default_embedding_model_id: e.target.value || undefined })}
            />
          )}
        </div>
      </div>
    </Card>
  )
}
