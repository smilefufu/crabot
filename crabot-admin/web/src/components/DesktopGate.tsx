import { useEffect, useRef, useState, type ReactNode } from 'react'
import { desktopBridge, isDesktop, useDesktopState } from '../services/desktop-host'
import './DesktopGate.css'

const titles = { discovering: '正在发现本机服务', starting: '正在启动 Crabot', stopping: '正在停止服务', authenticating: '正在建立本机连接',
  stopped: 'Crabot 服务已停止', disconnected: '与本机服务的连接已断开', migration_required: '发现已有 Crabot 部署', error: 'Crabot 暂时无法启动', ready: 'Crabot 已就绪' }
export function DesktopGate({ children }: { children: ReactNode }) {
  const state = useDesktopState(), opened = useRef(false)
  const [stalled, setStalled] = useState(false)
  useEffect(() => {
    if (!isDesktop || state) return
    const timer = setTimeout(() => setStalled(true), 6000)
    return () => clearTimeout(timer)
  }, [state])
  if (!isDesktop) return <>{children}</>
  if (state?.phase === 'ready') opened.current = true
  const phase = state?.phase ?? (!desktopBridge || stalled ? 'error' : 'discovering')
  const busy = ['discovering', 'starting', 'stopping', 'authenticating'].includes(phase)
  return <>
    {opened.current && <div hidden={phase !== 'ready'}>{children}</div>}
    {phase !== 'ready' && <main className="desktop-status" aria-live="polite">
      <section className="desktop-status-card">
        <div className="desktop-mark" aria-hidden="true">C</div>
        <h1>{titles[phase]}</h1>
        <p>{!desktopBridge ? '本地界面连接未能加载。请重新启动 Crabot；仍无法恢复时请修复安装。' : stalled && !state
          ? '无法读取本机状态。可重新检查连接，或从应用菜单重新启动。'
          : state?.phase !== 'ready' && state?.message || '请稍候，正在检查当前用户的本机实例。'}</p>
        {!busy && desktopBridge && <div className="desktop-status-actions">
          {phase !== 'migration_required' && <button onClick={() => { void desktopBridge!.startService() }}>启动服务</button>}
          <button className="secondary" onClick={() => { void desktopBridge!.reconnect() }}>重新检查连接</button>
          <button className="secondary" onClick={() => { void desktopBridge!.revealDataFolder() }}>打开数据与日志目录</button>
        </div>}
        {state && state.phase !== 'ready' && state.code && <p className="desktop-status-code">诊断代码：{state.code}</p>}
        <p className="desktop-status-hint">关闭窗口后继续后台运行；退出 Crabot 会停止共享服务。</p>
      </section>
    </main>}
  </>
}
