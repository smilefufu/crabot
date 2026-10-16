import React, { useState, useEffect, useCallback } from 'react'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { Loading } from '../../components/Common/Loading'
import { useToast } from '../../contexts/ToastContext'
import { api } from '../../services/api'
import { browserService } from '../../services/browser'
import { ProxyConfigCard } from './ProxyConfigCard'
import { PublicBaseUrlCard } from './PublicBaseUrlCard'
import { VersionUpgradeCard } from './VersionUpgradeCard'
import { ComputerUseSetupCard } from './ComputerUseSetupCard'

interface ConfigStatus {
  configured: boolean
  missing: string[]
  warnings: string[]
}

interface BrowserState {
  profile_mode: string
  cdp_port: number
  is_running: boolean
}

export const GlobalSettings: React.FC = () => {
  const [status, setStatus] = useState<ConfigStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [browser, setBrowser] = useState<BrowserState | null>(null)
  const [browserLoading, setBrowserLoading] = useState(true)
  const [browserActionLoading, setBrowserActionLoading] = useState(false)
  const toast = useToast()

  useEffect(() => {
    api.get<ConfigStatus>('/config/status')
      .then(setStatus)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const loadBrowserConfig = useCallback(() => {
    setBrowserLoading(true)
    browserService.getConfig()
      .then(setBrowser)
      .catch(() => {
        toast.error('加载浏览器配置失败')
      })
      .finally(() => setBrowserLoading(false))
  }, [toast])

  useEffect(() => {
    loadBrowserConfig()
  }, [loadBrowserConfig])

  const handleProfileModeChange = (mode: string) => {
    if (!browser) return
    setBrowser({ ...browser, profile_mode: mode })
    browserService.updateConfig({ profile_mode: mode })
      .then(() => {
        toast.success('Profile 模式已更新')
      })
      .catch(() => {
        toast.error('更新失败')
        loadBrowserConfig()
      })
  }

  const handleBrowserStart = () => {
    setBrowserActionLoading(true)
    browserService.start()
      .then(() => {
        toast.success('浏览器已启动')
        loadBrowserConfig()
      })
      .catch(() => {
        toast.error('启动浏览器失败')
      })
      .finally(() => setBrowserActionLoading(false))
  }

  const handleBrowserStop = () => {
    setBrowserActionLoading(true)
    browserService.stop()
      .then(() => {
        toast.success('浏览器已停止')
        loadBrowserConfig()
      })
      .catch(() => {
        toast.error('停止浏览器失败')
      })
      .finally(() => setBrowserActionLoading(false))
  }

  if (loading) return <MainLayout><Loading /></MainLayout>

  return (
    <MainLayout>
      <header className="settings-page__header">
        <h1 className="settings-page__title">全局设置</h1>
        <p className="settings-page__subtitle">默认模型、浏览器、对外访问地址和网络代理的配置。</p>
      </header>

      {status && !status.configured && (
        <Card variant="outlined" className="settings-warning-card">
          <div className="settings-warning__title">配置清单</div>
          <ul className="settings-warning__list">
            {(status.missing ?? []).map(msg => (
              <li key={msg} className="settings-warning__item settings-warning__item--error">
                ❌ {msg}
              </li>
            ))}
            {(status.warnings ?? []).map(msg => (
              <li key={msg} className="settings-warning__item settings-warning__item--warn">
                ⚠️ {msg}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="settings-card">
        <p className="settings-card__hint">
          默认模型配置已移至「模型供应商」页面顶部。
        </p>
      </Card>

      <ComputerUseSetupCard />

      <Card title="浏览器管理" className="settings-card">
        {browserLoading ? (
          <Loading />
        ) : browser ? (
          <div className="browser-settings">
            <fieldset className="browser-settings__group">
              <legend className="browser-settings__group-title">Profile 模式</legend>

              <label className="browser-settings__option">
                <input
                  type="radio"
                  name="profile_mode"
                  value="isolated"
                  checked={browser.profile_mode === 'isolated'}
                  onChange={() => handleProfileModeChange('isolated')}
                />
                <div className="browser-settings__option-body">
                  <div className="browser-settings__option-title">独立 Profile</div>
                  <div className="browser-settings__option-hint">
                    Crabot 专属浏览器配置，不影响日常使用的 Chrome
                  </div>
                </div>
              </label>

              <label className="browser-settings__option">
                <input
                  type="radio"
                  name="profile_mode"
                  value="user"
                  checked={browser.profile_mode === 'user'}
                  onChange={() => handleProfileModeChange('user')}
                />
                <div className="browser-settings__option-body">
                  <div className="browser-settings__option-title">复用用户 Profile</div>
                  <div className="browser-settings__option-hint">
                    使用系统 Chrome 的登录状态和配置
                  </div>
                </div>
              </label>

              {browser.profile_mode === 'user' && (
                <div className="browser-settings__warning" role="alert">
                  ⚠️ 启用复用模式后，Crabot 启动浏览器时会关闭当前正在运行的 Chrome。未保存的标签页和表单数据将丢失。
                </div>
              )}
            </fieldset>

            <div className="browser-settings__status-row">
              <div className="browser-settings__status">
                <span
                  className={`browser-settings__dot${browser.is_running ? ' browser-settings__dot--running' : ''}`}
                  aria-hidden="true"
                />
                <span>
                  {browser.is_running
                    ? `运行中（CDP port ${browser.cdp_port}）`
                    : '已停止'}
                </span>
              </div>

              <div className="browser-settings__actions">
                {browser.is_running ? (
                  <Button
                    variant="danger"
                    onClick={handleBrowserStop}
                    disabled={browserActionLoading}
                  >
                    {browserActionLoading ? '停止中…' : '停止浏览器'}
                  </Button>
                ) : (
                  <Button
                    variant="success"
                    onClick={handleBrowserStart}
                    disabled={browserActionLoading}
                  >
                    {browserActionLoading ? '启动中…' : '启动浏览器'}
                  </Button>
                )}
              </div>
            </div>
          </div>
        ) : (
          <p className="settings-card__hint">无法加载浏览器配置</p>
        )}
      </Card>

      <div className="settings-card">
        <PublicBaseUrlCard />
      </div>

      <div className="settings-card">
        <ProxyConfigCard />
      </div>

      <div className="settings-card">
        <VersionUpgradeCard />
      </div>
    </MainLayout>
  )
}
