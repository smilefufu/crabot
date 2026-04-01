import React, { useState } from 'react'
import { providerService } from '../../services/provider'
import { Button } from '../../components/Common/Button'
import { Input } from '../../components/Common/Input'
import { Select } from '../../components/Common/Select'
import { useToast } from '../../contexts/ToastContext'
import type { ModelProvider, ModelInfo } from '../../types'

interface ProviderDrawerEditProps {
  provider: ModelProvider
  onSave: () => void
  onCancel: () => void
}

export const ProviderDrawerEdit: React.FC<ProviderDrawerEditProps> = ({
  provider,
  onSave,
  onCancel,
}) => {
  const toast = useToast()
  const [name, setName] = useState(provider.name)
  const [endpoint, setEndpoint] = useState(provider.endpoint)
  const [apiKey, setApiKey] = useState(provider.api_key)
  const [saving, setSaving] = useState(false)

  const llmModels = provider.models.filter(m => m.type === 'llm').map(m => m.model_id)
  const embeddingModels = provider.models.filter(m => m.type === 'embedding').map(m => m.model_id)
  const [llmText, setLlmText] = useState(llmModels.join('\n'))
  const [embeddingText, setEmbeddingText] = useState(embeddingModels.join('\n'))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    const updateData: Record<string, unknown> = { name, endpoint, api_key: apiKey }

    if (provider.type === 'manual') {
      const parseLine = (text: string) =>
        text.split('\n').map(l => l.trim()).filter(Boolean)

      const models: ModelInfo[] = [
        ...parseLine(llmText).map(id => ({
          model_id: id,
          display_name: id,
          type: 'llm' as const,
        })),
        ...parseLine(embeddingText).map(id => ({
          model_id: id,
          display_name: id,
          type: 'embedding' as const,
        })),
      ]
      updateData.models = models
    }

    try {
      setSaving(true)
      await providerService.updateProvider(provider.id, updateData)
      toast.success('保存成功')
      onSave()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>编辑供应商</h3>
        <span style={{ color: 'var(--text-secondary)', cursor: 'pointer' }} onClick={onCancel}>取消</span>
      </div>

      <form onSubmit={handleSubmit}>
        <Input label="名称" value={name} onChange={e => setName(e.target.value)} required />

        <Select
          label="API 格式"
          options={[
            { value: 'openai', label: 'OpenAI' },
            { value: 'anthropic', label: 'Anthropic' },
            { value: 'gemini', label: 'Gemini' },
          ]}
          value={provider.format}
          onChange={() => {}}
          disabled
        />

        <Input label="端点" value={endpoint} onChange={e => setEndpoint(e.target.value)} required />

        <Input type="password" label="API Key" value={apiKey} onChange={e => setApiKey(e.target.value)} required />

        {provider.type === 'manual' && (
          <>
            <div className="form-group">
              <label className="form-label">LLM 模型（每行一个）</label>
              <textarea
                className="textarea"
                value={llmText}
                onChange={e => setLlmText(e.target.value)}
                rows={4}
                placeholder="gpt-4o&#10;gpt-4o-mini"
              />
            </div>

            <div className="form-group">
              <label className="form-label">Embedding 模型（每行一个）</label>
              <textarea
                className="textarea"
                value={embeddingText}
                onChange={e => setEmbeddingText(e.target.value)}
                rows={3}
                placeholder="text-embedding-3-small"
              />
            </div>
          </>
        )}

        {provider.type === 'preset' && (
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '1rem 0' }}>
            预置厂商的模型列表不可手动编辑，请使用"同步模型"按钮刷新。
          </p>
        )}

        <Button type="submit" variant="primary" disabled={saving || !name || !endpoint || !apiKey}
          style={{ width: '100%', marginTop: '0.5rem' }}>
          {saving ? '保存中...' : '保存'}
        </Button>
      </form>
    </div>
  )
}
