import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { StatusChips } from './StatusChips'

describe('StatusChips', () => {
  it('renders 3 chips with Chinese labels', () => {
    render(<StatusChips value="confirmed" onChange={() => {}} />)
    expect(screen.getByRole('button', { name: '待审' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '已确认' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '回收站' })).toBeInTheDocument()
  })

  it('calls onChange with status value', () => {
    const cb = vi.fn()
    render(<StatusChips value="confirmed" onChange={cb} />)
    fireEvent.click(screen.getByRole('button', { name: '待审' }))
    expect(cb).toHaveBeenCalledWith('inbox')
    fireEvent.click(screen.getByRole('button', { name: '回收站' }))
    expect(cb).toHaveBeenCalledWith('trash')
  })
})
