import React, { useState, useEffect } from 'react'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { useToast } from '../../contexts/ToastContext'
import { providerService } from '../../services/provider'
import type { GlobalModelConfig } from '../../types'

const DEFAULT_DAYS = 7

export const ObservabilityRetentionCard: React.FC = () => {
  const [config, setConfig] = useState<GlobalModelConfig>({})
  const [days, setDays] = useState(String(DEFAULT_DAYS))
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const toast = useToast()

  useEffect(() => {
    providerService.getGlobalConfig()
      .then((cfg) => {
        setConfig(cfg)
        setDays(String(cfg.observability_retention_days ?? DEFAULT_DAYS))
      })
      .catch(() => {
        toast.error('加载观测历史保留天数失败')
      })
      .finally(() => setLoading(false))
  }, [toast])

  const parsed = Number.parseInt(days, 10)
  const valid = Number.isFinite(parsed) && parsed >= 1 && parsed <= 365

  const handleSave = () => {
    if (!valid) return
    setSaving(true)
    providerService.updateGlobalConfig({
      ...config,
      observability_retention_days: parsed,
    })
      .then((updated) => {
        setConfig(updated)
        setDays(String(updated.observability_retention_days ?? DEFAULT_DAYS))
        toast.success('观测历史保留天数已保存')
      })
      .catch(() => {
        toast.error('保存观测历史保留天数失败')
      })
      .finally(() => setSaving(false))
  }

  if (loading) {
    return (
      <Card title="观测历史保留">
        <p className="settings-card__hint">加载中…</p>
      </Card>
    )
  }

  return (
    <Card title="观测历史保留">
      <div className="public-base-url">
        <p className="settings-card__hint">
          主控与执行器的 trace、episode 和运行时历史超过该天数后自动清理。活跃 trace 不会被删；默认 {DEFAULT_DAYS} 天，最小 1 天。工作区文件不受影响。
        </p>
        <div className="public-base-url__row">
          <input
            type="number"
            min={1}
            max={365}
            className="input public-base-url__input"
            value={days}
            onChange={(e) => setDays(e.target.value)}
            aria-label="观测历史保留天数"
          />
          <span className="settings-card__hint">天</span>
          <Button onClick={handleSave} disabled={saving || !valid}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </div>
    </Card>
  )
}
