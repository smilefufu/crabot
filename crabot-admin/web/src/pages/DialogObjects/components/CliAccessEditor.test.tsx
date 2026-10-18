import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CliAccessEditor } from './CliAccessEditor'
import { createCliAccessConfig } from '../../../types'

describe('CliAccessEditor', () => {
  const baseValue = createCliAccessConfig('none')

  it('默认露出 4 个常用 domain（schedule / mcp / skill / channel）', () => {
    render(<CliAccessEditor value={baseValue} onChange={() => {}} />)
    expect(screen.getByText(/Schedule/)).toBeInTheDocument()
    expect(screen.getByText(/MCP/)).toBeInTheDocument()
    expect(screen.getByText(/Skill/)).toBeInTheDocument()
    expect(screen.getByText(/Channel/)).toBeInTheDocument()
    expect(screen.queryByText(/Provider/)).not.toBeInTheDocument()
  })

  it('展开「高级」后显示剩余 6 个 domain', () => {
    render(<CliAccessEditor value={baseValue} onChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /高级/ }))
    expect(screen.getByText(/Provider/)).toBeInTheDocument()
    expect(screen.getByText(/Agent/)).toBeInTheDocument()
    expect(screen.getByText(/好友/)).toBeInTheDocument()
    expect(screen.getByText(/Permission/)).toBeInTheDocument()
    expect(screen.getByText(/Config/)).toBeInTheDocument()
    expect(screen.getByText(/Undo/)).toBeInTheDocument()
  })

  it('点 write radio 触发 onChange 携带新 cli_access', () => {
    let captured: typeof baseValue | null = null
    render(<CliAccessEditor value={baseValue} onChange={(v) => { captured = v }} />)
    const scheduleWrite = screen.getByLabelText('schedule-write')
    fireEvent.click(scheduleWrite)
    expect(captured!.schedule).toBe('write')
  })
})
