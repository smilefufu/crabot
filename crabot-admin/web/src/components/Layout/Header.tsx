import React from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { Button } from '../Common/Button'

const PAGE_NAMES: { path: string; name: string }[] = [
  { path: '/chat', name: '聊天' },
  { path: '/providers', name: '模型供应商' },
  { path: '/modules', name: '模块管理' },
  { path: '/memory', name: '记忆管理' },
  { path: '/dialog-objects', name: '对话对象管理' },
  { path: '/agents', name: 'Agent 配置' },
  { path: '/mcp-servers', name: 'MCP Servers' },
  { path: '/skills', name: 'Skills' },

  { path: '/channels', name: 'Channel 配置' },
  { path: '/settings', name: '全局设置' },
]

export const Header: React.FC = () => {
  const { logout } = useAuth()
  const location = useLocation()

  const pageName = PAGE_NAMES.find(p => location.pathname.startsWith(p.path))?.name ?? 'Crabot'

  return (
    <header className="app-header">
      <span className="app-header-page">{pageName}</span>
      <Button variant="secondary" onClick={logout}>退出</Button>
    </header>
  )
}
