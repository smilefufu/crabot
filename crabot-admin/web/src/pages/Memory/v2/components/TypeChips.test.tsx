import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TypeChips } from './TypeChips'

describe('TypeChips', () => {
  it('renders 4 chips with Chinese labels', () => {
    render(<TypeChips value="fact" onChange={() => {}} />)
    expect(screen.getByRole('button', { name: '事实' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '经验' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '概念' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '全部' })).toBeInTheDocument()
  })

  it('marks selected chip active via aria-pressed', () => {
    render(<TypeChips value="lesson" onChange={() => {}} />)
    expect(screen.getByRole('button', { name: '经验' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '事实' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('calls onChange with value when chip clicked', () => {
    const cb = vi.fn()
    render(<TypeChips value="fact" onChange={cb} />)
    fireEvent.click(screen.getByRole('button', { name: '概念' }))
    expect(cb).toHaveBeenCalledWith('concept')
  })

  it('onChange with null when 全部 clicked', () => {
    const cb = vi.fn()
    render(<TypeChips value="fact" onChange={cb} />)
    fireEvent.click(screen.getByRole('button', { name: '全部' }))
    expect(cb).toHaveBeenCalledWith(null)
  })
})
