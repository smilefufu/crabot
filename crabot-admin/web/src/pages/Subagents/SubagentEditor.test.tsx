import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ToastProvider } from '../../contexts/ToastContext'
import { SubagentEditor } from './SubagentEditor'
import { subagentService } from '../../services/subagent'
import { providerService } from '../../services/provider'
import { mcpService } from '../../services/mcp'
import { skillService } from '../../services/skill'
import type { SubAgentRegistryEntry } from '../../types'

vi.mock('../../services/subagent')
vi.mock('../../services/provider', () => ({
  providerService: {
    listProviders: vi.fn(),
  },
}))
vi.mock('../../services/mcp', () => ({
  mcpService: {
    list: vi.fn(),
  },
}))
vi.mock('../../services/skill', () => ({
  skillService: {
    list: vi.fn(),
  },
}))

function makeEntry(over: Partial<SubAgentRegistryEntry> = {}): SubAgentRegistryEntry {
  return {
    id: 'c1',
    name: 'my_custom',
    description: 'custom subagent',
    when_to_use: '',
    role: '',
    workflow: '',
    deliverables: '',
    verification: '',
    builtin_capabilities: {
      file_system: true, shell: true, task_intel: true, crab_memory: true, crab_messaging: false,
    },
    allowed_mcp_server_ids: [],
    allowed_skill_ids: [],
    max_turns: 20,
    provider_id: 'p1',
    model_id: 'gpt-4',
    model_role: null,
    enabled: true,
    is_builtin: false,
    created_at: '2026-05-19T00:00:00Z',
    updated_at: '2026-05-19T00:00:00Z',
    ...over,
  }
}

function renderEditor(props: Partial<React.ComponentProps<typeof SubagentEditor>> = {}) {
  return render(
    <ToastProvider>
      <SubagentEditor
        mode="create"
        entry={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        {...props}
      />
    </ToastProvider>
  )
}

describe('SubagentEditor', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    ;(subagentService.create as ReturnType<typeof vi.fn>).mockResolvedValue(makeEntry())
    ;(subagentService.update as ReturnType<typeof vi.fn>).mockResolvedValue(makeEntry())
    ;(providerService.listProviders as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [], pagination: { page: 1, page_size: 50 } })
    ;(mcpService.list as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(skillService.list as ReturnType<typeof vi.fn>).mockResolvedValue([])
  })

  it('name 校验：snake_case 通过', async () => {
    renderEditor()
    const nameInput = screen.getByLabelText('名称') as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: 'good_name' } })
    expect(screen.queryByText(/必须 snake_case/)).not.toBeInTheDocument()
  })

  it('name 校验：含大写报错', async () => {
    renderEditor()
    const nameInput = screen.getByLabelText('名称') as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: 'BadName' } })
    expect(screen.getByText(/必须 snake_case/)).toBeInTheDocument()
  })

  it('编辑 builtin 时，改名显示告警', async () => {
    renderEditor({
      mode: 'edit',
      entry: makeEntry({ is_builtin: true, name: 'code_planner' }),
    })
    const nameInput = screen.getByLabelText('名称') as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: 'code_planner_v2' } })
    expect(screen.getByText(/builtin 改名后将被自动 prune 重置/)).toBeInTheDocument()
  })

  it('Tab 4 模式切换互斥：选 role 默认时清 provider_id+model_id', async () => {
    renderEditor({
      mode: 'edit',
      entry: makeEntry({ provider_id: 'p1', model_id: 'gpt-4', model_role: null }),
    })
    fireEvent.click(screen.getByText('模型'))
    fireEvent.click(screen.getByLabelText('使用 role 默认'))
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => {
      expect(subagentService.update).toHaveBeenCalledWith('c1', expect.objectContaining({
        provider_id: null,
        model_id: null,
      }))
    })
  })

  it('Tab 5 内置能力默认值：file_system/shell/task_intel/crab_memory on，crab_messaging off', async () => {
    renderEditor()
    fireEvent.click(screen.getByText('内置能力'))
    expect(screen.getByLabelText('file_system')).toBeChecked()
    expect(screen.getByLabelText('shell')).toBeChecked()
    expect(screen.getByLabelText('task_intel')).toBeChecked()
    expect(screen.getByLabelText('crab_memory')).toBeChecked()
    expect(screen.getByLabelText('crab_messaging')).not.toBeChecked()
  })

  it('create mode 保存调 POST', async () => {
    const onSaved = vi.fn()
    renderEditor({ onSaved })
    const nameInput = screen.getByLabelText('名称') as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: 'my_new_one' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => {
      expect(subagentService.create).toHaveBeenCalledWith(expect.objectContaining({
        name: 'my_new_one',
      }))
      expect(onSaved).toHaveBeenCalled()
    })
  })

  it('edit mode 保存调 PATCH with id', async () => {
    const onSaved = vi.fn()
    renderEditor({
      mode: 'edit',
      entry: makeEntry({ id: 'c-42' }),
      onSaved,
    })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => {
      expect(subagentService.update).toHaveBeenCalledWith('c-42', expect.any(Object))
      expect(onSaved).toHaveBeenCalled()
    })
  })

  it('MCP 白名单勾选存 server name 而非 id（运行时按 name 过滤）', async () => {
    // 内置 server id 每实例随机，运行时工具名是 mcp__<name>__*，白名单必须存 name 才能匹配。
    ;(mcpService.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'random-id-xyz', name: 'git', enabled: true },
    ])
    renderEditor()
    const nameInput = screen.getByLabelText('名称') as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: 'my_new_one' } })
    fireEvent.click(screen.getByText('MCP + Skill 白名单'))
    const gitCheckbox = await screen.findByLabelText('git')
    fireEvent.click(gitCheckbox)
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => {
      expect(subagentService.create).toHaveBeenCalledWith(
        expect.objectContaining({ allowed_mcp_server_ids: ['git'] }),
      )
    })
  })
})
