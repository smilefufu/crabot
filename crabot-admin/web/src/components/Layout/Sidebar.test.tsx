import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { SectionNavigation } from './SectionNavigation'
import { navigationForPath } from './navigation'

vi.mock('../../contexts/DialogApplicationsContext', () => ({ useDialogApplications: () => ({ count: 2 }) }))
vi.mock('../../hooks/useSystemVersion', () => ({ useSystemVersion: () => ({ state: null }) }))
vi.mock('../../services/desktop-host', () => ({ isDesktop: false, useDesktopState: () => null }))

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
})
