import React, { useState, useEffect } from 'react'
import { providerService } from '../../services/provider'
import { Button } from '../../components/Common/Button'
import { Input } from '../../components/Common/Input'
import { Select } from '../../components/Common/Select'
import { useToast } from '../../contexts/ToastContext'
import type { PresetVendor, ModelInfo, ApiFormat } from '../../types'

interface ProviderDrawerCreateProps {
  onCreated: (providerId: string) => void
  onCancel: () => void
}

export const ProviderDrawerCreate: React.FC<ProviderDrawerCreateProps> = ({
  onCreated,
  onCancel,
}) => {
  const toast = useToast()
  const [vendors, setVendors] = useState<PresetVendor[]>([])
  const [mode, setMode] = useState<'preset' | 'manual'>('preset')
  const [saving, setSaving] = useState(false)

  // preset mode
  const [selectedVendor, setSelectedVendor] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [customEndpoint, setCustomEndpoint] = useState('')

  // manual mode
  const [name, setName] = useState('')
  const [format, setFormat] = useState<ApiFormat>('openai')
  const [endpoint, setEndpoint] = useState('')
  const [manualApiKey, setManualApiKey] = useState('')
  const [llmText, setLlmText] = useState('')
  const [embeddingText, setEmbeddingText] = useState('')

  useEffect(() => {
    providerService.listPresetVendors().then(r => setVendors(r.items)).catch(() => {})
  }, [])

  const handlePresetSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedVendor || !apiKey) return

    const vendor = vendors.find(v => v.id === selectedVendor)
    const ep = vendor?.allows_custom_endpoint ? customEndpoint.trim() || undefined : undefined

    try {
      setSaving(true)
      const result = await providerService.importFromVendor(selectedVendor, apiKey, ep)
      toast.success('导入成功')
      // importFromVendor returns ModelProvider directly
      onCreated((result as any).id || (result as any).provider?.id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '导入失败')
    } finally {
      setSaving(false)
    }
  }

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name || !endpoint || !manualApiKey) return

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

    try {
      setSaving(true)
      const result = await providerService.createProvider({
        name,
        type: 'manual',
        format,
        endpoint,
        api_key: manualApiKey,
        models,
      })
      toast.success('创建成功')
      onCreated(result.id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>创建供应商</h3>
        <span style={{ color: 'var(--text-secondary)', cursor: 'pointer' }} onClick={onCancel}>×</span>
      </div>

      <div style={{ display: 'flex', borderBottom: '1px solid var(--border-color, #2a2a2e)', marginBottom: '1rem' }}>
        <div
          style={{
            padding: '0.5rem 1rem',
            cursor: 'pointer',
            fontSize: '0.85rem',
            borderBottom: mode === 'preset' ? '2px solid var(--primary)' : '2px solid transparent',
            color: mode === 'preset' ? 'var(--primary)' : 'var(--text-secondary)',
          }}
          onClick={() => setMode('preset')}
        >
          从厂商导入
        </div>
        <div
          style={{
            padding: '0.5rem 1rem',
            cursor: 'pointer',
            fontSize: '0.85rem',
            borderBottom: mode === 'manual' ? '2px solid var(--primary)' : '2px solid transparent',
            color: mode === 'manual' ? 'var(--primary)' : 'var(--text-secondary)',
          }}
          onClick={() => setMode('manual')}
        >
          手动配置
        </div>
      </div>

      {mode === 'preset' ? (
        <form onSubmit={handlePresetSubmit}>
          <Select
            label="选择厂商"
            options={[
              { value: '', label: '请选择...' },
              ...vendors.map(v => ({ value: v.id, label: v.name })),
            ]}
            value={selectedVendor}
            onChange={e => {
              const vid = e.target.value
              setSelectedVendor(vid)
              const v = vendors.find(vd => vd.id === vid)
              setCustomEndpoint(v?.endpoint ?? '')
            }}
          />

          {selectedVendor && (() => {
            const vendor = vendors.find(v => v.id === selectedVendor)
            return vendor?.api_key_help_url ? (
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginBottom: '0.75rem' }}>
                获取 API Key:{' '}
                <a href={vendor.api_key_help_url} target="_blank" rel="noreferrer" style={{ color: 'var(--primary)' }}>
                  {vendor.api_key_help_url}
                </a>
              </p>
            ) : null
          })()}

          {selectedVendor && vendors.find(v => v.id === selectedVendor)?.allows_custom_endpoint && (
            <Input
              label="自定义端点"
              placeholder="例如: http://192.168.1.100:11434/v1"
              value={customEndpoint}
              onChange={e => setCustomEndpoint(e.target.value)}
            />
          )}

          <Input
            type="password"
            label="API Key"
            placeholder="输入 API Key"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
          />

          <Button type="submit" variant="primary" disabled={saving || !selectedVendor || !apiKey}
            style={{ width: '100%', marginTop: '0.5rem' }}>
            {saving ? '导入中...' : '导入'}
          </Button>
        </form>
      ) : (
        <form onSubmit={handleManualSubmit}>
          <Input label="名称" placeholder="例如: My OpenAI" value={name} onChange={e => setName(e.target.value)} required />

          <Select
            label="API 格式"
            options={[
              { value: 'openai', label: 'OpenAI' },
              { value: 'anthropic', label: 'Anthropic' },
              { value: 'gemini', label: 'Gemini' },
            ]}
            value={format}
            onChange={e => setFormat(e.target.value as ApiFormat)}
          />

          <Input label="端点" placeholder="例如: https://api.openai.com/v1" value={endpoint} onChange={e => setEndpoint(e.target.value)} required />

          <Input type="password" label="API Key" placeholder="输入 API Key" value={manualApiKey} onChange={e => setManualApiKey(e.target.value)} required />

          <div className="form-group">
            <label className="form-label">LLM 模型（每行一个）</label>
            <textarea
              className="textarea"
              placeholder={"gpt-4o\ngpt-4o-mini"}
              value={llmText}
              onChange={e => setLlmText(e.target.value)}
              rows={4}
            />
          </div>

          <div className="form-group">
            <label className="form-label">Embedding 模型（每行一个）</label>
            <textarea
              className="textarea"
              placeholder="text-embedding-3-small"
              value={embeddingText}
              onChange={e => setEmbeddingText(e.target.value)}
              rows={3}
            />
          </div>

          <Button type="submit" variant="primary" disabled={saving || !name || !endpoint || !manualApiKey}
            style={{ width: '100%', marginTop: '0.5rem' }}>
            {saving ? '创建中...' : '创建'}
          </Button>
        </form>
      )}
    </div>
  )
}
