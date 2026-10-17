import { useCallback, useEffect, useRef, useState } from 'react'
import type { DesktopDiagnostics } from 'crabot-client'
import { desktopBridge } from '../services/desktop-host'
import { Button } from './Common/Button'
import './DesktopDiagnosticsPanel.css'

const resources = { browser: '内置浏览器', computer_use: '桌面控制组件', native_helper: '本机进程校验组件' }
export function DesktopDiagnosticsPanel() {
  const bridge = desktopBridge
  const [report, setReport] = useState<DesktopDiagnostics | null>(null)
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  const request = useRef(0)
  const refresh = useCallback(async () => {
    if (!bridge) return
    const sequence = ++request.current
    setBusy(true); setNotice('')
    try { const value = await bridge.getDiagnostics(); if (sequence === request.current) setReport(value) }
    catch { if (sequence === request.current) setNotice('本地诊断暂时无法读取，可重新检查或修复安装。') }
    finally { if (sequence === request.current) setBusy(false) }
  }, [bridge])
  useEffect(() => { void refresh(); return () => { request.current++ } }, [refresh])
  if (!bridge) return <p>请在本机 Crabot 应用中打开诊断。</p>
  const exportReport = async () => {
    if (!report) return
    setBusy(true); setNotice('')
    try { setNotice(await bridge.exportDiagnostics(report.report_id) ? '诊断文件已保存。' : '本次没有保存文件。可重新检查诊断后再导出。') }
    catch { setNotice('未能保存诊断文件，请重新选择可写位置。') }
    finally { setBusy(false) }
  }
  return <section className="desktop-diagnostics" aria-label="本地诊断">
    <h2>本地诊断</h2>
    <p>服务无法启动时，也可以检查应用组件并导出基础诊断。</p>
    <div className="desktop-diagnostics-actions">
      <Button variant="secondary" disabled={busy} onClick={() => { void refresh() }}>{busy ? '正在处理…' : '重新检查'}</Button>
      <Button variant="secondary" disabled={busy || !report} onClick={() => { void exportReport() }}>导出基础诊断</Button>
      <Button variant="secondary" onClick={() => { void bridge.revealDataFolder() }}>打开数据与日志目录</Button>
    </div>
    {notice && <p role="status">{notice}</p>}
    {report && <>
      <dl>
        <dt>应用版本</dt><dd>{report.state.app_version}</dd>
        <dt>报告时间</dt><dd>{report.created_at}</dd>
        <dt>系统</dt><dd>{report.system.platform} · {report.system.arch} · {report.system.os_release}</dd>
        <dt>当前阶段</dt><dd>{report.state.phase}{'code' in report.state && report.state.code ? ` · ${report.state.code}` : ''}</dd>
        <dt>内置环境</dt><dd>{report.runtime.status === 'entry_checked' ? '入口文件已检查' : '入口检查未通过，请修复安装'}</dd>
        {report.resources.map(resource => <div className="desktop-diagnostics-row" key={resource.name}><dt>{resources[resource.name]}</dt><dd>{resource.status === 'entry_checked' ? '入口已检查' : '组件不可用，请修复安装'}</dd></div>)}
      </dl>
      <p>组件检查不代表模型、系统授权或实际桌面任务已通过。基础诊断不包含聊天、密钥、用户路径和原始日志，也不会自动上传。</p>
      <details><summary>查看将导出的内容</summary><pre>{JSON.stringify(report, null, 2)}</pre></details>
    </>}
  </section>
}
