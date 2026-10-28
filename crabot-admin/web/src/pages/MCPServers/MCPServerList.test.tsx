import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MCPServerList } from './MCPServerList'
import { mcpService } from '../../services/mcp'

vi.mock('../../components/Layout/MainLayout', () => ({ MainLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock('../../contexts/ToastContext', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock('../../services/mcp', () => ({ mcpService: { list: vi.fn(), create: vi.fn(), update: vi.fn() } }))
const existing = { id: 'stable-id', name: 'existing', command: 'npx', enabled: true, is_builtin: false,
  is_essential: false, can_disable: true, created_at: '', updated_at: '' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(mcpService.list).mockResolvedValue([])
  vi.mocked(mcpService.create).mockResolvedValue(existing)
  vi.mocked(mcpService.update).mockResolvedValue(existing)
})

describe('MCP environment selection', () => {
  it('lets a fresh standard command use the server default and allows explicit custom', async () => {
    render(<MCPServerList />)
    fireEvent.click(await screen.findByRole('button', { name: '添加 MCP Server' }))
    expect(screen.getByLabelText('运行环境')).toHaveValue('auto')
    fireEvent.change(screen.getByLabelText('名称 *'), { target: { value: 'new' } })
    fireEvent.change(screen.getByLabelText('命令 *'), { target: { value: 'npx' } })
    fireEvent.change(screen.getByLabelText('运行环境'), { target: { value: 'custom' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(mcpService.create).toHaveBeenCalledWith(expect.objectContaining({ managed_runtime: null })))
  })

  it('displays old entries as custom and sends null when changing a managed entry back to custom', async () => {
    vi.mocked(mcpService.list).mockResolvedValue([{ ...existing, managed_runtime: 'node' }])
    render(<MCPServerList />)
    expect(await screen.findByText(/Crabot 管理 node/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    expect(screen.getByLabelText('运行环境')).toHaveValue('node')
    fireEvent.change(screen.getByLabelText('运行环境'), { target: { value: 'custom' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(mcpService.update).toHaveBeenCalledWith('stable-id', expect.objectContaining({ managed_runtime: null })))
  })

  it('never defaults an existing custom entry during an unrelated edit', async () => {
    vi.mocked(mcpService.list).mockResolvedValue([existing])
    render(<MCPServerList />)
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }))
    expect(screen.getByLabelText('运行环境')).toHaveValue('custom')
    expect(screen.queryByRole('option', { name: /自动选择/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(mcpService.update).toHaveBeenCalledWith('stable-id', expect.objectContaining({ managed_runtime: null })))
  })
})
