import React, { useState, useEffect } from 'react'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { useToast } from '../../contexts/ToastContext'
import { providerService } from '../../services/provider'
import type { GlobalModelConfig } from '../../types'

export const PublicBaseUrlCard: React.FC = () => {
  const [config, setConfig] = useState<GlobalModelConfig>({})
  const [publicBaseUrl, setPublicBaseUrl] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [filledFromCurrent, setFilledFromCurrent] = useState(false)
  const toast = useToast()

  useEffect(() => {
    providerService.getGlobalConfig()
      .then((cfg) => {
        setConfig(cfg)
        setPublicBaseUrl(cfg.public_base_url ?? '')
      })
      .catch(() => {
        toast.error('加载对外访问地址失败')
      })
      .finally(() => setLoading(false))
  }, [toast])

  const handleReadCurrent = () => {
    setPublicBaseUrl(window.location.origin)
    setFilledFromCurrent(true)
  }

  const handleSave = () => {
    setSaving(true)
    const trimmed = publicBaseUrl.trim()
    providerService.updateGlobalConfig({
      ...config,
      public_base_url: trimmed || undefined,
    })
      .then((updated) => {
        setConfig(updated)
        setPublicBaseUrl(updated.public_base_url ?? '')
        toast.success('对外访问地址已保存')
      })
      .catch(() => {
        toast.error('保存对外访问地址失败')
      })
      .finally(() => setSaving(false))
  }

  if (loading) {
    return (
      <Card title="对外访问地址">
        <p className="settings-card__hint">加载中…</p>
      </Card>
    )
  }

  return (
    <Card title="对外访问地址">
      <div className="public-base-url">
        <p className="settings-card__hint">
          别人（包括非本机的人）打开临时页面时用的对外地址。CRABOT 会用它拼出页面链接发给对方。留空则退化为本机地址，仅本机可访问。
        </p>

        <div className="public-base-url__row">
          <input
            type="text"
            className="input public-base-url__input"
            value={publicBaseUrl}
            onChange={(e) => {
              setPublicBaseUrl(e.target.value)
              setFilledFromCurrent(false)
            }}
            placeholder="https://your-host.example.com"
            aria-label="对外访问地址"
          />
          <Button
            variant="secondary"
            onClick={handleReadCurrent}
            disabled={saving}
          >
            读取当前地址
          </Button>
        </div>

        {filledFromCurrent && (
          <p className="public-base-url__warning" role="note">
            已填入当前访问地址；请确认它对别人也可达。
          </p>
        )}

        <div className="public-base-url__actions">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </div>
    </Card>
  )
}
