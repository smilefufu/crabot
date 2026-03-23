import React, { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { providerService } from '../../services/provider'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { Input } from '../../components/Common/Input'
import { Select } from '../../components/Common/Select'
import { Loading } from '../../components/Common/Loading'
import type { ModelProvider, ApiFormat } from '../../types'

export const ProviderEdit: React.FC = () => {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [provider, setProvider] = useState<ModelProvider | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const [name, setName] = useState('')
  const [format, setFormat] = useState<ApiFormat>('openai')
  const [endpoint, setEndpoint] = useState('')
  const [apiKey, setApiKey] = useState('')

  useEffect(() => {
    if (!id) return
    setLoading(true)
    providerService
      .getProvider(id)
      .then((p) => {
        setProvider(p)
        setName(p.name)
        setFormat(p.format)
        setEndpoint(p.endpoint)
        setApiKey(p.api_key)
      })
      .catch((err) => setError(err instanceof Error ? err.message : '加载失败'))
      .finally(() => setLoading(false))
  }, [id])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!id) return

    try {
      setSaving(true)
      setError('')
      await providerService.updateProvider(id, { name, endpoint, api_key: apiKey })
      navigate(`/providers/${id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <MainLayout><Loading /></MainLayout>
  if (!provider) return <MainLayout><div className="error-message">{error || '供应商不存在'}</div></MainLayout>

  return (
    <MainLayout>
      <div style={{ marginBottom: '2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 700 }}>编辑供应商</h1>
        <Button variant="secondary" onClick={() => navigate(`/providers/${id}`)}>
          取消
        </Button>
      </div>

      {error && <div className="error-message">{error}</div>}

      <Card>
        <form onSubmit={handleSubmit}>
          <Input
            label="名称"
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
            disabled
          />

          <Input
            label="端点"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            required
          />

          <Input
            type="password"
            label="API Key"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            required
          />

          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? '保存中...' : '保存'}
            </Button>
            <Button variant="secondary" onClick={() => navigate(`/providers/${id}`)}>
              取消
            </Button>
          </div>
        </form>
      </Card>
    </MainLayout>
  )
}
