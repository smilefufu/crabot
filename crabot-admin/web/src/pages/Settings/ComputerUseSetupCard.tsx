import React, { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { useToast } from '../../contexts/ToastContext'
import { computerUseService, desktopErrorText, desktopStatusText, setupRunning, type ComputerUseSetupStatus } from '../../services/computerUse'
import './ComputerUseSetupCard.css'

const permissionText = { granted: '已授权', missing: '待授权', unknown: '尚未确认', not_applicable: '不适用' }
const platformText: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }

export const ComputerUseSetupCard: React.FC = () => {
  const [status, setStatus] = useState<ComputerUseSetupStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const alive = useRef(true)
  const sequence = useRef(0)
  const polling = useRef(false)
  const setupId = useRef<string | undefined>(undefined)
  const toast = useToast()

  const accept = (value: ComputerUseSetupStatus, serial: number) => {
    if (!alive.current) {
      if (setupRunning(value)) void computerUseService.cancel(value.setup!.setup_id).catch(() => {})
      return
    }
    if (serial !== sequence.current) return
    setStatus(value)
    setupId.current = setupRunning(value) ? value.setup!.setup_id : undefined
    setError(undefined)
  }
  const check = async () => {
    if (polling.current) return
    polling.current = true
    const serial = ++sequence.current
    try { accept(await computerUseService.status(), serial) }
    catch (failure) { if (alive.current && serial === sequence.current) setError(desktopErrorText(failure instanceof Error ? failure.message : undefined)) }
    finally { polling.current = false }
  }
  useEffect(() => {
    alive.current = true
    void check()
    if (window.location.hash === '#computer-use') document.getElementById('computer-use')?.scrollIntoView?.()
    const exit = () => { if (setupId.current) void computerUseService.cancel(setupId.current, true).catch(() => {}) }
    window.addEventListener('pagehide', exit)
    return () => {
      window.removeEventListener('pagehide', exit)
      alive.current = false
      if (setupId.current) void computerUseService.cancel(setupId.current).catch(() => {})
    }
  }, [])
  const running = setupRunning(status)
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => { void check() }, 2000)
    return () => clearInterval(timer)
  }, [running])

  const start = async () => {
    setOpen(true); setLoading(true)
    const serial = ++sequence.current
    try { accept(await computerUseService.start(), serial) }
    catch (failure) { if (alive.current) setError(desktopErrorText(failure instanceof Error ? failure.message : undefined)) }
    finally { if (alive.current) setLoading(false) }
  }
  const close = async () => {
    setOpen(false)
    const id = setupId.current
    if (!id) return
    setLoading(true)
    const serial = ++sequence.current
    try { accept(await computerUseService.cancel(id), serial) }
    catch (failure) { if (alive.current) setError(desktopErrorText(failure instanceof Error ? failure.message : undefined)) }
    finally { if (alive.current) setLoading(false) }
  }

  const blocked = !status?.enabled || !status.standard || status.host.session !== 'active' || status.runtime.state === 'quarantined'
  const detail = error ?? desktopErrorText(status?.setup?.reason ?? status?.reason ?? (running ? undefined : status?.runtime.reason) ?? status?.capture.reason)
  const nativeCheck = (name: string) => {
    const check = status?.runtime.checks?.find(item => item.name === name)
    return check?.status === 'pass' ? '已通过' : check?.status === 'fail' ? '未通过' : check?.status === 'skip' ? '未执行' : '尚未确认'
  }
  return (
    <Card title="桌面控制" className="settings-card">
      <section id="computer-use" className="computer-use-setup" aria-label="桌面控制设置">
        <p className="settings-card__hint">让 Crabot 读取屏幕并操作桌面应用。系统授权完成后会自动验证并连接工具。</p>
        <p role="status">{status ? `${status.enabled ? '已启用 · ' : ''}${desktopStatusText(status)}` : '正在读取实际状态…'}</p>
        {status && <p className="settings-card__hint">设置目标：运行 Crabot 的电脑「{status.host.hostname}」（{platformText[status.host.platform] ?? status.host.platform}）</p>}
        <div className="browser-settings__actions">
          <Button onClick={start} disabled={blocked || loading || running}>{running ? '设置进行中…' : '设置桌面控制'}</Button>
          <Button variant="secondary" onClick={() => { void check() }} disabled={loading}>重新检查</Button>
          {open && <Button variant="secondary" onClick={close} disabled={loading}>{running ? '取消设置' : '收起'}</Button>}
        </div>
        {!status?.enabled && status && <p><Link to="/mcp-servers">管理桌面控制开关</Link></p>}
        {detail && <p role="alert" className="settings-card__hint">{detail}</p>}
        {open && status && (
          <div className="computer-use-setup__steps">
            {status.host.platform === 'darwin' ? <>
              <p>CuaDriver 是 Crabot 使用的桌面控制组件。请在系统提示中为 CuaDriver 批准以下权限。</p>
              <div className="computer-use-setup__step"><strong>1. 辅助功能</strong><span>{permissionText[status.permissions.accessibility]}</span><p>读取控件并执行桌面输入。</p></div>
              <div className="computer-use-setup__step"><strong>2. 屏幕与系统音频录制</strong><span>{permissionText[status.permissions.screen_recording]}</span><p>用于读取截图；桌面控制不录制系统音频。</p></div>
              <div className="computer-use-setup__step"><strong>3. 屏幕访问验证</strong><span>{status.capture.status === 'verified' ? '已验证' : status.capture.status === 'failed' ? '未通过' : '待验证'}</span><p>部分系统版本会再显示一次屏幕访问确认，请按提示批准。</p></div>
            </> : <>
              <p>检查此电脑的图形会话、原生桌面能力与实际截图。系统可能要求确认屏幕访问。</p>
              <div className="computer-use-setup__step"><strong>图形会话</strong><span>{status.host.session === 'active' ? '已检测到' : '尚未确认'}</span></div>
              <div className="computer-use-setup__step"><strong>原生控件读取</strong><span>{nativeCheck('ax_capability')}</span></div>
              <div className="computer-use-setup__step"><strong>屏幕访问验证</strong><span>{status.capture.status === 'verified' ? '已验证' : status.capture.status === 'failed' ? '未通过' : '待验证'}</span></div>
            </>}
            {running && <p>正在自动复查；完成授权后无需重启 Crabot。关闭此面板会取消等待。</p>}
            {status.setup?.phase === 'ready' && <p>桌面环境已就绪，可在新任务中使用。正在运行的任务沿用原有权限和能力。</p>}
            {status.host.platform === 'darwin' && status.app_path && <details>
              <summary>系统列表里没有 CuaDriver？</summary>
              <p>显示应用后，在系统权限页面添加 CuaDriver；也可以复制下面的实际路径。</p>
              <div className="browser-settings__actions">
                <Button variant="secondary" onClick={() => { void computerUseService.reveal().catch(() => toast.error('无法定位应用，请复制下方路径。')) }}>在 Finder 中显示应用</Button>
                <Button variant="secondary" onClick={() => { if (!navigator.clipboard) { toast.error('请选中下方路径复制。'); return }; void navigator.clipboard.writeText(status.app_path!).then(() => toast.success('应用路径已复制')).catch(() => toast.error('请选中下方路径复制。')) }}>复制应用路径</Button>
              </div>
              <code className="computer-use-setup__path">{status.app_path}</code>
            </details>}
          </div>
        )}
      </section>
    </Card>
  )
}
