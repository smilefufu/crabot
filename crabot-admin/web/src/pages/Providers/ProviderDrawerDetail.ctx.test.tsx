/**
 * 详情抽屉"上下文"列编辑（2026-08 spec §7.1/§9.6）：
 * 未设置显示"默认 200K"；点击内联编辑；非法输入不保存；清空 = 删除字段。
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { ModelProvider } from '../../types'
import { ProviderDrawerDetail } from './ProviderDrawerDetail'
import { providerService } from '../../services/provider'

vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}))

vi.mock('../../services/provider', () => ({
  providerService: {
    updateProvider: vi.fn().mockResolvedValue({}),
  },
}))

const updateProvider = providerService.updateProvider as ReturnType<typeof vi.fn>

function makeProvider(models: ModelProvider['models']): ModelProvider {
  return {
    id: 'provider-1',
    name: 'Prov',
    type: 'manual',
    format: 'anthropic',
    endpoint: 'https://example.com',
    api_key: 'test-api-key',
    models,
    status: 'active',
    created_at: '2026-08-28T00:00:00.000Z',
    updated_at: '2026-08-28T00:00:00.000Z',
  }
}

function renderDrawer(provider: ModelProvider) {
  return render(
    <ProviderDrawerDetail
      provider={provider}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
      onRefresh={vi.fn()}
    />,
  )
}

describe('ProviderDrawerDetail — 上下文列', () => {
  beforeEach(() => {
    updateProvider.mockClear()
  })

  it('未设置显示"默认 200K"，已设置显示 K 格式化值', () => {
    renderDrawer(makeProvider([
      { model_id: 'm-unset', display_name: 'u', type: 'llm' },
      { model_id: 'm-set', display_name: 's', type: 'llm', context_window: 128000 },
    ]))
    expect(screen.getByText('默认 200K')).toBeInTheDocument()
    expect(screen.getByText('128K')).toBeInTheDocument()
  })

  it('点击进入内联编辑，保存合法值 → PATCH 全量 models 携带 context_window', async () => {
    const { rerender } = renderDrawer(makeProvider([
      { model_id: 'm-unset', display_name: 'u', type: 'llm' },
    ]))
    fireEvent.click(screen.getByText('默认 200K'))
    const input = screen.getByPlaceholderText('token 数')
    fireEvent.change(input, { target: { value: '128000' } })
    fireEvent.blur(input)

    await waitFor(() => {
      expect(updateProvider).toHaveBeenCalledWith('provider-1', {
        models: [expect.objectContaining({ model_id: 'm-unset', context_window: 128000 })],
      })
    })
    // onRefresh 触发后父组件会换新 provider；这里手动重渲染验证格式化显示
    rerender(
      <ProviderDrawerDetail
        provider={makeProvider([{ model_id: 'm-unset', display_name: 'u', type: 'llm', context_window: 128000 }])}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onRefresh={vi.fn()}
      />,
    )
    expect(screen.getByText('128K')).toBeInTheDocument()
  })

  it('清空输入保存 = 删除字段（context_window undefined）', async () => {
    renderDrawer(makeProvider([
      { model_id: 'm-set', display_name: 's', type: 'llm', context_window: 128000 },
    ]))
    fireEvent.click(screen.getByText('128K'))
    const input = screen.getByPlaceholderText('token 数')
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)

    await waitFor(() => {
      const call = updateProvider.mock.calls[0]
      const models = (call[1] as { models: Array<{ model_id: string; context_window?: number }> }).models
      expect(models[0].model_id).toBe('m-set')
      expect(models[0].context_window).toBeUndefined()
    })
  })

  it('非法输入（非正整数）不保存并提示', async () => {
    renderDrawer(makeProvider([
      { model_id: 'm-unset', display_name: 'u', type: 'llm' },
    ]))
    fireEvent.click(screen.getByText('默认 200K'))
    const input = screen.getByPlaceholderText('token 数')
    fireEvent.change(input, { target: { value: 'abc' } })
    fireEvent.blur(input)

    await waitFor(() => {
      expect(updateProvider).not.toHaveBeenCalled()
    })
  })
})
