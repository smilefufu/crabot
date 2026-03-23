import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { providerService } from '../../services/provider'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { Input } from '../../components/Common/Input'
import { Select } from '../../components/Common/Select'
import type { PresetVendor, ModelInfo, ApiFormat } from '../../types'

export const ProviderCreate: React.FC = () => {
  const navigate = useNavigate()
  const [vendors, setVendors] = useState<PresetVendor[]>([])
  const [mode, setMode] = useState<'preset' | 'manual'>('preset')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // preset mode
  const [selectedVendor, setSelectedVendor] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [customEndpoint, setCustomEndpoint] = useState('')

  // manual mode
  const [name, setName] = useState('')
  const [format, setFormat] = useState<ApiFormat>('openai')
  const [endpoint, setEndpoint] = useState('')
  const [manualApiKey, setManualApiKey] = useState('')
  const [modelsText, setModelsText] = useState('')

  useEffect(() => {
    providerService.listPresetVendors().then(response => setVendors(response.items)).catch(() => {})
  }, [])

  const handlePresetSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedVendor || !apiKey) return

    const vendor = vendors.find((v) => v.id === selectedVendor)
    const endpoint = vendor?.allows_custom_endpoint ? customEndpoint.trim() || undefined : undefined

    try {
      setSaving(true)
      setError('')
      await providerService.importFromVendor(selectedVendor, apiKey, endpoint)
      navigate('/providers')
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败')
    } finally {
      setSaving(false)
    }
  }

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name || !endpoint || !manualApiKey) return

    const models: ModelInfo[] = modelsText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((modelId) => ({
        model_id: modelId,
        display_name: modelId,
        type: 'llm' as const,
      }))

    try {
      setSaving(true)
      setError('')
      await providerService.createProvider({
        name,
        type: 'manual',
        format,
        endpoint,
        api_key: manualApiKey,
        models,
      })
      navigate('/providers')
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <MainLayout>
      <div style={{ marginBottom: '2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 700 }}>创建供应商</h1>
        <Button variant="secondary" onClick={() => navigate('/providers')}>
          返回
        </Button>
      </div>

      {error && <div className="error-message">{error}</div>}

      <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem' }}>
        <Button
          variant={mode === 'preset' ? 'primary' : 'secondary'}
          onClick={() => setMode('preset')}
        >
          从预置厂商导入
        </Button>
        <Button
          variant={mode === 'manual' ? 'primary' : 'secondary'}
          onClick={() => setMode('manual')}
        >
          手动配置
        </Button>
      </div>

      {mode === 'preset' ? (
        <Card title="从预置厂商导入">
          <form onSubmit={handlePresetSubmit}>
            <Select
              label="选择厂商"
              options={[
                { value: '', label: '请选择...' },
                ...vendors.map((v) => ({ value: v.id, label: v.name })),
              ]}
              value={selectedVendor}
              onChange={(e) => {
                const vid = e.target.value
                setSelectedVendor(vid)
                const v = vendors.find((vd) => vd.id === vid)
                setCustomEndpoint(v?.endpoint ?? '')
              }}
            />

            {selectedVendor && (() => {
              const vendor = vendors.find((v) => v.id === selectedVendor)
              return vendor?.api_key_help_url ? (
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '1rem' }}>
                  获取 API Key: <a href={vendor.api_key_help_url} target="_blank" rel="noreferrer" style={{ color: 'var(--primary)' }}>{vendor.api_key_help_url}</a>
                </p>
              ) : null
            })()}

            {selectedVendor && vendors.find((v) => v.id === selectedVendor)?.allows_custom_endpoint && (
              <Input
                label="Ollama 地址"
                placeholder="例如: http://192.168.1.100:11434/v1"
                value={customEndpoint}
                onChange={(e) => setCustomEndpoint(e.target.value)}
              />
            )}

            <Input
              type="password"
              label="API Key"
              placeholder="输入 API Key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />

            <Button type="submit" variant="primary" disabled={saving || !selectedVendor || !apiKey}>
              {saving ? '导入中...' : '导入'}
            </Button>
          </form>
        </Card>
      ) : (
        <Card title="手动配置">
          <form onSubmit={handleManualSubmit}>
            <Input
              label="名称"
              placeholder="例如: My OpenAI"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />

            <Select
              label="API 格式"
              options={[
                { value: 'openai', label: 'OpenAI' },
                { value: 'anthropic', label: 'Anthropic' },
                { value: 'gemini', label: 'Gemini' },
              ]}
              value={format}
              onChange={(e) => setFormat(e.target.value as ApiFormat)}
            />

            <Input
              label="端点"
              placeholder="例如: https://api.openai.com/v1"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              required
            />

            <Input
              type="password"
              label="API Key"
              placeholder="输入 API Key"
              value={manualApiKey}
              onChange={(e) => setManualApiKey(e.target.value)}
              required
            />

            <div className="form-group">
              <label className="form-label">模型列表（每行一个模型 ID）</label>
              <textarea
                className="textarea"
                placeholder="gpt-4o&#10;gpt-4o-mini&#10;text-embedding-3-small"
                value={modelsText}
                onChange={(e) => setModelsText(e.target.value)}
                rows={5}
              />
            </div>

            <Button type="submit" variant="primary" disabled={saving || !name || !endpoint || !manualApiKey}>
              {saving ? '创建中...' : '创建'}
            </Button>
          </form>
        </Card>
      )}
    </MainLayout>
  )
}
