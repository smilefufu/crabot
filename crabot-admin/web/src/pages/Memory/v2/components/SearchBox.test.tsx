import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SearchBox } from './SearchBox'

describe('SearchBox', () => {
  it('renders input + two mode toggles', () => {
    render(<SearchBox value="" mode="keyword" onChange={() => {}} onModeChange={() => {}} />)
    expect(screen.getByPlaceholderText(/搜索 摘要/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '关键字' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /语义相关/ })).toBeInTheDocument()
  })

  it('marks keyword mode active via aria-pressed', () => {
    render(<SearchBox value="" mode="keyword" onChange={() => {}} onModeChange={() => {}} />)
    expect(screen.getByRole('button', { name: '关键字' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('click semantic toggle calls onModeChange("semantic")', () => {
    const cb = vi.fn()
    render(<SearchBox value="" mode="keyword" onChange={() => {}} onModeChange={cb} />)
    fireEvent.click(screen.getByRole('button', { name: /语义相关/ }))
    expect(cb).toHaveBeenCalledWith('semantic')
  })

  it('typing in input calls onChange', () => {
    const cb = vi.fn()
    render(<SearchBox value="" mode="keyword" onChange={cb} onModeChange={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText(/搜索 摘要/), { target: { value: 'macOS' } })
    expect(cb).toHaveBeenCalledWith('macOS')
  })
})
