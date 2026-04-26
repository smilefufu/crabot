import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ObservationPendingPanel } from './ObservationPendingPanel'
import { memoryV2Service } from '../../../../services/memoryV2'

vi.mock('../../../../services/memoryV2', () => ({
  memoryV2Service: {
    getObservationPending: vi.fn(),
    markObservationPass: vi.fn(),
    extendObservationWindow: vi.fn(),
    deleteEntry: vi.fn(),
  },
}))

const mocked = memoryV2Service as unknown as {
  getObservationPending: ReturnType<typeof vi.fn>
  markObservationPass: ReturnType<typeof vi.fn>
  extendObservationWindow: ReturnType<typeof vi.fn>
  deleteEntry: ReturnType<typeof vi.fn>
}

beforeEach(() => {
  vi.clearAllMocks()
  mocked.getObservationPending.mockResolvedValue({
    items: [
      { id: 'mem-l-1', type: 'lesson', brief: '飞书表情', promoted_at: '2026-04-20T00:00:00Z', observation_window_days: 7, validation_outcome: 'pending' },
    ],
  })
})

describe('ObservationPendingPanel', () => {
  it('shows loading then list', async () => {
    render(<ObservationPendingPanel />)
    expect(screen.getByText(/加载中/)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('飞书表情')).toBeInTheDocument())
  })

  it('renders 标记通过 / 延长观察 / 删除 buttons', async () => {
    render(<ObservationPendingPanel />)
    await waitFor(() => expect(screen.getByRole('button', { name: '标记通过' })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: '延长观察' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '删除' })).toBeInTheDocument()
  })

  it('click 标记通过 calls markObservationPass then refreshes', async () => {
    mocked.markObservationPass.mockResolvedValue({ id: 'mem-l-1', status: 'ok' })
    render(<ObservationPendingPanel />)
    await waitFor(() => expect(screen.getByRole('button', { name: '标记通过' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '标记通过' }))
    await waitFor(() => expect(mocked.markObservationPass).toHaveBeenCalledWith('mem-l-1'))
    expect(mocked.getObservationPending).toHaveBeenCalledTimes(2)
  })

  it('click 延长观察 calls extendObservationWindow', async () => {
    mocked.extendObservationWindow.mockResolvedValue({ id: 'mem-l-1', new_window_days: 14 })
    render(<ObservationPendingPanel />)
    await waitFor(() => expect(screen.getByRole('button', { name: '延长观察' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '延长观察' }))
    await waitFor(() => expect(mocked.extendObservationWindow).toHaveBeenCalledWith('mem-l-1'))
  })

  it('empty state', async () => {
    mocked.getObservationPending.mockResolvedValue({ items: [] })
    render(<ObservationPendingPanel />)
    await waitFor(() => expect(screen.getByText(/暂无观察期记忆/)).toBeInTheDocument())
  })
})
