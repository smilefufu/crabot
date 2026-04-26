import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { MemoryV2Page } from './MemoryV2Page'
import { memoryV2Service } from '../../../services/memoryV2'

vi.mock('../../../services/memoryV2', () => ({
  memoryV2Service: {
    listEntries: vi.fn(),
    getEntry: vi.fn(),
    deleteEntry: vi.fn(),
    patchEntry: vi.fn(),
    createEntry: vi.fn(),
    restoreEntry: vi.fn(),
    getEvolutionMode: vi.fn(),
    setEvolutionMode: vi.fn(),
    getObservationPending: vi.fn(),
    runMaintenance: vi.fn(),
    keywordSearch: vi.fn(),
    markObservationPass: vi.fn(),
    extendObservationWindow: vi.fn(),
  },
}))

vi.mock('../../../components/Layout/MainLayout', () => ({
  MainLayout: ({ children }: any) => <div>{children}</div>,
}))

vi.mock('../../../contexts/ToastContext', () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn() }),
}))

const mocked = memoryV2Service as unknown as Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  vi.clearAllMocks()
  mocked.listEntries.mockResolvedValue({ items: [] })
  mocked.getEvolutionMode.mockResolvedValue({ mode: 'balanced', last_changed_at: '', reason: '' })
  mocked.getObservationPending.mockResolvedValue({ items: [] })
})

function renderPage() {
  return render(<MemoryRouter><MemoryV2Page /></MemoryRouter>)
}

describe('MemoryV2Page — overall shell', () => {
  it('renders chinese title 长期记忆', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByRole('heading', { name: '长期记忆' })).toBeInTheDocument())
  })

  it('top tabs: 全部记忆 + 观察期', async () => {
    mocked.getObservationPending.mockResolvedValue({
      items: [{ id: 'g1', type: 'lesson', brief: 'x', promoted_at: '2026-04-20T00:00:00Z', observation_window_days: 7, validation_outcome: 'pending' }],
    })
    renderPage()
    await waitFor(() => expect(screen.getByRole('button', { name: /全部记忆/ })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /观察期.*1/ })).toBeInTheDocument()
  })

  it('top bar has 新建记忆 button', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByRole('button', { name: '+ 新建记忆' })).toBeInTheDocument())
  })

  it('top bar has 手动维护 dropdown', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByRole('button', { name: /手动维护/ })).toBeInTheDocument())
  })

  it('clicking 观察期 tab renders ObservationPendingPanel content', async () => {
    mocked.getObservationPending.mockResolvedValue({
      items: [{ id: 'g1', type: 'lesson', brief: '飞书表情', promoted_at: '2026-04-20T00:00:00Z', observation_window_days: 7, validation_outcome: 'pending' }],
    })
    renderPage()
    await waitFor(() => expect(screen.getByRole('button', { name: /观察期/ })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /观察期/ }))
    await waitFor(() => expect(screen.getByText('飞书表情')).toBeInTheDocument())
  })

  it('全部记忆 tab renders chips for type and status', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByRole('button', { name: '事实' })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: '经验' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '已确认' })).toBeInTheDocument()
  })

  it('does not render "Proposals" or "v2" or "Add memory" english text', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByRole('heading', { name: '长期记忆' })).toBeInTheDocument())
    expect(screen.queryByText(/^v2$/)).toBeNull()
    expect(screen.queryByText(/Proposals/)).toBeNull()
    expect(screen.queryByText(/Add memory/)).toBeNull()
  })
})
