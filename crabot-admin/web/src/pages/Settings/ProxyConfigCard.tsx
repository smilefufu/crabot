import React, { useState, useEffect } from 'react'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { useToast } from '../../contexts/ToastContext'
import { proxyService, type ProxyConfig } from '../../services/proxy'

type ProxyMode = ProxyConfig['mode']

const MODES: ReadonlyArray<{ value: ProxyMode; title: string; hint: string }> = [
  { value: 'system', title: '系统代理', hint: '优先使用代理环境变量；macOS 无变量时读取系统 HTTP/HTTPS 代理' },
  { value: 'custom', title: '自定义代理', hint: '指定代理服务器地址' },
  { value: 'none', title: '不使用代理', hint: '直接连接' },
]

export const ProxyConfigCard: React.FC = () => {
  const [mode, setMode] = useState<ProxyMode>('system')
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
      .then(async () => {
        toast.success('代理配置已保存并应用')
        if (config.mode !== 'system') { setSystemProxyUrl(null); return }
        try {
          const current = await proxyService.getConfig()
          setSystemProxyUrl(current.system_proxy_url)
        } catch {
          setSystemProxyUrl(null)
          toast.error('配置已保存，但代理检测结果读取失败，请重新打开此页面查看')
        }
      })
      .catch(() => {
        toast.error('更新代理配置失败')
      })
      .finally(() => setSaving(false))
  }

  if (loading) {
    return (
      <Card title="网络代理">
        <p className="proxy-config__status">加载中…</p>
      </Card>
    )
  }

  return (
    <Card title="网络代理">
      <div className="proxy-config" role="radiogroup" aria-label="代理模式">
        {MODES.map((m) => (
          <React.Fragment key={m.value}>
            <label className={`proxy-config__option${mode === m.value ? ' proxy-config__option--active' : ''}`}>
              <input
                type="radio"
                name="proxy_mode"
                value={m.value}
                checked={mode === m.value}
                onChange={() => setMode(m.value)}
                className="proxy-config__radio"
              />
              <div className="proxy-config__option-body">
                <div className="proxy-config__option-title">{m.title}</div>
                <div className="proxy-config__option-hint">{m.hint}</div>
              </div>
            </label>

            {m.value === 'system' && mode === 'system' && (
              <div className="proxy-config__detail">
                {systemProxyUrl
                  ? <>当前系统代理：<code>{systemProxyUrl}</code></>
                  : '未检测到可用的系统代理；可检查系统设置或使用自定义代理。'}
                <p>系统代理更改后，点击“保存”重新检测并应用。暂不支持 PAC 自动配置和仅 SOCKS 的系统代理。</p>
              </div>
            )}

            {m.value === 'custom' && mode === 'custom' && (
              <div className="proxy-config__detail">
                <input
                  type="text"
                  className="input proxy-config__input"
                  value={customUrl}
                  onChange={(e) => setCustomUrl(e.target.value)}
                  placeholder="http://127.0.0.1:7890"
                  aria-label="代理服务器地址"
                />
              </div>
            )}
          </React.Fragment>
        ))}

        <div className="proxy-config__actions">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </div>
    </Card>
  )
}
