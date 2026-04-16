import React, { useState, useEffect, useCallback } from 'react'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { Loading } from '../../components/Common/Loading'
import { useToast } from '../../contexts/ToastContext'
import { api } from '../../services/api'
import { browserService } from '../../services/browser'
import { ProxyConfigCard } from './ProxyConfigCard'

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
        toast.error('Failed to load browser config')
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
      <div style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 700 }}>全局设置</h1>
      </div>

      {status && !status.configured && (
        <div style={{
          backgroundColor: 'var(--warning-bg, #fff3cd)',
          border: '1px solid var(--warning-border, #ffc107)',
          borderRadius: '4px',
          padding: '1rem',
          marginBottom: '1.5rem',
        }}>
          <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '1.1rem', fontWeight: 600 }}>配置清单</h3>
          <ul style={{ margin: '0.5rem 0', paddingLeft: '1.5rem' }}>
            {(status.missing ?? []).map(msg => (
              <li key={msg} style={{ color: 'var(--error-color, #dc3545)' }}>❌ {msg}</li>
            ))}
            {(status.warnings ?? []).map(msg => (
              <li key={msg} style={{ color: 'var(--warning-color, #ffc107)' }}>⚠️ {msg}</li>
            ))}
          </ul>
        </div>
      )}

      <Card>
        <p style={{ color: 'var(--text-secondary)' }}>
          默认模型配置已移至"模型供应商"页面顶部。
        </p>
      </Card>

      <div style={{ marginTop: '1.5rem' }}>
        <Card title="浏览器管理">
          {browserLoading ? (
            <Loading />
          ) : browser ? (
            <div>
              {/* Profile mode selection */}
              <div style={{ marginBottom: '1.5rem' }}>
                <label style={{
                  display: 'block',
                  fontWeight: 600,
                  marginBottom: '0.75rem',
                  fontSize: '0.95rem',
                }}>
                  Profile 模式
                </label>

                <label style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '0.5rem',
                  cursor: 'pointer',
                  marginBottom: '0.75rem',
                }}>
                  <input
                    type="radio"
                    name="profile_mode"
                    value="isolated"
                    checked={browser.profile_mode === 'isolated'}
                    onChange={() => handleProfileModeChange('isolated')}
                    style={{ marginTop: '0.2rem' }}
                  />
                  <div>
                    <div style={{ fontWeight: 500 }}>独立 Profile</div>
                    <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                      Crabot 专属浏览器配置，不影响日常使用的 Chrome
                    </div>
                  </div>
                </label>

                <label style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '0.5rem',
                  cursor: 'pointer',
                  marginBottom: '0.75rem',
                }}>
                  <input
                    type="radio"
                    name="profile_mode"
                    value="user"
                    checked={browser.profile_mode === 'user'}
                    onChange={() => handleProfileModeChange('user')}
                    style={{ marginTop: '0.2rem' }}
                  />
                  <div>
                    <div style={{ fontWeight: 500 }}>复用用户 Profile</div>
                    <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                      使用系统 Chrome 的登录状态和配置
                    </div>
                  </div>
                </label>

                {browser.profile_mode === 'user' && (
                  <div style={{
                    backgroundColor: 'var(--warning-bg, #fff3cd)',
                    border: '1px solid var(--warning-border, #ffc107)',
                    borderRadius: '4px',
                    padding: '0.75rem 1rem',
                    fontSize: '0.85rem',
                    lineHeight: 1.5,
                    marginTop: '0.5rem',
                  }}>
                    ⚠️ 启用复用模式后，Crabot 启动浏览器时会关闭当前正在运行的 Chrome。未保存的标签页和表单数据将丢失。
                  </div>
                )}
              </div>

              {/* Status and controls */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                borderTop: '1px solid var(--border-color, #e0e0e0)',
                paddingTop: '1rem',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{
                    display: 'inline-block',
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    backgroundColor: browser.is_running
                      ? 'var(--success-color, #28a745)'
                      : 'var(--text-secondary, #6c757d)',
                  }} />
                  <span style={{ fontSize: '0.9rem' }}>
                    {browser.is_running
                      ? `运行中 (CDP port: ${browser.cdp_port})`
                      : '已停止'}
                  </span>
                </div>

                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  {browser.is_running ? (
                    <Button
                      variant="danger"
                      onClick={handleBrowserStop}
                      disabled={browserActionLoading}
                    >
                      {browserActionLoading ? '停止中...' : '停止浏览器'}
                    </Button>
                  ) : (
                    <Button
                      variant="success"
                      onClick={handleBrowserStart}
                      disabled={browserActionLoading}
                    >
                      {browserActionLoading ? '启动中...' : '启动浏览器'}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <p style={{ color: 'var(--text-secondary)' }}>
              无法加载浏览器配置
            </p>
          )}
        </Card>
      </div>

      <div style={{ marginTop: '1.5rem' }}>
        <ProxyConfigCard />
      </div>
    </MainLayout>
  )
}
