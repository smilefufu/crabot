import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { ProviderDrawerDetail } from './ProviderDrawerDetail'
import type { ModelProvider } from '../../types'
const refreshModels = vi.hoisted(() => vi.fn())
vi.mock('../../services/provider', () => ({ providerService: { refreshModels } }))
vi.mock('../../contexts/ToastContext', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
const provider: ModelProvider = { id: 'gemini', name: 'Gemini', type: 'manual', format: 'gemini', endpoint: 'https://example.test', api_key: 'key', models: [], status: 'inactive', created_at: '', updated_at: '' }
describe('Gemini model refresh', () => {
  it('exposes native sync for a manual Gemini provider and refreshes the parent view', async () => {
    refreshModels.mockResolvedValue({ models: [], added: [], removed: [] })
    const onRefresh = vi.fn()
    render(<ProviderDrawerDetail provider={provider} onEdit={vi.fn()} onDelete={vi.fn()} onRefresh={onRefresh} />)
    fireEvent.click(screen.getByRole('button', { name: '同步模型' }))
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1))
    expect(refreshModels).toHaveBeenCalledWith('gemini')
  })
  it('keeps other manual formats unchanged', () => {
    render(<ProviderDrawerDetail provider={{ ...provider, format: 'openai' }} onEdit={vi.fn()} onDelete={vi.fn()} onRefresh={vi.fn()} />)
    expect(screen.queryByRole('button', { name: '同步模型' })).toBeNull()
  })
})
