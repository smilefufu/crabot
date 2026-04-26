import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryDrawer } from './MemoryDrawer'

describe('MemoryDrawer', () => {
  it('does not render when open=false', () => {
    render(
      <MemoryDrawer open={false} title="T" onClose={() => {}}>
        <p>hidden body</p>
      </MemoryDrawer>,
    )
    expect(screen.queryByText('hidden body')).not.toBeInTheDocument()
  })

  it('renders title, eyebrow and body when open', () => {
    render(
      <MemoryDrawer open title="Title" eyebrow="EYE" onClose={() => {}}>
        <p>visible body</p>
      </MemoryDrawer>,
    )
    expect(screen.getByText('Title')).toBeInTheDocument()
    expect(screen.getByText('EYE')).toBeInTheDocument()
    expect(screen.getByText('visible body')).toBeInTheDocument()
  })

  it('fires onClose when clicking close button', () => {
    const onClose = vi.fn()
    render(
      <MemoryDrawer open title="T" onClose={onClose}>
        <p>body</p>
      </MemoryDrawer>,
    )
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('fires onClose when pressing Escape', () => {
    const onClose = vi.fn()
    render(
      <MemoryDrawer open title="T" onClose={onClose}>
        <p>body</p>
      </MemoryDrawer>,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
