import React, { useEffect, useRef, useState } from 'react'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { useToast } from '../../contexts/ToastContext'
import { useSystemVersion, pollVersion } from '../../hooks/useSystemVersion'
import { versionService, type VersionState } from '../../services/version'
import { desktopBridge, isDesktop, useDesktopState } from '../../services/desktop-host'

type Phase = 'idle' | 'starting' | 'upgrading' | 'restarting' | 'success' | 'failed' | 'timeout'

const POLL_INTERVAL = 3000
const TIMEOUT_MS = 5 * 60 * 1000

export const VersionUpgradeCard: React.FC = () => isDesktop ? <DesktopVersionUpgradeCard /> : <ServerVersionUpgradeCard />

const DesktopVersionUpgradeCard: React.FC = () => {
  const state = useDesktopState(), toast = useToast()
  const [opening, setOpening] = useState(false)
  const open = async () => {
    setOpening(true)
    try {
      if (!await desktopBridge?.openUpdateDialog()) throw new Error('未能打开本机更新界面，请从 Crabot 菜单重试。')
    } catch (error) { toast.error(error instanceof Error ? error.message : '未能打开本机更新界面。') }
    finally { setOpening(false) }
  }
  return <Card title="版本与升级"><div className="version-card">
    <div className="version-card__row"><span className="version-card__label">桌面应用版本</span><span className="version-card__value">{state?.app_version ?? '正在读取…'}</span></div>
    <p className="version-card__hint">更新包含应用和内置运行环境。下载期间可以继续使用，安装前会请你确认并停止共享服务。</p>
    <Button variant="secondary" onClick={open} disabled={opening}>{opening ? '正在打开…' : '打开桌面更新'}</Button>
  </div></Card>
}

const ServerVersionUpgradeCard: React.FC = () => {
  const { state, refresh } = useSystemVersion()
  const toast = useToast()
  const [checking, setChecking] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // 组件卸载时清理轮询定时器
  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current)
  }, [])

  const handleCheck = () => {
    setChecking(true)
    refresh().finally(() => setChecking(false))
  }

  const startUpgradePolling = (expected: string | null) => {
    const startedAt = Date.now()
    setPhase('upgrading')
    timerRef.current = setInterval(async () => {
      if (Date.now() - startedAt > TIMEOUT_MS) {
        clearInterval(timerRef.current!)
        timerRef.current = null
        setPhase('timeout')
        return
      }
      try {
        const fresh: VersionState = await pollVersion()
        if (fresh.last_upgrade?.phase === 'failed') {
          clearInterval(timerRef.current!)
          timerRef.current = null
          setPhase('failed')
          return
        }
        // 接口恢复且版本已变 → 成功
        if (
          fresh.last_upgrade?.phase === 'done' ||
          (expected && fresh.current_version === expected)
        ) {
          clearInterval(timerRef.current!)
          timerRef.current = null
          setPhase('success')
          toast.success('升级完成')
        }
      } catch {
        // 请求失败 = MM 正在重启，标记 restarting 继续轮询
        setPhase('restarting')
      }
    }, POLL_INTERVAL)
  }

  const handleUpgrade = async () => {
    setPhase('starting')
    try {
      await versionService.startUpgrade()
      startUpgradePolling(state?.latest_version ?? null)
    } catch (err) {
      setPhase('idle')
      toast.error(err instanceof Error ? err.message : '启动升级失败')
    }
  }

  if (!state) {
    return <Card title="版本与升级"><p className="settings-card__hint">加载中…</p></Card>
  }

  const blockers = state.source_blockers ?? []
  const isSystem = state.deploy_mode === 'system'
  const inProgress = phase === 'starting' || phase === 'upgrading' || phase === 'restarting'
  const canUpgrade =
    !isSystem &&
    state.upgrade_available &&
    !(state.install_kind === 'source' && blockers.length > 0)

  return (
    <Card title="版本与升级">
      <div className="version-card">
        <div className="version-card__badges">
          <span className="version-card__badge">{state.deploy_mode === 'user' ? '个人模式' : '团队模式'}</span>
          <span className="version-card__badge">{state.install_kind === 'source' ? '源码安装' : 'release 安装'}</span>
        </div>
        <div className="version-card__row">
          <span className="version-card__label">当前版本</span>
          <span className="version-card__value">{state.current_version ?? '未知'}</span>
        </div>
        <div className="version-card__row">
          <span className="version-card__label">最新版本</span>
          <span className="version-card__value">
            {state.latest_version ?? '未知'}
            {state.upgrade_available && <span className="version-card__tag">有更新</span>}
          </span>
        </div>
        {state.last_checked && (
          <div className="version-card__hint">
            上次检查：{new Date(state.last_checked).toLocaleString()}
          </div>
        )}
        {state.error && <div className="version-card__error">检查更新失败：{state.error}</div>}

        {!isSystem && state.install_kind === 'source' && blockers.length > 0 && (
          <div className="version-card__warning">
            无法一键升级：{blockers.join('；')}。请在终端 <code>git pull && ./dev.sh</code>。
          </div>
        )}

        {inProgress && (
          <div className="version-card__progress">
            {phase === 'restarting' ? '服务正在重启…' : '升级中…'}
          </div>
        )}
        {phase === 'success' && <div className="version-card__ok">升级成功，可刷新页面。</div>}
        {phase === 'failed' && (
          <div className="version-card__error">升级失败，请在终端运行 <code>crabot status</code> 排查。</div>
        )}
        {phase === 'timeout' && (
          <div className="version-card__error">升级超时未恢复，请手动检查 <code>crabot status</code>。</div>
        )}

        {!isSystem && state.install_kind === 'source' && state.upgrade_available && (state.source_blockers?.length ?? 0) === 0 && (
          <div className="version-card__hint">升级将通过 git pull 拉取最新代码并重新构建。</div>
        )}

        <div className="version-card__actions">
          <Button variant="secondary" onClick={handleCheck} disabled={checking || inProgress}>
            {checking ? '检查中…' : '检查更新'}
          </Button>
          {isSystem ? (
            <span className="version-card__sysnote">
              团队模式：请联系管理员在终端运行 <code>sudo crabot upgrade</code>
            </span>
          ) : (
            <Button
              variant="primary"
              onClick={handleUpgrade}
              disabled={!canUpgrade || inProgress}
            >
              {inProgress ? '升级中…' : '升级到最新版本'}
            </Button>
          )}
        </div>
      </div>
    </Card>
  )
}
