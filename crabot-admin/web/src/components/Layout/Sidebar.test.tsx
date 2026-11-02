import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { SectionNavigation } from './SectionNavigation'
import { navigationForPath } from './navigation'

vi.mock('../../contexts/DialogApplicationsContext', () => ({ useDialogApplications: () => ({ count: 2 }) }))
vi.mock('../../hooks/useSystemVersion', () => ({ useSystemVersion: () => ({ state: null }) }))
const host = vi.hoisted(() => ({ desktop: false }))
vi.mock('../../services/desktop-host', () => ({ get isDesktop() { return host.desktop }, useDesktopState: () => null }))

beforeEach(() => { host.desktop = false })

describe('companion navigation', () => {
  it('keeps the existing scene URL under memory and highlights only its local category', () => {
    render(<MemoryRouter initialEntries={['/memory/scenes/person']}><Sidebar /><SectionNavigation /></MemoryRouter>)
    expect(screen.getByRole('link', { name: /^记忆/ })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: '人物与场景' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: '长期记忆' })).not.toHaveAttribute('aria-current')
    expect(screen.getByRole('link', { name: /^社交/ })).toHaveTextContent('2')
  })
  it.each([
    ['/providers', 'abilities'], ['/agents/workers', 'abilities'], ['/skills', 'abilities'],
    ['/traces/workers/worker', 'tasks'], ['/schedules', 'tasks'], ['/channels/new/voice', 'social'],
    ['/memory/short-term', 'memory'], ['/backup', 'settings'], ['/modules/admin', 'settings'],
    ['/migrate/openclaw', 'settings'], ['/desktop/diagnostics', 'settings'], ['/workspaces', 'workspace'],
  ])('keeps %s reachable in the appropriate group', (path, group) => {
    expect(navigationForPath(path)?.id).toBe(group)
  })
  it('does not match unrelated routes by partial prefix', () => {
    expect(navigationForPath('/providers-other')).toBeUndefined()
  })
  it.each([false, true])('shows native diagnostics only with a desktop host (%s)', desktop => {
    host.desktop = desktop
    render(<MemoryRouter initialEntries={['/settings']}><SectionNavigation /></MemoryRouter>)
    screen.getByText('更多数据与诊断选项').click()
    expect(!!screen.queryByRole('link', { name: '设备诊断' })).toBe(desktop)
    expect(screen.getByRole('link', { name: '设备与授权' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '导入数据' })).toBeInTheDocument()
  })
})
