import React, { useState, useEffect, useRef } from 'react'
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

// OpenAI OAuth 白名单只接受 http://localhost:1455 的回调，浏览器从非 loopback 地址访问 Admin 时
// 无法把 code 自动送回 callback server，必须走"用户复制 redirect URL 粘贴回来"的兜底路径。
const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '::1']
const isLoopbackAccess =
  typeof window !== 'undefined' && LOOPBACK_HOSTNAMES.includes(window.location.hostname)

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
  const [oauthStatus, setOauthStatus] = useState<'idle' | 'pending' | 'success' | 'failed'>('idle')
  const [oauthEmail, setOauthEmail] = useState('')
  const [authUrl, setAuthUrl] = useState('')
  const [manualCallback, setManualCallback] = useState('')
  const [submittingManual, setSubmittingManual] = useState(false)
  const pollRef = useRef<{ interval?: ReturnType<typeof setInterval>; timeout?: ReturnType<typeof setTimeout> }>({})
  const finalizingRef = useRef(false)

  useEffect(() => () => {
    if (pollRef.current.interval) clearInterval(pollRef.current.interval)
    if (pollRef.current.timeout) clearTimeout(pollRef.current.timeout)
  }, [])

  // manual mode
  const [name, setName] = useState('')
  const [format, setFormat] = useState<ApiFormat>('openai')
  const [endpoint, setEndpoint] = useState('')
  const [manualApiKey, setManualApiKey] = useState('')
  const [llmText, setLlmText] = useState('')

  useEffect(() => {
    providerService.listPresetVendors().then(r => setVendors(r.items)).catch(() => {})
  }, [])

  const currentVendor = vendors.find(v => v.id === selectedVendor)
  const isOAuthVendor = currentVendor?.auth_type === 'oauth'

  const clearPoll = () => {
    if (pollRef.current.interval) clearInterval(pollRef.current.interval)
    if (pollRef.current.timeout) clearTimeout(pollRef.current.timeout)
    pollRef.current = {}
  }

  const finalizeOAuthSuccess = async (email: string) => {
    if (finalizingRef.current) return
    finalizingRef.current = true
    setOauthStatus('success')
    setOauthEmail(email)
    setSaving(true)
    try {
      const result = await providerService.importFromVendor(selectedVendor, 'oauth-pending')
      toast.success('ChatGPT 登录成功')
      const providerId =
        (result as { id?: string; provider?: { id: string } }).provider?.id ??
        (result as { id?: string }).id ??
        ''
      onCreated(providerId)
    } finally {
      setSaving(false)
    }
  }

  const handleOAuthLogin = async () => {
    try {
      finalizingRef.current = false
      const { auth_url } = await providerService.startOAuthLogin()
      setAuthUrl(auth_url)
      setManualCallback('')
      setOauthStatus('pending')

      if (isLoopbackAccess) {
        window.open(auth_url, '_blank', 'width=600,height=700')
        clearPoll()
        pollRef.current.interval = setInterval(async () => {
          let status: Awaited<ReturnType<typeof providerService.getOAuthStatus>>
          try {
            status = await providerService.getOAuthStatus()
          } catch {
            return
          }
          if (status.status === 'success') {
            clearPoll()
            try {
              await finalizeOAuthSuccess(status.email ?? '')
            } catch (err) {
              setOauthStatus('failed')
              toast.error(err instanceof Error ? err.message : '导入供应商失败')
            }
          } else if (status.status === 'failed') {
            clearPoll()
            setOauthStatus('failed')
            toast.error(status.error ?? 'OAuth 登录失败')
          }
        }, 2000)
        pollRef.current.timeout = setTimeout(clearPoll, 5 * 60 * 1000)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'OAuth 启动失败')
    }
  }

  const handleSubmitManualCallback = async () => {
    const value = manualCallback.trim()
    if (!value) {
      toast.error('请粘贴回调 URL')
      return
    }
    setSubmittingManual(true)
    try {
      const result = await providerService.submitOAuthManualCallback(value)
      await finalizeOAuthSuccess(result.email ?? '')
    } catch (err) {
      // 校验类错误（state mismatch / 没有 code）后端会保留 pending flow，UI 留在 pending 让用户改了再交。
      // token 兑换失败才会真正终结流程，此时返回 pending 视觉态依然 OK：用户点"重新登录"会走 idle 路径。
      toast.error(err instanceof Error ? err.message : '回调提交失败')
    } finally {
      setSubmittingManual(false)
    }
  }

  const copyAuthUrl = async () => {
    try {
      await navigator.clipboard.writeText(authUrl)
      toast.success('授权链接已复制')
    } catch {
      toast.error('复制失败，请手动选中链接复制')
    }
  }

  const handlePresetSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedVendor) return
    if (isOAuthVendor) return // OAuth 通过按钮处理

    if (!apiKey) return

    const vendor = vendors.find(v => v.id === selectedVendor)
    const ep = vendor?.allows_custom_endpoint ? customEndpoint.trim() || undefined : undefined

    try {
      setSaving(true)
      const result = await providerService.importFromVendor(selectedVendor, apiKey, ep)
      toast.success('导入成功')
      const typed = result as { id?: string; provider?: { id: string } }
      onCreated(typed.provider?.id ?? typed.id ?? '')
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

    const models: ModelInfo[] = parseLine(llmText).map(id => ({
      model_id: id,
      display_name: id,
      type: 'llm' as const,
    }))

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
      <div className="provider-create-head">
        <div>
          <span className="provider-create-eyebrow">[01] · new provider</span>
          <h3 className="provider-create-title">接入模型供应商</h3>
        </div>
        <span className="provider-create-close" onClick={onCancel}>×</span>
      </div>

      <div className="provider-create-modes">
        <button
          type="button"
          className={`provider-create-mode-btn ${mode === 'preset' ? 'active' : ''}`}
          onClick={() => setMode('preset')}
        >
          <span className="provider-create-mode-title">从厂商导入</span>
          <span className="provider-create-mode-sub">选预置厂商 · 自动拉取模型列表</span>
        </button>
        <button
          type="button"
          className={`provider-create-mode-btn ${mode === 'manual' ? 'active' : ''}`}
          onClick={() => setMode('manual')}
        >
          <span className="provider-create-mode-title">手动配置</span>
          <span className="provider-create-mode-sub">自托管 · Ollama · LiteLLM 等</span>
        </button>
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

          {isOAuthVendor ? (
            <>
              {!isLoopbackAccess && oauthStatus === 'idle' && (
                <div style={{
                  background: 'var(--surface-2, #1a1a1d)',
                  border: '1px solid var(--border-color, #2a2a2e)',
                  borderRadius: '4px',
                  padding: '0.75rem',
                  fontSize: '0.8rem',
                  color: 'var(--text-secondary)',
                  marginTop: '0.5rem',
                }}>
                  当前通过非 localhost 地址访问 Admin。OpenAI 只允许回调到 <code>http://localhost:1455</code>，因此自动模式不可用。
                  点击"开始登录"后，请按提示在本机浏览器完成授权，再把回调 URL 粘贴回来。
                </div>
              )}

              {oauthStatus === 'idle' && (
                <Button type="button" variant="primary" onClick={handleOAuthLogin}
                  disabled={saving || !selectedVendor}
                  style={{ width: '100%', marginTop: '0.5rem' }}>
                  {isLoopbackAccess ? '登录 ChatGPT' : '开始登录（手动粘贴回调）'}
                </Button>
              )}

              {oauthStatus === 'pending' && isLoopbackAccess && (
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', textAlign: 'center', padding: '1rem 0' }}>
                  等待浏览器中完成登录...
                </p>
              )}

              {oauthStatus === 'pending' && !isLoopbackAccess && (
                <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                    1. 复制下面的授权链接，在<strong>运行 Admin 的那台机器</strong>的浏览器里打开。<br />
                    2. 完成登录后，浏览器会自动跳转到一个形如<br />
                    <code style={{ wordBreak: 'break-all' }}>http://localhost:1455/auth/callback?code=…&state=…</code> 的地址（页面打不开是正常的）。<br />
                    3. 把那个完整 URL 从地址栏复制粘贴到下面的输入框，然后点"提交"。
                  </div>
                  <div style={{
                    display: 'flex',
                    gap: '0.5rem',
                    background: 'var(--surface-2, #1a1a1d)',
                    border: '1px solid var(--border-color, #2a2a2e)',
                    borderRadius: '4px',
                    padding: '0.5rem',
                    alignItems: 'center',
                  }}>
                    <a href={authUrl} target="_blank" rel="noreferrer"
                      style={{
                        flex: 1, fontSize: '0.75rem', color: 'var(--primary)',
                        wordBreak: 'break-all', textDecoration: 'underline',
                      }}>
                      {authUrl}
                    </a>
                    <Button type="button" variant="secondary" onClick={copyAuthUrl}
                      style={{ flexShrink: 0, fontSize: '0.75rem' }}>
                      复制
                    </Button>
                  </div>
                  <Input
                    label="授权回调 URL"
                    placeholder="http://localhost:1455/auth/callback?code=...&state=..."
                    value={manualCallback}
                    onChange={e => setManualCallback(e.target.value)}
                  />
                  <Button type="button" variant="primary" onClick={handleSubmitManualCallback}
                    disabled={submittingManual || saving}
                    style={{ width: '100%' }}>
                    {submittingManual ? '提交中...' : '提交'}
                  </Button>
                </div>
              )}

              {oauthStatus === 'success' && (
                <p style={{ color: 'var(--success)', fontSize: '0.85rem', textAlign: 'center', padding: '1rem 0' }}>
                  已登录: {oauthEmail}
                </p>
              )}
              {oauthStatus === 'failed' && (
                <Button type="button" variant="primary" onClick={handleOAuthLogin}
                  style={{ width: '100%', marginTop: '0.5rem' }}>
                  重新登录
                </Button>
              )}
            </>
          ) : (
            <>
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
            </>
          )}
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

          <Button type="submit" variant="primary" disabled={saving || !name || !endpoint || !manualApiKey}
            style={{ width: '100%', marginTop: '0.5rem' }}>
            {saving ? '创建中...' : '创建'}
          </Button>
        </form>
      )}
    </div>
  )
}
