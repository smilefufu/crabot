import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ObservabilityRetentionCard } from './ObservabilityRetentionCard'
import { providerService } from '../../services/provider'
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('../../contexts/ToastContext', () => ({ useToast: () => toast }))
vi.mock('../../services/provider', () => ({ providerService: { getGlobalConfig: vi.fn(), updateGlobalConfig: vi.fn() } }))
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(providerService.getGlobalConfig).mockResolvedValue({ observability_retention_days: 12, default_llm_provider_id: 'p' })
  vi.mocked(providerService.updateGlobalConfig).mockImplementation(async config => config)
})
describe('observability retention setting', () => {
  it('shows the saved days and saves a valid replacement without dropping other global config', async () => {
    render(<ObservabilityRetentionCard />)
    const input = await screen.findByLabelText('观测历史保留天数')
    expect(input).toHaveValue(12)
    fireEvent.change(input, { target: { value: '9' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await vi.waitFor(() => expect(providerService.updateGlobalConfig).toHaveBeenCalledWith({ observability_retention_days: 9, default_llm_provider_id: 'p' }))
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledWith('观测历史保留天数已保存'))
  })
  it('keeps save disabled below one day', async () => {
    render(<ObservabilityRetentionCard />)
    const input = await screen.findByLabelText('观测历史保留天数')
    fireEvent.change(input, { target: { value: '0' } })
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
  })
})
