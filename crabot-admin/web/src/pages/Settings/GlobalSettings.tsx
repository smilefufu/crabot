import React, { useState, useEffect } from 'react'
import { providerService } from '../../services/provider'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { Select } from '../../components/Common/Select'
import { Loading } from '../../components/Common/Loading'
import type { GlobalModelConfig, ModelProvider } from '../../types'
import { useToast } from '../../contexts/ToastContext'
import { api } from '../../services/api'

interface ConfigStatus {
  configured: boolean
  missing: string[]
  warnings: string[]
}

export const GlobalSettings: React.FC = () => {
  const toast = useToast()
  const [config, setConfig] = useState<GlobalModelConfig | null>(null)
  const [providers, setProviders] = useState<ModelProvider[]>([])
  const [status, setStatus] = useState<ConfigStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    try {
      setLoading(true)
      const [configData, providersData, statusData] = await Promise.all([
        providerService.getGlobalConfig(),
        providerService.listProviders(),
        api.get<ConfigStatus>('/config/status').catch(() => null),
      ])
      setConfig(configData)
      setProviders(providersData.items)
      setStatus(statusData)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async () => {
    if (!config) return

    try {
      setSaving(true)
      await providerService.updateGlobalConfig(config)
      toast.success('保存成功')
      const statusData = await api.get<ConfigStatus>('/config/status').catch(() => null)
      setStatus(statusData)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <MainLayout><Loading /></MainLayout>
  if (!config) return <MainLayout><div className="error-message">配置不存在</div></MainLayout>

  const llmProviders = providers.filter((p) => p.models.some((m) => m.type === 'llm'))
  const embeddingProviders = providers.filter((p) => p.models.some((m) => m.type === 'embedding'))

  const selectedLlmProvider = providers.find((p) => p.id === config.default_llm_provider_id)
  const selectedEmbeddingProvider = providers.find((p) => p.id === config.default_embedding_provider_id)

  return (
    <MainLayout>
      <div style={{ marginBottom: '2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 700 }}>全局设置</h1>
        <Button variant="primary" onClick={handleSave} disabled={saving}>
          {saving ? '保存中...' : '保存'}
        </Button>
      </div>

      {error && <div className="error-message">{error}</div>}

      {status && !status.configured && (
        <div style={{
          backgroundColor: 'var(--warning-bg, #fff3cd)',
          border: '1px solid var(--warning-border, #ffc107)',
          borderRadius: '4px',
          padding: '1rem',
          marginBottom: '1.5rem',
        }}>
          <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '1.1rem', fontWeight: 600 }}>
            配置清单
          </h3>
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

      <Card title="默认模型配置">
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
          设置全局默认的 LLM 和 Embedding 模型，Agent 实例可以继承这些配置
        </p>

        <div style={{ display: 'grid', gap: '1.5rem' }}>
          <div>
            <h3 style={{ marginBottom: '1rem' }}>LLM 模型</h3>
            <Select
              label="供应商"
              options={[
                { value: '', label: '未设置' },
                ...llmProviders.map((p) => ({ value: p.id, label: p.name })),
              ]}
              value={config.default_llm_provider_id || ''}
              onChange={(e) => setConfig({ ...config, default_llm_provider_id: e.target.value || undefined })}
            />

            {selectedLlmProvider && (
              <Select
                label="模型"
                options={[
                  { value: '', label: '选择模型' },
                  ...selectedLlmProvider.models
                    .filter((m) => m.type === 'llm')
                    .map((m) => ({ value: m.model_id, label: m.display_name })),
                ]}
                value={config.default_llm_model_id || ''}
                onChange={(e) => setConfig({ ...config, default_llm_model_id: e.target.value || undefined })}
              />
            )}
          </div>

          <div>
            <h3 style={{ marginBottom: '1rem' }}>Embedding 模型</h3>
            <Select
              label="供应商"
              options={[
                { value: '', label: '未设置' },
                ...embeddingProviders.map((p) => ({ value: p.id, label: p.name })),
              ]}
              value={config.default_embedding_provider_id || ''}
              onChange={(e) => setConfig({ ...config, default_embedding_provider_id: e.target.value || undefined })}
            />

            {selectedEmbeddingProvider && (
              <Select
                label="模型"
                options={[
                  { value: '', label: '选择模型' },
                  ...selectedEmbeddingProvider.models
                    .filter((m) => m.type === 'embedding')
                    .map((m) => ({ value: m.model_id, label: m.display_name })),
                ]}
                value={config.default_embedding_model_id || ''}
                onChange={(e) => setConfig({ ...config, default_embedding_model_id: e.target.value || undefined })}
              />
            )}
          </div>
        </div>
      </Card>
    </MainLayout>
  )
}
