import { Link, useLocation } from 'react-router-dom'
import { matchesNavigation, navigationForPath } from './navigation'
import { isDesktop } from '../../services/desktop-host'

export function SectionNavigation() {
  const { pathname } = useLocation()
  const group = navigationForPath(pathname)
  if (!group || group.items.length < 2) return null
  const advanced = group.advanced?.filter(item => isDesktop || item.to !== '/desktop/diagnostics')
  const advancedActive = advanced?.some(item => matchesNavigation(pathname, item))
  return <section className="section-navigation" aria-label={`${group.label}分类`}>
    <div className="partner-breadcrumb">CRABOT / {group.label}</div>
    <nav className="partner-tabs" aria-label={group.label}>
      {group.items.map(item => <Link key={item.to} to={item.to}
        className={matchesNavigation(pathname, item) ? 'active' : ''}
        aria-current={matchesNavigation(pathname, item) ? 'page' : undefined}>{item.label}</Link>)}
    </nav>
    {advanced && <details className="partner-advanced" open={advancedActive || undefined}>
      <summary>{group.id === 'abilities' ? '高级：模型分工与执行方式' : '更多数据与诊断选项'}</summary>
      <nav aria-label={`${group.label}高级选项`}>{advanced.map(item => <Link key={item.to} to={item.to}
        aria-current={matchesNavigation(pathname, item) ? 'page' : undefined}>{item.label}</Link>)}</nav>
    </details>}
  </section>
}
