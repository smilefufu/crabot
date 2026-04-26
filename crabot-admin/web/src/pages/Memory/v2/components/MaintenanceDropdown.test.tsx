import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MaintenanceDropdown } from './MaintenanceDropdown'

describe('MaintenanceDropdown', () => {
  it('trigger button shows 手动维护', () => {
    render(<MaintenanceDropdown onRun={() => Promise.resolve()} />)
    expect(screen.getByRole('button', { name: /手动维护/ })).toBeInTheDocument()
  })

  it('opening shows 4 options', () => {
    render(<MaintenanceDropdown onRun={() => Promise.resolve()} />)
    fireEvent.click(screen.getByRole('button', { name: /手动维护/ }))
    expect(screen.getByRole('menuitem', { name: /运行观察期检查/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /运行老化检查/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /清理回收站/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /全部运行/ })).toBeInTheDocument()
  })

  it('clicking option calls onRun with correct scope', () => {
    const onRun = vi.fn().mockResolvedValue(undefined)
    render(<MaintenanceDropdown onRun={onRun} />)
    fireEvent.click(screen.getByRole('button', { name: /手动维护/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /清理回收站/ }))
    expect(onRun).toHaveBeenCalledWith('trash_cleanup')
  })
})
