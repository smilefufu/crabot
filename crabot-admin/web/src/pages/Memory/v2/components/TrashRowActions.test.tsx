import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TrashRowActions } from './TrashRowActions'

const NOW = new Date('2026-04-24T00:00:00Z')

describe('TrashRowActions — 30-day restore window (spec §6.5)', () => {
  it('renders enabled Restore button when entry is 1 day old', () => {
    const onRestore = vi.fn()
    render(<TrashRowActions ingestionTime="2026-04-23T00:00:00Z" now={() => NOW} onRestore={onRestore} />)
    const btn = screen.getByRole('button', { name: /restore/i }) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    expect(btn.dataset.expired).toBe('false')
    expect(btn.title).toMatch(/恢复到 inbox/)
  })

  it('renders disabled button when entry is exactly 30 days old (boundary)', () => {
    const onRestore = vi.fn()
    render(<TrashRowActions ingestionTime="2026-03-25T00:00:00Z" now={() => NOW} onRestore={onRestore} />)
    const btn = screen.getByRole('button', { name: /restore/i }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.dataset.expired).toBe('true')
  })

  it('renders disabled button with tooltip when entry is 35 days old', () => {
    const onRestore = vi.fn()
    render(<TrashRowActions ingestionTime="2026-03-20T00:00:00Z" now={() => NOW} onRestore={onRestore} />)
    const btn = screen.getByRole('button', { name: /restore/i }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.title).toMatch(/已过 30 天保留期/)
  })

  it('clicking enabled button invokes onRestore', () => {
    const onRestore = vi.fn()
    render(<TrashRowActions ingestionTime="2026-04-22T00:00:00Z" now={() => NOW} onRestore={onRestore} />)
    fireEvent.click(screen.getByRole('button', { name: /restore/i }))
    expect(onRestore).toHaveBeenCalledTimes(1)
  })

  it('clicking disabled button does NOT invoke onRestore', () => {
    const onRestore = vi.fn()
    render(<TrashRowActions ingestionTime="2026-01-01T00:00:00Z" now={() => NOW} onRestore={onRestore} />)
    fireEvent.click(screen.getByRole('button', { name: /restore/i }))
    expect(onRestore).not.toHaveBeenCalled()
  })

  it('respects custom retentionDays prop', () => {
    const onRestore = vi.fn()
    // 7 天前 + 自定义 7 天保留期 → 边界，禁用
    render(<TrashRowActions ingestionTime="2026-04-17T00:00:00Z" retentionDays={7} now={() => NOW} onRestore={onRestore} />)
    const btn = screen.getByRole('button', { name: /restore/i }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.title).toMatch(/已过 7 天保留期/)
  })

  it('treats invalid ingestion_time as expired (defensive)', () => {
    const onRestore = vi.fn()
    render(<TrashRowActions ingestionTime="not-a-date" now={() => NOW} onRestore={onRestore} />)
    const btn = screen.getByRole('button', { name: /restore/i }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })
})
