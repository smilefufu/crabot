import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { EvolutionModeBadge } from './EvolutionModeBadge'

describe('EvolutionModeBadge', () => {
  it('renders current mode in Chinese', () => {
    render(<EvolutionModeBadge mode="balanced" onClick={() => {}} />)
    expect(screen.getByText(/演化模式：平衡/)).toBeInTheDocument()
  })

  it('renders all four modes correctly', () => {
    const { rerender } = render(<EvolutionModeBadge mode="innovate" onClick={() => {}} />)
    expect(screen.getByText(/偏创新/)).toBeInTheDocument()
    rerender(<EvolutionModeBadge mode="harden" onClick={() => {}} />)
    expect(screen.getByText(/偏稳固/)).toBeInTheDocument()
    rerender(<EvolutionModeBadge mode="repair-only" onClick={() => {}} />)
    expect(screen.getByText(/仅修复/)).toBeInTheDocument()
  })

  it('calls onClick when clicked', () => {
    const onClick = vi.fn()
    render(<EvolutionModeBadge mode="harden" onClick={onClick} />)
    fireEvent.click(screen.getByRole('button'))
    expect(onClick).toHaveBeenCalled()
  })
})
