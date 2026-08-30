/**
 * 详情抽屉"上下文"chip 编辑（2026-08 spec §7.1 修订版）：
 * 已设置显示格式化值（K/M），未设置显示"设置…"虚线 chip；
 * 点击弹出编辑面板：常用档位点击即保存、自定义输入支持 K/M 单位、清除删字段。
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { ModelProvider } from '../../types'
import { ProviderDrawerDetail, formatContext, parseContextInput } from './ProviderDrawerDetail'
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

describe('context helpers', () => {
  it('formatContext：M/K 分档，不再出现 1000K', () => {
    expect(formatContext(1_000_000)).toBe('1M')
    expect(formatContext(2_000_000)).toBe('2M')
    expect(formatContext(1_572_864)).toBe('1.6M')
    expect(formatContext(128_000)).toBe('128K')
    expect(formatContext(500)).toBe('500')
  })

  it('parseContextInput：支持 K/M 后缀与裸数字，非法返回 null', () => {
    expect(parseContextInput('200K')).toBe(200_000)
    expect(parseContextInput('1m')).toBe(1_000_000)
    expect(parseContextInput('1.5M')).toBe(1_500_000)
    expect(parseContextInput('128000')).toBe(128_000)
    expect(parseContextInput('abc')).toBeNull()
    expect(parseContextInput('0')).toBeNull()
    expect(parseContextInput('-5K')).toBeNull()
  })
})

describe('ProviderDrawerDetail — 上下文 chip 编辑', () => {
  beforeEach(() => {
    updateProvider.mockClear()
  })

  it('已设置显示格式化 chip，未设置显示"设置…"虚线 chip', () => {
    renderDrawer(makeProvider([
      { model_id: 'm-1m', display_name: 'a', type: 'llm', context_window: 1_000_000 },
      { model_id: 'm-unset', display_name: 'b', type: 'llm' },
    ]))
    expect(screen.getByText('1M')).toBeInTheDocument()
    expect(screen.getByText('设置…')).toBeInTheDocument()
  })

  it('点 chip 弹出编辑面板，点常用档位立即保存并关闭', async () => {
    const { rerender } = renderDrawer(makeProvider([
      { model_id: 'm-unset', display_name: 'u', type: 'llm' },
    ]))
    fireEvent.click(screen.getByText('设置…'))

    // 面板出现：常用档位按钮可见
    expect(screen.getByText('上下文窗口（token 数）')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '128K' }))

    await waitFor(() => {
      expect(updateProvider).toHaveBeenCalledWith('provider-1', {
        models: [expect.objectContaining({ model_id: 'm-unset', context_window: 128_000 })],
      })
    })

    // 保存后父组件刷新（onRefresh）；模拟重渲染后 chip 显示新值
    rerender(
      <ProviderDrawerDetail
        provider={makeProvider([{ model_id: 'm-unset', display_name: 'u', type: 'llm', context_window: 128_000 }])}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onRefresh={vi.fn()}
      />,
    )
    expect(screen.getByText('128K')).toBeInTheDocument()
  })

  it('自定义输入支持 K/M 单位，保存解析为 token 数', async () => {
    renderDrawer(makeProvider([
      { model_id: 'm-x', display_name: 'x', type: 'llm' },
    ]))
    fireEvent.click(screen.getByText('设置…'))
    const input = screen.getByPlaceholderText('自定义：200K / 1M / 128000')
    fireEvent.change(input, { target: { value: '1.5M' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(updateProvider).toHaveBeenCalledWith('provider-1', {
        models: [expect.objectContaining({ model_id: 'm-x', context_window: 1_500_000 })],
      })
    })
  })

  it('非法输入显示错误提示且保存不可用，不发起请求', async () => {
    renderDrawer(makeProvider([
      { model_id: 'm-bad', display_name: 'b', type: 'llm' },
    ]))
    fireEvent.click(screen.getByText('设置…'))
    const input = screen.getByPlaceholderText('自定义：200K / 1M / 128000')
    fireEvent.change(input, { target: { value: 'abc' } })

    expect(screen.getByText(/无法识别/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
    expect(updateProvider).not.toHaveBeenCalled()
  })

  it('已设置的模型面板里有"清除"，点击删除字段', async () => {
    renderDrawer(makeProvider([
      { model_id: 'm-set', display_name: 's', type: 'llm', context_window: 128_000 },
    ]))
    fireEvent.click(screen.getByText('128K'))
    fireEvent.click(screen.getByRole('button', { name: '清除' }))

    await waitFor(() => {
      const call = updateProvider.mock.calls[0]
      const models = (call[1] as { models: Array<{ model_id: string; context_window?: number }> }).models
      expect(models[0].model_id).toBe('m-set')
      expect(models[0].context_window).toBeUndefined()
    })
  })
})
