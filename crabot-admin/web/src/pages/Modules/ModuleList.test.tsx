import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ModuleList } from './ModuleList'
import { legacyArchiveService } from '../../services/legacy-archive'
import { channelService } from '../../services/channel'

vi.mock('../../services/legacy-archive')
vi.mock('../../services/channel')
vi.mock('../../services/api', () => ({ api: { get: vi.fn().mockResolvedValue({ modules: [] }) } }))
vi.mock('../../components/Layout/MainLayout', () => ({
  MainLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

describe('ModuleList (P6-D)', () => {
  beforeEach(() => {
    vi.mocked(legacyArchiveService.list).mockResolvedValue([
      {
        archive_id: 'agent_config:front-agent',
        source_kind: 'agent_config',
        archived_at: '2026-08-14T00:00:00.000Z',
        support_status: 'unsupported_legacy',
        uninstallable: true,
        display_name: 'front-agent',
      },
    ])
    vi.mocked(channelService.listImplementations).mockResolvedValue({ items: [] } as never)
  })

  it('唯一 live agent 是静态 core；legacy 以 unsupported 摘要呈现且不含 raw', async () => {
    render(<MemoryRouter><ModuleList /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('Crabot Core Agent')).toBeTruthy())
    expect(screen.getByText(/不受支持的 legacy.*front-agent/)).toBeTruthy()
    // 列表页不出现动态 create/install 控件
    expect(screen.queryByText(/安装 Agent/i)).toBeNull()
    expect(screen.queryByText(/创建实例/i)).toBeNull()
  })
})
