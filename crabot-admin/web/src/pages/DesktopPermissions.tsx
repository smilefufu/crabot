import { Link } from 'react-router-dom'
import { MainLayout } from '../components/Layout/MainLayout'
import { ComputerUseSetupCard } from './Settings/ComputerUseSetupCard'

export function DesktopPermissions() {
  return <MainLayout>
    <h1>权限与能力</h1>
    <p style={{ color: 'var(--text-secondary)', margin: '12px 0 24px', lineHeight: 1.7 }}>
      基础聊天、脚本和内置浏览器不需要屏幕或辅助功能授权。使用桌面控制时，再开始下方设置；拒绝或暂时跳过仍可继续聊天。
    </p>
    <ComputerUseSetupCard />
    <section style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 18 }}>任务权限单独管理</h2>
      <p style={{ color: 'var(--text-secondary)', margin: '12px 0', lineHeight: 1.7 }}>系统授权不会扩大联系人、会话或 Worker 的任务权限。这里不会申请麦克风或摄像头；音视频渠道按自身流程设置。</p>
      <Link to="/permission-templates">管理任务权限模板</Link>
    </section>
  </MainLayout>
}
