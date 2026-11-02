import { Link, useLocation } from 'react-router-dom'
import { useDialogApplications } from '../../contexts/DialogApplicationsContext'
import { useSystemVersion } from '../../hooks/useSystemVersion'
import { isDesktop, useDesktopState } from '../../services/desktop-host'
import { navigationForPath, navigationGroups } from './navigation'
import { CrabotLogo } from '../Common/CrabotLogo'
import { NavigationIcon } from './NavigationIcon'

export function Sidebar() {
  const { pathname } = useLocation()
  const { count } = useDialogApplications()
  const { state: version } = useSystemVersion()
  const desktop = useDesktopState()
  const active = navigationForPath(pathname)
  const item = (id: string) => {
    const group = navigationGroups.find(entry => entry.id === id)!
    return <Link key={id} to={group.items[0].to} className={`sidebar-nav-item ${active?.id === id ? 'active' : ''}`}
      aria-current={active?.id === id ? 'page' : undefined}>
      <NavigationIcon name={id} />
      <span className="sidebar-nav-label">{group.label}<small>{group.hint}</small></span>
      {id === 'social' && count > 0 && <span className="sidebar-nav-badge" aria-label={`${count} 条待处理申请`}>{count > 99 ? '99+' : count}</span>}
      {id === 'settings' && version?.upgrade_available && version.upgrade_capability !== 'system' && <span className="sidebar-nav-upgrade-dot" aria-label="有新版本可升级" />}
    </Link>
  }
  return <aside className="sidebar">
    <Link className="sidebar-brand partner-identity" to="/companion" aria-current={pathname === '/companion' ? 'page' : undefined}>
      <CrabotLogo /><span><strong>CRABOT</strong><span className="sidebar-tagline">你的 AI 伙伴</span><small>个性与表达 ›</small></span>
    </Link>
    <nav className="sidebar-nav" aria-label="主导航">
      <div className="sidebar-section"><div className="sidebar-section-label">日常相处</div>{['chat', 'tasks', 'workspace'].map(item)}</div>
      <div className="sidebar-section"><div className="sidebar-section-label">了解与成长</div>{['memory', 'abilities', 'social'].map(item)}</div>
      <div className="partner-settings">{item('settings')}</div>
    </nav>
    <div className="sidebar-footer">CRABOT{isDesktop && desktop?.app_version ? ` ${desktop.app_version}` : ''}</div>
  </aside>
}
