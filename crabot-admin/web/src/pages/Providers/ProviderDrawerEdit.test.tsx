import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ModelProvider } from '../../types'
import { ProviderDrawerEdit } from './ProviderDrawerEdit'

const updateProvider = vi.hoisted(() => vi.fn())

vi.mock('../../services/provider', () => ({
  providerService: { updateProvider },
}))

vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}))

const presetProvider: ModelProvider = {
  id: 'provider-1',
  name: 'OpenAI',
  type: 'preset',
  format: 'openai',
  endpoint: 'https://api.openai.com/v1',
  api_key: 'test-api-key',
  preset_vendor: 'openai',
  models: [
    {
      model_id: 'gpt-4o',
      display_name: 'GPT-4o',
      type: 'llm',
      supports_vision: true,
      context_window: 128000,
    },
    { model_id: 'gpt-image-1', display_name: 'GPT Image 1', type: 'image' },
  ],
  status: 'active',
  created_at: '2026-08-27T00:00:00.000Z',
  updated_at: '2026-08-27T00:00:00.000Z',
}

describe('ProviderDrawerEdit', () => {
  it('allows editing a preset provider model list without dropping retained metadata', async () => {
    updateProvider.mockResolvedValueOnce(presetProvider)
    const onSave = vi.fn()

    render(
      <ProviderDrawerEdit provider={presetProvider} onSave={onSave} onCancel={vi.fn()} />,
    )

    fireEvent.change(screen.getByRole('textbox', { name: 'LLM 模型（每行一个）' }), {
      target: { value: 'gpt-4o\ngpt-5' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(updateProvider).toHaveBeenCalledWith('provider-1', {
        name: 'OpenAI',
        endpoint: 'https://api.openai.com/v1',
        api_key: 'test-api-key',
        models: [
          {
            model_id: 'gpt-4o',
            display_name: 'GPT-4o',
            type: 'llm',
            supports_vision: true,
            context_window: 128000,
          },
          { model_id: 'gpt-5', display_name: 'gpt-5', type: 'llm' },
          { model_id: 'gpt-image-1', display_name: 'GPT Image 1', type: 'image' },
        ],
      })
    })
    expect(onSave).toHaveBeenCalledOnce()
  })
})
