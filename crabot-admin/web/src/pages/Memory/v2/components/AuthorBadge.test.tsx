import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AuthorBadge } from './AuthorBadge'

describe('AuthorBadge', () => {
  it('renders user with user variant', () => {
    render(<AuthorBadge author="user" />)
    const badge = screen.getByText('user')
    expect(badge.className).toMatch(/mem-author--user/)
  })

  it('renders agent:xxx with other variant', () => {
    render(<AuthorBadge author="agent:foo-1" />)
    const badge = screen.getByText('agent:foo-1')
    expect(badge.className).toMatch(/mem-author--other/)
  })

  it('renders system with system variant', () => {
    render(<AuthorBadge author="system" />)
    const badge = screen.getByText('system')
    expect(badge.className).toMatch(/mem-author--system/)
  })
})
