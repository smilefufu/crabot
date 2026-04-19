import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { DialogObjectsPage } from './index'

describe('DialogObjectsPage', () => {
  it('renders the placeholder heading', () => {
    render(<DialogObjectsPage />)

    expect(screen.getByRole('heading', { name: '对话对象管理' })).toBeInTheDocument()
  })
})
