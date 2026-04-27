import React from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { AgentConfig } from './AgentConfig'

vi.mock('../../components/Layout/MainLayout', () => ({
  MainLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  }),
}))

vi.mock('../../services/mcp', () => ({
  mcpService: {
    list: vi.fn().mockResolvedValue([
      {
        id: 'mcp-A',
        name: 'mcp-a',
        description: 'A',
        command: 'cmd',
        is_builtin: true,
        is_essential: false,
        can_disable: true,
        enabled: true,
        created_at: '',
        updated_at: '',
      },
      {
        id: 'mcp-B',
        name: 'mcp-b',
        description: 'B',
        command: 'cmd',
        is_builtin: false,
        is_essential: false,
        can_disable: true,
        enabled: true,
        created_at: '',
        updated_at: '',
      },
      {
        id: 'mcp-C',
        name: 'mcp-c',
        description: 'C',
        command: 'cmd',
        is_builtin: false,
        is_essential: false,
        can_disable: true,
        enabled: false,
        created_at: '',
        updated_at: '',
      },
    ]),
  },
}))

vi.mock('../../services/skill', () => ({
  skillService: {
    list: vi.fn().mockResolvedValue([
      {
        id: 'skill-1',
        name: 'skill-foo',
        description: 'foo',
        version: '1.0',
        content: '',
        is_builtin: false,
        is_essential: false,
        can_disable: true,
        enabled: true,
        created_at: '',
        updated_at: '',
      },
      {
        id: 'skill-2',
        name: 'skill-bar',
        description: 'bar',
        version: '1.0',
        content: '',
        is_builtin: false,
        is_essential: false,
        can_disable: true,
        enabled: false,
        created_at: '',
        updated_at: '',
      },
    ]),
  },
}))

vi.mock('../../services/agent', () => ({
  agentService: {
    getConfig: vi.fn().mockResolvedValue({
      instance_id: 'inst-1',
      system_prompt: '',
      model_config: {},
      extra: {},
    }),
    updateConfig: vi.fn().mockResolvedValue({}),
    getLLMRequirements: vi.fn().mockResolvedValue({
      model_format: 'anthropic',
      requirements: [],
      extra_schema: [],
    }),
  },
}))

vi.mock('../../services/provider', () => ({
  providerService: {
    listProviders: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, limit: 100 }),
  },
}))

function renderAgentConfig() {
  return render(
    <MemoryRouter>
      <AgentConfig />
    </MemoryRouter>,
  )
}

describe('AgentConfig — read-only MCP/Skill display', () => {
  it('"已启用的 MCP Servers" 只显示 enabled 的（不含 disabled mcp-c）', async () => {
    renderAgentConfig()
    expect(await screen.findByText('mcp-a')).toBeDefined()
    expect(await screen.findByText('mcp-b')).toBeDefined()
    expect(screen.queryByText('mcp-c')).toBeNull()
  })

  it('没有勾选框（read-only）', async () => {
    const { container } = renderAgentConfig()
    await screen.findByText('mcp-a')
    const checkboxes = container.querySelectorAll('input[type="checkbox"]')
    expect(checkboxes.length).toBe(0)
  })

  it('"前往 MCP 管理" 链接 href=/mcp-servers', async () => {
    renderAgentConfig()
    const link = await screen.findByText(/前往 MCP 管理/)
    const href = link.closest('a')?.getAttribute('href')
    expect(href).toBe('/mcp-servers')
  })

  it('"前往 Skills 管理" 链接 href=/skills', async () => {
    renderAgentConfig()
    const link = await screen.findByText(/前往 Skills 管理/)
    const href = link.closest('a')?.getAttribute('href')
    expect(href).toBe('/skills')
  })

  it('"已启用的 Skills" 只显示 enabled 的（不含 disabled skill-bar）', async () => {
    renderAgentConfig()
    expect(await screen.findByText('skill-foo')).toBeDefined()
    expect(screen.queryByText('skill-bar')).toBeNull()
  })
})
