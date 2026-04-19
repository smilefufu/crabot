import React from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { DialogObjectsPage } from './index'

describe('DialogObjectsPage', () => {
  it('renders inside router context', () => {
    render(
      <MemoryRouter initialEntries={['/dialog-objects']}>
        <Routes>
          <Route path="/dialog-objects" element={<DialogObjectsPage />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(screen.getByRole('heading', { name: '对话对象管理' })).toBeInTheDocument()
  })
})
