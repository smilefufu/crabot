import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../App'

const authState = {
  isAuthenticated: true,
  login: vi.fn(),
  logout: vi.fn(),
}

vi.mock('../../contexts/AuthContext', async () => {
  const actual = await vi.importActual<typeof import('../../contexts/AuthContext')>('../../contexts/AuthContext')
  return {
    ...actual,
    useAuth: () => authState,
  }
})

vi.mock('../Login', () => ({
  Login: () => <div>Login</div>,
}))

vi.mock('../Chat', () => ({
  Chat: () => <div>Chat</div>,
}))

vi.mock('../Providers/ProviderManagement', () => ({
  ProviderManagement: () => <div>ProviderManagement</div>,
}))

vi.mock('../Modules/ModuleList', () => ({
  ModuleList: () => <div>ModuleList</div>,
}))

vi.mock('../Modules/ModuleDetail', () => ({
  ModuleDetail: () => <div>ModuleDetail</div>,
}))

vi.mock('../Agents/AgentConfig', () => ({
  AgentConfig: () => <div>AgentConfig</div>,
}))

vi.mock('../Channels/ChannelConfig', () => ({
  ChannelConfig: () => <div>ChannelConfig</div>,
}))

vi.mock('../Channels/ChannelPty', () => ({
  ChannelPty: () => <div>ChannelPty</div>,
}))

vi.mock('../Settings/GlobalSettings', () => ({
  GlobalSettings: () => <div>GlobalSettings</div>,
}))

vi.mock('../DialogObjects', () => ({
  DialogObjectsPage: () => <div>DialogObjectsPage</div>,
}))

vi.mock('../MCPServers/MCPServerList', () => ({
  MCPServerList: () => <div>MCPServerList</div>,
}))

vi.mock('../Permissions/PermissionTemplateList', () => ({
  PermissionTemplateList: () => <div>PermissionTemplateList</div>,
}))

vi.mock('../Skills/SkillList', () => ({
  SkillList: () => <div>SkillList</div>,
}))

vi.mock('../Traces', () => ({
  Traces: () => <div>Traces</div>,
}))

vi.mock('../Schedules/ScheduleList', () => ({
  ScheduleList: () => <div>ScheduleList</div>,
}))

vi.mock('./MemoryBrowser', () => ({
  MemoryBrowser: ({ initialTab }: { initialTab?: 'short' | 'long' }) => <div>MemoryBrowser:{initialTab ?? 'short'}</div>,
}))

vi.mock('./SceneProfileList', () => ({
  SceneProfileList: () => <div>SceneProfileList</div>,
}))

vi.mock('./SceneProfileDetail', () => ({
  SceneProfileDetail: () => <div>SceneProfileDetail</div>,
}))

describe('Memory route behavior', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/memory')
  })

  it('redirects /memory to the entries page', async () => {
    render(<App />)

    expect(await screen.findByText('MemoryBrowser:short')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/memory/entries')
  })

  it('passes the long tab query through the entries route', async () => {
    window.history.replaceState({}, '', '/memory/entries?tab=long')

    render(<App />)

    expect(await screen.findByText('MemoryBrowser:long')).toBeInTheDocument()
  })
})
