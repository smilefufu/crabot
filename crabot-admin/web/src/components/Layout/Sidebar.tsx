import React from 'react'
import { Link, useLocation } from 'react-router-dom'

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

    ],
  },
  {
    label: '社交与数据',
    items: [
      { to: '/friends', label: '熟人管理', match: '/friends' },
      { to: '/sessions', label: '会话管理', match: '/sessions' },
      { to: '/permission-templates', label: '权限模板', match: '/permission-templates' },
      { to: '/memory', label: '记忆管理', match: '/memory' },
    ],
  },
]

export const Sidebar: React.FC = () => {
  const location = useLocation()

  const isActive = (match: string) => location.pathname.startsWith(match)

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
            {section.items.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className={`sidebar-nav-item ${isActive(item.match) ? 'active' : ''}`}
              >
                <span className="sidebar-nav-dot" />
                {item.label}
              </Link>
            ))}
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        Crabot v0.1
      </div>
    </aside>
  )
}
