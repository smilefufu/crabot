import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ModelProvider } from '../../types'
import { ProviderDrawerDetail } from './ProviderDrawerDetail'

vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}))

const provider: ModelProvider = {
  id: 'provider-1',
  name: 'OpenAI compatible',
  type: 'manual',
  format: 'openai',
  endpoint: 'https://example.com/v1',
  api_key: 'test-api-key',
  models: [
    { model_id: 'gpt-4o', display_name: 'GPT-4o', type: 'llm' },
    { model_id: 'gpt-image-1', display_name: 'GPT Image 1', type: 'image' },
  ],
  status: 'active',
  created_at: '2026-07-14T00:00:00.000Z',
  updated_at: '2026-07-14T00:00:00.000Z',
}

describe('ProviderDrawerDetail', () => {
  it('only renders the first-token speed test for chat models', () => {
    render(
      <ProviderDrawerDetail
        provider={provider}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onRefresh={vi.fn()}
      />,
    )

    const llmRow = screen.getByText('gpt-4o').closest<HTMLElement>('.model-table-row')
    const imageRow = screen.getByText('gpt-image-1').closest<HTMLElement>('.model-table-row')

    expect(llmRow).not.toBeNull()
    expect(imageRow).not.toBeNull()
    expect(within(llmRow!).getByRole('button', { name: '测速' })).toBeInTheDocument()
    expect(within(imageRow!).queryByRole('button', { name: '测速' })).toBeNull()
  })
})
