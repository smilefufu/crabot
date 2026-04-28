import React from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useDialogApplications } from '../../contexts/DialogApplicationsContext'

interface NavItem {
  to: string
  label: string
  match: string
}

interface NavSection {
  label: string
  items: NavItem[]
}

const navSections: NavSection[] = [
  {
    label: 'AI 助手',
    items: [
      { to: '/chat', label: '聊天', match: '/chat' },
      { to: '/traces', label: 'Traces', match: '/traces' },
    ],
  },
  {
    label: '模型与 Agent',
    items: [
      { to: '/providers', label: '模型配置', match: '/providers' },
      { to: '/agents/config', label: 'Agent 配置', match: '/agents' },
      { to: '/mcp-servers', label: 'MCP Servers', match: '/mcp-servers' },
      { to: '/skills', label: 'Skills', match: '/skills' },
    ],
  },
  {
    label: '系统',
    items: [
      { to: '/modules', label: '模块管理', match: '/modules' },
      { to: '/channels/config', label: 'Channel 配置', match: '/channels' },
      { to: '/schedules', label: '计划任务', match: '/schedules' },
      { to: '/settings', label: '全局设置', match: '/settings' },
    ],
  },
  {
    label: '社交与数据',
    items: [
      { to: '/dialog-objects', label: '对话对象', match: '/dialog-objects' },
      { to: '/permission-templates', label: '权限模板', match: '/permission-templates' },
      { to: '/memory/long-term', label: '长期记忆', match: '/memory/long-term' },
      { to: '/memory/short-term', label: '短期记忆', match: '/memory/short-term' },
      { to: '/memory/scenes', label: '场景画像', match: '/memory/scenes' },
    ],
  },
]

export const Sidebar: React.FC = () => {
  const location = useLocation()
  const { count: pendingApplicationCount } = useDialogApplications()

  const activeItem = navSections
    .flatMap((section) => section.items)
    .filter((item) => location.pathname.startsWith(item.match))
    .sort((left, right) => right.match.length - left.match.length)[0]

  const isActive = (item: NavItem) => activeItem?.to === item.to

  const badgeForItem = (item: NavItem): number | null => {
    if (item.match === '/dialog-objects' && pendingApplicationCount > 0) {
      return pendingApplicationCount
    }
    return null
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="sidebar-logo">Crabot</div>
        <div className="sidebar-tagline">AI Employee Admin</div>
      </div>

      <nav className="sidebar-nav">
        {navSections.map((section, idx) => (
          <div key={idx} className="sidebar-section">
            <div className="sidebar-section-label">{section.label}</div>
            {section.items.map((item) => {
              const badge = badgeForItem(item)
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={`sidebar-nav-item ${isActive(item) ? 'active' : ''}${badge ? ' has-badge' : ''}`}
                >
                  <span className="sidebar-nav-dot" />
                  <span className="sidebar-nav-label">{item.label}</span>
                  {badge !== null && (
                    <span
                      className="sidebar-nav-badge"
                      aria-label={`${badge} 条待处理申请`}
                    >
                      {badge > 99 ? '99+' : badge}
                    </span>
                  )}
                </Link>
              )
            })}
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        Crabot v0.1
      </div>
    </aside>
  )
}
