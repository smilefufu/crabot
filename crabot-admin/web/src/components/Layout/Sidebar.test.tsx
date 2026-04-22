import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { Sidebar } from './Sidebar'

describe('Sidebar', () => {
  it('only highlights scene profiles for /memory/scenes', () => {
    render(
      <MemoryRouter initialEntries={['/memory/scenes']}>
        <Sidebar />
      </MemoryRouter>,
    )

    expect(screen.getByRole('link', { name: '场景画像' })).toHaveClass('active')
    expect(screen.getByRole('link', { name: '记忆' })).not.toHaveClass('active')
  })
})
