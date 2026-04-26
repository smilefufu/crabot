import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BatchActionBar } from './BatchActionBar'

describe('BatchActionBar', () => {
  it('returns null when count is 0', () => {
    const { container } = render(
      <BatchActionBar count={0} onBatchDelete={() => {}} onBatchEditTags={() => {}} onClear={() => {}} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('shows 已选 3 条 and buttons when count > 0', () => {
    render(<BatchActionBar count={3} onBatchDelete={() => {}} onBatchEditTags={() => {}} onClear={() => {}} />)
    expect(screen.getByText((_, el) => el?.tagName === 'SPAN' && el.textContent === '已选 3 条')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '批量删除' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '批量编辑标签' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取消选择' })).toBeInTheDocument()
  })

  it('fires callbacks', () => {
    const del = vi.fn(); const edit = vi.fn(); const clear = vi.fn()
    render(<BatchActionBar count={2} onBatchDelete={del} onBatchEditTags={edit} onClear={clear} />)
    fireEvent.click(screen.getByRole('button', { name: '批量删除' }))
    fireEvent.click(screen.getByRole('button', { name: '批量编辑标签' }))
    fireEvent.click(screen.getByRole('button', { name: '取消选择' }))
    expect(del).toHaveBeenCalled()
    expect(edit).toHaveBeenCalled()
    expect(clear).toHaveBeenCalled()
  })
})
