import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SubagentList } from './SubagentList'
import { subagentService } from '../../services/subagent'
import { ToastProvider } from '../../contexts/ToastContext'
import type { SubAgentRegistryEntry } from '../../types'

vi.mock('../../services/subagent')
vi.mock('../../components/Layout/MainLayout', () => ({
  MainLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

function makeEntry(over: Partial<SubAgentRegistryEntry> = {}): SubAgentRegistryEntry {
  return {
    id: 'builtin-code-planner',
    name: 'code_planner',
    description: '代码规划专家',
    when_to_use: '',
    role: '',
    workflow: '',
    deliverables: '',
    verification: '',
    builtin_capabilities: {
      file_system: true, shell: true, task_intel: true, crab_memory: false, crab_messaging: false,
    },
    allowed_mcp_server_ids: [],
    allowed_skill_ids: [],
    max_turns: 30,
    provider_id: null,
    model_id: null,
    model_role: 'powerful',
    enabled: true,
    is_builtin: true,
    created_at: '2026-05-19T00:00:00Z',
    updated_at: '2026-05-19T00:00:00Z',
    ...over,
  }
}

function renderList() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <SubagentList />
      </ToastProvider>
    </MemoryRouter>
  )
}

describe('SubagentList', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('renders builtin / custom badges', async () => {
    ;(subagentService.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeEntry({ name: 'code_planner', is_builtin: true }),
      makeEntry({ id: 'c1', name: 'my_custom', is_builtin: false }),
    ])
    renderList()
    expect(await screen.findByText('code_planner')).toBeInTheDocument()
    expect(screen.getByText('my_custom')).toBeInTheDocument()
    expect(screen.getByText('内置')).toBeInTheDocument()
    expect(screen.getByText('自定义')).toBeInTheDocument()
  })

  it('disables delete button for builtin entries with tooltip', async () => {
    ;(subagentService.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeEntry({ is_builtin: true }),
    ])
    renderList()
    const deleteBtn = await screen.findByRole('button', { name: /删除/ })
    expect(deleteBtn).toBeDisabled()
    expect(deleteBtn).toHaveAttribute('title', expect.stringContaining('内置'))
  })

  it('toggling enabled calls update', async () => {
    ;(subagentService.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeEntry({ enabled: true }),
    ])
    ;(subagentService.update as ReturnType<typeof vi.fn>).mockResolvedValue(makeEntry({ enabled: false }))
    renderList()
    const toggle = await screen.findByRole('checkbox', { name: /enabled/i })
    fireEvent.click(toggle)
    await waitFor(() => {
      expect(subagentService.update).toHaveBeenCalledWith('builtin-code-planner', { enabled: false })
    })
  })

  it('deleting a custom entry calls remove after confirm', async () => {
    ;(subagentService.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeEntry({ id: 'c1', name: 'my_custom', is_builtin: false }),
    ])
    ;(subagentService.remove as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderList()
    const deleteBtn = await screen.findByRole('button', { name: /删除/ })
    fireEvent.click(deleteBtn)
    await waitFor(() => {
      expect(subagentService.remove).toHaveBeenCalledWith('c1')
    })
  })
})
