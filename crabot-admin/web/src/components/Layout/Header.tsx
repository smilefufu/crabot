import React, { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { Button } from '../Common/Button'
import { ChangePasswordDialog } from '../ChangePasswordDialog'
import { isDesktop } from '../../services/desktop-host'

const PAGE_NAMES: { path: string; name: string }[] = [
  { path: '/desktop/diagnostics', name: '本地诊断' },
  { path: '/desktop/permissions', name: '权限与能力' },
  { path: '/chat', name: '聊天' },
  { path: '/providers', name: '模型服务' },
  { path: '/companion', name: '我的 CRABOT' },
  { path: '/modules', name: '模块管理' },
  { path: '/memory', name: '记忆管理' },
  { path: '/dialog-objects', name: '联系人与群聊' },
  { path: '/agents/workers', name: 'Worker 配置' },
  { path: '/agents', name: '模型分工与执行方式' },
  { path: '/mcp-servers', name: '工具与应用' },
  { path: '/skills', name: '技能' },
  { path: '/subagents', name: '专长助手' },
  { path: '/channels', name: '协作入口' },
  { path: '/traces', name: '运行记录' },
  { path: '/settings', name: '全局设置' },
]

export const Header: React.FC = () => {
  const { logout } = useAuth()
  const location = useLocation()
  const [showDialog, setShowDialog] = useState(false)

  const pageName = PAGE_NAMES.find(p => location.pathname.startsWith(p.path))?.name ?? 'CRABOT'

  return (
    <>
      <header className="app-header">
        <span className="app-header-page">{pageName}</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="secondary" onClick={() => setShowDialog(true)}>{isDesktop ? '浏览器访问密码' : '修改密码'}</Button>
          <Button variant="secondary" onClick={logout}>{isDesktop ? '退出 CRABOT' : '退出'}</Button>
        </div>
      </header>
      {showDialog && <ChangePasswordDialog onClose={() => setShowDialog(false)} />}
    </>
  )
}
