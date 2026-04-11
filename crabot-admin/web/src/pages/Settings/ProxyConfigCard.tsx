import React, { useState, useEffect } from 'react'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { useToast } from '../../contexts/ToastContext'
import { proxyService, type ProxyConfig } from '../../services/proxy'

export const ProxyConfigCard: React.FC = () => {
  const [mode, setMode] = useState<ProxyConfig['mode']>('system')
  const [customUrl, setCustomUrl] = useState('')
  const [systemProxyUrl, setSystemProxyUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const toast = useToast()

  useEffect(() => {
    proxyService.getConfig()
      .then(({ config, system_proxy_url }) => {
        setMode(config.mode)
        setCustomUrl(config.custom_url ?? '')
        setSystemProxyUrl(system_proxy_url)
      })
      .catch(() => {
        toast.error('加载代理配置失败')
      })
      .finally(() => setLoading(false))
  }, [toast])

  const handleSave = () => {
    if (mode === 'custom' && !customUrl.trim()) {
      toast.error('请输入代理地址')
      return
    }
    if (mode === 'custom' && !/^(https?|socks5):\/\/.+/.test(customUrl.trim())) {
      toast.error('代理地址格式不正确，需要以 http://, https:// 或 socks5:// 开头')
      return
    }

    setSaving(true)
    const config: ProxyConfig = {
      mode,
      ...(mode === 'custom' ? { custom_url: customUrl.trim() } : {}),
    }

    proxyService.updateConfig(config)
      .then(() => {
        toast.success('代理配置已更新并推送至所有模块')
      })
      .catch(() => {
        toast.error('更新代理配置失败')
      })
      .finally(() => setSaving(false))
  }

  if (loading) {
    return (
      <Card title="网络代理">
        <p style={{ color: 'var(--text-secondary)' }}>加载中...</p>
      </Card>
    )
  }

  return (
    <Card title="网络代理">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {/* Radio: system */}
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', cursor: 'pointer' }}>
          <input
            type="radio"
            name="proxy_mode"
            value="system"
            checked={mode === 'system'}
            onChange={() => setMode('system')}
            style={{ marginTop: '0.2rem' }}
          />
          <div>
            <div style={{ fontWeight: 500 }}>系统代理</div>
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
              读取环境变量 HTTPS_PROXY / HTTP_PROXY
            </div>
          </div>
        </label>

        {mode === 'system' && (
          <div style={{
            marginLeft: '1.5rem',
            padding: '0.5rem 0.75rem',
            backgroundColor: 'var(--bg-secondary, #f8f9fa)',
            borderRadius: '4px',
            fontSize: '0.85rem',
            color: 'var(--text-secondary)',
          }}>
            {systemProxyUrl
              ? <><span>当前系统代理：</span><code>{systemProxyUrl}</code></>
              : '未检测到系统代理环境变量'}
          </div>
        )}

        {/* Radio: custom */}
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', cursor: 'pointer' }}>
          <input
            type="radio"
            name="proxy_mode"
            value="custom"
            checked={mode === 'custom'}
            onChange={() => setMode('custom')}
            style={{ marginTop: '0.2rem' }}
          />
          <div>
            <div style={{ fontWeight: 500 }}>自定义代理</div>
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
              指定代理服务器地址
            </div>
          </div>
        </label>

        {mode === 'custom' && (
          <div style={{ marginLeft: '1.5rem' }}>
            <input
              type="text"
              value={customUrl}
              onChange={e => setCustomUrl(e.target.value)}
              placeholder="http://127.0.0.1:7890"
              style={{
                width: '100%',
                maxWidth: '400px',
                padding: '0.5rem 0.75rem',
                border: '1px solid var(--border-color, #dee2e6)',
                borderRadius: '4px',
                fontSize: '0.9rem',
              }}
            />
          </div>
        )}

        {/* Radio: none */}
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', cursor: 'pointer' }}>
          <input
            type="radio"
            name="proxy_mode"
            value="none"
            checked={mode === 'none'}
            onChange={() => setMode('none')}
            style={{ marginTop: '0.2rem' }}
          />
          <div>
            <div style={{ fontWeight: 500 }}>不使用代理</div>
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
              直接连接
            </div>
          </div>
        </label>

        {/* Save button */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? '保存中...' : '保存'}
          </Button>
        </div>
      </div>
    </Card>
  )
}
