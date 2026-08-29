/**
 * 槽位思考强度 UI（2026-08 spec §7.2/§9.6）：
 * 下拉默认"跟随默认"；选档位/自定义后保存 payload 携带正确 thinking 字段；
 * 自定义纯数字 + 非 anthropic format 的弱提示。
 */
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { AgentConfig } from './AgentConfig'
import { agentService } from '../../services/agent'

vi.mock('../../components/Layout/MainLayout', () => ({
  MainLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

const toastError = vi.fn()
vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ success: vi.fn(), error: toastError, info: vi.fn() }),
}))

vi.mock('../../services/mcp', () => ({
  mcpService: { list: vi.fn().mockResolvedValue([]) },
}))
vi.mock('../../services/skill', () => ({
  skillService: { list: vi.fn().mockResolvedValue([]) },
}))

const updateConfig = vi.fn().mockResolvedValue({})
vi.mock('../../services/agent', () => ({
  agentService: {
    getConfig: vi.fn().mockResolvedValue({
      instance_id: 'inst-1',
      system_prompt: '',
      model_config: {},
      thinking: {},
      extra: {},
    }),
    updateConfig: (...args: unknown[]) => updateConfig(...args),
    getLLMRequirements: vi.fn().mockResolvedValue({
      requirements: [
        { key: 'powerful', required: true, description: '', recommended_capabilities: [] },
        { key: 'cost_effective', required: false, description: '', recommended_capabilities: [] },
      ],
      extra_schema: [],
    }),
  },
}))

const listProviders = vi.fn()
const getGlobalConfig = vi.fn()
vi.mock('../../services/provider', () => ({
  providerService: {
    listProviders: (...args: unknown[]) => listProviders(...args),
    getGlobalConfig: (...args: unknown[]) => getGlobalConfig(...args),
  },
}))

function mockProviders(format: string): void {
  listProviders.mockResolvedValue({
    items: [{
      id: 'p1',
      name: `Prov (${format})`,
      format,
      type: 'manual',
      endpoint: 'https://x.test',
      models: [{ model_id: 'm-1', display_name: 'Model 1', type: 'llm' }],
    }],
  })
  getGlobalConfig.mockResolvedValue({ default_llm_provider_id: 'p1' })
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AgentConfig />
    </MemoryRouter>,
  )
}

function thinkingSelects(): HTMLSelectElement[] {
  return screen.getAllByDisplayValue('思考：跟随默认') as HTMLSelectElement[]
}

describe('AgentConfig — 槽位思考强度', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    updateConfig.mockClear()
    toastError.mockClear()
  })

  it('每个槽位有思考下拉且默认跟随默认；选"高"后保存 payload 携带 thinking_level', async () => {
    mockProviders('anthropic')
    renderPage()
    // 等待角色行渲染（powerful + cost_effective 各一个思考下拉）
    const thinking = await vi.waitFor(() => {
      const found = thinkingSelects()
      expect(found.length).toBe(2)
      return found
    })
    expect((thinking[0].selectedOptions[0] as HTMLOptionElement).text).toBe('思考：跟随默认')

    fireEvent.change(thinking[0], { target: { value: 'high' } })
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
    await vi.waitFor(() => {
      expect(updateConfig).toHaveBeenCalledWith(expect.objectContaining({
        thinking: { powerful: { thinking_level: 'high' } },
      }))
    })
  })

  it('选"自定义…"出现输入框（placeholder 按 anthropic 提示），保存透传 thinking_custom', async () => {
    mockProviders('anthropic')
    renderPage()
    const thinking = await vi.waitFor(() => {
      const found = thinkingSelects()
      expect(found.length).toBe(2)
      return found
    })
    fireEvent.change(thinking[0], { target: { value: 'custom' } })
    const input = await screen.findByPlaceholderText('如 xhigh / max；数字 budget 暂不建议（工具循环可能 400），优先用枚举档位')
    fireEvent.change(input, { target: { value: 'xhigh' } })
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
    await vi.waitFor(() => {
      expect(updateConfig).toHaveBeenCalledWith(expect.objectContaining({
        thinking: { powerful: { thinking_custom: 'xhigh' } },
      }))
    })
  })

  it('自定义纯数字在非 anthropic format 下显示弱提示', async () => {
    mockProviders('openai')
    renderPage()
    const thinking = await vi.waitFor(() => {
      const found = thinkingSelects()
      expect(found.length).toBe(2)
      return found
    })
    fireEvent.change(thinking[0], { target: { value: 'custom' } })
    await screen.findByPlaceholderText('如 minimal / xhigh / max')
    const input = screen.getByPlaceholderText('如 minimal / xhigh / max')
    fireEvent.change(input, { target: { value: '8192' } })
    expect(screen.getByText(/数字 budget 仅 anthropic 格式支持/)).toBeDefined()
  })

  it('getGlobalConfig 失败不影响 agent 配置装载（review 意见 2 回归：表单不得被打回空）', async () => {
    getGlobalConfig.mockRejectedValueOnce(new Error('boom'))
    ;(agentService.getConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      instance_id: 'inst-1',
      system_prompt: 'persona-x',
      model_config: {},
      thinking: {},
      extra: {},
    })
    renderPage()
    expect(await screen.findByDisplayValue('persona-x')).toBeDefined()
  })
})
