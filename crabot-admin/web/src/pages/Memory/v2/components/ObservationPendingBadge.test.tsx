import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ObservationPendingBadge } from './ObservationPendingBadge'

describe('ObservationPendingBadge', () => {
  it('shows count', () => {
    render(<ObservationPendingBadge count={5} onClick={() => {}} />)
    expect(screen.getByText(/观察期：5/)).toBeInTheDocument()
  })

  it('hidden when count is 0', () => {
    const { container } = render(<ObservationPendingBadge count={0} onClick={() => {}} />)
    expect(container.firstChild).toBeNull()
  })

  it('triggers onClick', () => {
    const onClick = vi.fn()
    render(<ObservationPendingBadge count={2} onClick={onClick} />)
    fireEvent.click(screen.getByRole('button'))
    expect(onClick).toHaveBeenCalled()
  })
})
