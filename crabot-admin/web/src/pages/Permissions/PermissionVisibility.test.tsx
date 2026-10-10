import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PermissionTemplateForm } from './PermissionTemplateForm'
import { PermissionTemplateList } from './PermissionTemplateList'
import { createCliAccessConfig, type PermissionTemplate } from '../../types'

const list = vi.fn()
const create = vi.fn()
const update = vi.fn()
const toast = { success: vi.fn(), error: vi.fn() }
vi.mock('../../contexts/ToastContext', () => ({ useToast: () => toast }))
vi.mock('../../components/Layout/MainLayout', () => ({
  MainLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock('../../services/permission-template', () => ({
  permissionTemplateService: {
    list: (...args: unknown[]) => list(...args),
    create: (...args: unknown[]) => create(...args),
    update: (...args: unknown[]) => update(...args),
  },
}))

const template: PermissionTemplate = {
  id: 'custom', name: 'Custom', is_system: false,
  tool_access: {
    memory: true, messaging: true, task: true, mcp_skill: true, file_io: true,
    browser: true, shell: true, remote_exec: true, desktop: false,
  },
  cli_access: createCliAccessConfig('none'), storage: null, memory_scopes: [],
  created_at: '2026-10-08', updated_at: '2026-10-08',
}

describe('permission category visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows six effective entries and scope limits while preserving retired defaults', async () => {
    render(<PermissionTemplateForm onSave={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.queryByText('远程执行')).not.toBeInTheDocument()
    expect(screen.queryByText('任务管理')).not.toBeInTheDocument()
    expect(screen.queryByText('浏览器')).not.toBeInTheDocument()
    expect(screen.getByText('未授权内置文件范围')).toBeInTheDocument()
    expect(screen.getByText(/后端数据过滤尚未核实/)).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('例如：高级用户'), { target: { value: 'New' } })
    fireEvent.click(screen.getByLabelText('本地命令'))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      tool_access: expect.objectContaining({ shell: true, task: false, browser: false, remote_exec: false }),
    })))
  })

  it.each([true, false])('hides remote execution when editing and preserves its stored value %s', async (remoteExec) => {
    const existing = { ...template, tool_access: { ...template.tool_access, remote_exec: remoteExec } }
    render(<PermissionTemplateForm template={existing} onSave={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.queryByText('远程执行')).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('本地命令'))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith('custom', expect.objectContaining({
      tool_access: expect.objectContaining({ shell: false, remote_exec: remoteExec }),
    })))
  })

  it('omits an enabled remote-execution badge from the template list', async () => {
    list.mockResolvedValue({ items: [template] })
    render(<PermissionTemplateList />)
    await screen.findByText('Custom')
    expect(screen.getByText('本地命令')).toBeInTheDocument()
    expect(screen.queryByText('远程执行')).not.toBeInTheDocument()
  })
})
