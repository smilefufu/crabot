import React from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useDialogApplications } from '../../contexts/DialogApplicationsContext'
import { useSystemVersion } from '../../hooks/useSystemVersion'
import { isDesktop, useDesktopState } from '../../services/desktop-host'

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
  { to: '/workspaces', label: '工作区', match: '/workspaces' },
      { to: '/traces', label: '运行记录', match: '/traces' },
    ],
  },
  {
    label: '模型与 Agent',
    items: [
      { to: '/providers', label: '模型配置', match: '/providers' },
      { to: '/agents/config', label: 'Agent 配置', match: '/agents/config' },
      { to: '/agents/workers', label: 'Worker 配置', match: '/agents/workers' },
      { to: '/mcp-servers', label: 'MCP Servers', match: '/mcp-servers' },
      { to: '/skills', label: 'Skills', match: '/skills' },
      { to: '/subagents', label: 'Subagent 管理', match: '/subagents' },
    ],
  },
  {
    label: '系统',
    items: [
      { to: '/modules', label: '模块管理', match: '/modules' },
      { to: '/channels/config', label: 'Channel 配置', match: '/channels' },
      { to: '/schedules', label: '计划任务', match: '/schedules' },
      { to: '/migrate/openclaw', label: '导入', match: '/migrate/openclaw' },
      { to: '/backup', label: '导出备份', match: '/backup' },
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
const desktopSections: NavSection[] = [{ label: 'Crabot', items: [
  { to: '/chat', label: '聊天', match: '/chat' },
  { to: '/workspaces', label: '工作区', match: '/workspaces' },
  { to: '/traces', label: '任务与运行记录', match: '/traces' },
  { to: '/providers', label: '模型', match: '/providers' },
  { to: '/desktop/permissions', label: '权限与能力', match: '/desktop/permissions' },
  { to: '/desktop/diagnostics', label: '诊断', match: '/desktop/diagnostics' },
  { to: '/settings', label: '设置', match: '/settings' },
] }]
const desktopPrimaryPaths = new Set(desktopSections.flatMap(section => section.items.map(item => item.to)))
const advancedSections = navSections.map(section => ({ ...section, items: section.items.filter(item => !desktopPrimaryPaths.has(item.to)) })).filter(section => section.items.length)

export const Sidebar: React.FC = () => {
  const location = useLocation()
  const { count: pendingApplicationCount } = useDialogApplications()
  const { state: versionState } = useSystemVersion()
  const desktopState = useDesktopState()
  const showUpgradeDot =
    !!versionState?.upgrade_available && versionState.upgrade_capability !== 'system'

  const sections = isDesktop ? [...desktopSections, ...advancedSections] : navSections
  const activeItem = sections
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

  const renderSections = (sections: NavSection[]) => sections.map(section => (
    <div key={section.label} className="sidebar-section">
      <div className="sidebar-section-label">{section.label}</div>
      {section.items.map(item => {
        const badge = badgeForItem(item)
        return <Link key={item.to} to={item.to} className={`sidebar-nav-item ${isActive(item) ? 'active' : ''}${badge ? ' has-badge' : ''}`}>
          <span className="sidebar-nav-dot" /><span className="sidebar-nav-label">{item.label}</span>
          {item.match === '/settings' && showUpgradeDot && <span className="sidebar-nav-upgrade-dot" aria-label="有新版本可升级" />}
          {badge !== null && <span className="sidebar-nav-badge" aria-label={`${badge} 条待处理申请`}>{badge > 99 ? '99+' : badge}</span>}
        </Link>
      })}
    </div>
  ))

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="sidebar-logo">Crabot</div>
        <div className="sidebar-tagline">{isDesktop ? '本机 AI 助手' : 'AI Employee Admin'}</div>
      </div>

      <nav className="sidebar-nav">
        {renderSections(isDesktop ? desktopSections : navSections)}
        {isDesktop && <details className="sidebar-advanced" open={advancedSections.some(section => section.items.some(isActive))}>
          <summary>高级管理{pendingApplicationCount > 0 && <span className="sidebar-nav-badge" aria-label={`${pendingApplicationCount} 条待处理申请`}>{pendingApplicationCount}</span>}</summary>{renderSections(advancedSections)}
        </details>}
      </nav>

      <div className="sidebar-footer">
        {isDesktop ? `Crabot ${desktopState?.app_version ?? ''}` : 'Crabot v0.1'}
      </div>
    </aside>
  )
}
