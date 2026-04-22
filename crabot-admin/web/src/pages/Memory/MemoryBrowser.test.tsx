import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../App'
import { memoryService, type LongTermMemoryEntry, type ShortTermMemoryEntry } from '../../services/memory'

const toast = {
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}

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

vi.mock('../../contexts/ToastContext', async () => {
  const actual = await vi.importActual<typeof import('../../contexts/ToastContext')>('../../contexts/ToastContext')
  return {
    ...actual,
    useToast: () => toast,
  }
})

vi.mock('../../services/memory', async () => {
  const actual = await vi.importActual<typeof import('../../services/memory')>('../../services/memory')
  return {
    ...actual,
    memoryService: {
      listModules: vi.fn(),
      getStats: vi.fn(),
      searchShortTerm: vi.fn(),
      searchLongTerm: vi.fn(),
      browseLongTerm: vi.fn(),
      getMemory: vi.fn(),
      deleteMemory: vi.fn(),
      getRelatedSceneProfiles: vi.fn(),
    },
  }
})

vi.mock('../../components/Layout/MainLayout', () => ({
  MainLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

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

vi.mock('./SceneProfileList', () => ({
  SceneProfileList: () => <div>SceneProfileList</div>,
}))

vi.mock('./SceneProfileDetail', () => ({
  SceneProfileDetail: () => <div>SceneProfileDetail</div>,
}))

type MockedMemoryService = typeof memoryService & {
  browseLongTerm: ReturnType<typeof vi.fn>
  listModules: ReturnType<typeof vi.fn>
  getStats: ReturnType<typeof vi.fn>
  searchShortTerm: ReturnType<typeof vi.fn>
  searchLongTerm: ReturnType<typeof vi.fn>
  getMemory: ReturnType<typeof vi.fn>
  deleteMemory: ReturnType<typeof vi.fn>
  getRelatedSceneProfiles: ReturnType<typeof vi.fn>
}

const mockedMemoryService = memoryService as MockedMemoryService

const shortEntry: ShortTermMemoryEntry = {
  id: 'short-1',
  content: '短期记忆内容',
  keywords: ['alice'],
  event_time: '2026-04-22T10:00:00Z',
  persons: ['Alice'],
  entities: [],
  topic: '聊天',
  source: { type: 'conversation' },
  refs: {},
  compressed: false,
  visibility: 'private',
  scopes: ['friend:friend-1'],
  created_at: '2026-04-22T10:00:00Z',
}

const longEntry: LongTermMemoryEntry = {
  id: 'long-1',
  abstract: '长期摘要',
  overview: '长期概览',
  content: '长期全文',
  entities: [],
  importance: 0.8,
  keywords: ['alice'],
  tags: ['friend'],
  source: { type: 'reflection' },
  metadata: {},
  read_count: 0,
  version: 1,
  visibility: 'private',
  scopes: ['friend:friend-1'],
  created_at: '2026-04-22T10:00:00Z',
  updated_at: '2026-04-22T10:00:00Z',
}

function renderMemoryEntries(path: string) {
  window.history.replaceState({}, '', path)
  return render(<App />)
}

describe('MemoryBrowser entries behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedMemoryService.listModules.mockResolvedValue({
      items: [{ module_id: 'memory-1', port: 19010, name: 'Memory 1' }],
    })
    mockedMemoryService.getStats.mockResolvedValue({
      short_term: {
        entry_count: 1,
        compressed_count: 0,
        total_tokens: 10,
        latest_entry_at: '2026-04-22T10:00:00Z',
        earliest_entry_at: '2026-04-22T10:00:00Z',
      },
      long_term: {
        entry_count: 1,
        total_tokens: 20,
        latest_entry_at: '2026-04-22T10:00:00Z',
        earliest_entry_at: '2026-04-22T10:00:00Z',
      },
    })
    mockedMemoryService.searchShortTerm.mockResolvedValue({ results: [shortEntry] })
    mockedMemoryService.searchLongTerm.mockResolvedValue({
      results: [{ memory: longEntry, relevance: 0.9 }],
    })
    mockedMemoryService.browseLongTerm.mockResolvedValue({ results: [longEntry] })
    mockedMemoryService.getMemory.mockResolvedValue({ type: 'long', memory: longEntry })
    mockedMemoryService.deleteMemory.mockResolvedValue({ deleted: true })
    mockedMemoryService.getRelatedSceneProfiles.mockResolvedValue({ profiles: [] })
  })

  it('loads recent long-term memories in browse mode', async () => {
    renderMemoryEntries('/memory/entries?tab=long&mode=browse')

    await waitFor(() => {
      expect(mockedMemoryService.browseLongTerm).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 50 }),
      )
    })
    expect(mockedMemoryService.searchLongTerm).not.toHaveBeenCalled()
  })

  it('uses semantic search for long-term context mode with an explicit query only after searching', async () => {
    renderMemoryEntries('/memory/entries?tab=long&mode=context&friend_id=friend-1&context_label=Alice')

    await waitFor(() => {
      expect(mockedMemoryService.browseLongTerm).toHaveBeenCalledWith(
        expect.objectContaining({ friendId: 'friend-1' }),
      )
    })
    expect(mockedMemoryService.searchLongTerm).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '语义搜索' }))
    fireEvent.change(await screen.findByPlaceholderText('搜索长期记忆...'), {
      target: { value: 'TypeScript' },
    })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))

    await waitFor(() => {
      expect(mockedMemoryService.searchLongTerm).toHaveBeenCalledWith(
        expect.objectContaining({
          q: 'TypeScript',
          friendId: 'friend-1',
        }),
      )
    })
  })

  it('shows current-view summary separately from global stats when context filters are active', async () => {
    renderMemoryEntries('/memory/entries?tab=short&mode=context&friend_id=friend-1&context_label=Alice')

    expect(await screen.findByText('当前视图')).toBeInTheDocument()
    expect(screen.getByText('friend_id：friend-1')).toBeInTheDocument()
    expect(await screen.findByText('全局统计')).toBeInTheDocument()
  })

  it('uses a modal confirmation before deleting an entry', async () => {
    renderMemoryEntries('/memory/entries?tab=short&mode=browse')

    fireEvent.click(await screen.findByRole('button', { name: '删除' }))

    expect(screen.getByRole('dialog', { name: '删除记忆条目' })).toBeInTheDocument()
  })

  it('shows reverse scene-profile links for long-term memories', async () => {
    mockedMemoryService.getRelatedSceneProfiles.mockResolvedValue({
      profiles: [
        {
          scene: { type: 'friend', friend_id: 'friend-1' },
          label: 'Alice',
          abstract: '工作搭子',
          overview: '稳定规则',
          content: '完整说明',
          source_memory_ids: ['long-1'],
          created_at: '2026-04-19T00:00:00.000Z',
          updated_at: '2026-04-20T00:00:00.000Z',
        },
      ],
    })

    renderMemoryEntries('/memory/entries?tab=long&mode=browse')

    fireEvent.click(await screen.findByText('长期摘要'))

    expect(await screen.findByRole('link', { name: 'Alice' })).toHaveAttribute(
      'href',
      '/memory/scenes/friend%3Afriend-1',
    )
  })

  it('does not delete when confirmation is cancelled', async () => {
    renderMemoryEntries('/memory/entries?tab=short&mode=browse')

    fireEvent.click(await screen.findByRole('button', { name: '删除' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    expect(mockedMemoryService.deleteMemory).not.toHaveBeenCalled()
  })
})
