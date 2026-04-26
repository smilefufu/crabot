import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DiffReviewModal } from './DiffReviewModal'

describe('DiffReviewModal — 只读版本对比', () => {
  it('renders before/after panes with provided text', () => {
    render(
      <DiffReviewModal
        open
        title="对比 v3 与 v2"
        oldLabel="v2（2026-04-15）"
        newLabel="v3（当前）"
        oldText="旧版本正文"
        newText="新版本正文"
        onClose={() => {}}
      />,
    )
    expect(screen.getByText('旧版本正文')).toBeInTheDocument()
    expect(screen.getByText('新版本正文')).toBeInTheDocument()
    expect(screen.getByText('v2（2026-04-15）')).toBeInTheDocument()
    expect(screen.getByText('v3（当前）')).toBeInTheDocument()
    expect(screen.getByText('对比 v3 与 v2')).toBeInTheDocument()
  })

  it('does not render Approve / Reject / Edit buttons', () => {
    render(
      <DiffReviewModal open title="x" oldLabel="a" newLabel="b" oldText="a" newText="b" onClose={() => {}} />,
    )
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /reject/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull()
    expect(screen.queryByText(/通过|批准/)).toBeNull()
  })

  it('close button triggers onClose', () => {
    const onClose = vi.fn()
    render(<DiffReviewModal open title="x" oldLabel="a" newLabel="b" oldText="" newText="" onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /关闭/ }))
    expect(onClose).toHaveBeenCalled()
  })

  it('returns null when open=false', () => {
    const { container } = render(
      <DiffReviewModal open={false} title="x" oldLabel="a" newLabel="b" oldText="" newText="" onClose={() => {}} />,
    )
    expect(container.firstChild).toBeNull()
  })
})
