import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { EvolutionModeModal } from './EvolutionModeModal'

describe('EvolutionModeModal', () => {
  it('renders all four modes with Chinese labels', () => {
    render(<EvolutionModeModal open={true} current="balanced" onClose={() => {}} onSubmit={async () => {}} />)
    expect(screen.getByLabelText('平衡')).toBeInTheDocument()
    expect(screen.getByLabelText('偏创新')).toBeInTheDocument()
    expect(screen.getByLabelText('偏稳固')).toBeInTheDocument()
    expect(screen.getByLabelText('仅修复')).toBeInTheDocument()
  })

  it('preselects current mode', () => {
    render(<EvolutionModeModal open={true} current="harden" onClose={() => {}} onSubmit={async () => {}} />)
    expect((screen.getByLabelText('偏稳固') as HTMLInputElement).checked).toBe(true)
  })

  it('submits selected mode + reason', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<EvolutionModeModal open={true} current="balanced" onClose={() => {}} onSubmit={onSubmit} />)
    fireEvent.click(screen.getByLabelText('偏创新'))
    fireEvent.change(screen.getByLabelText('切换原因'), { target: { value: '错误率降低' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('innovate', '错误率降低'))
  })

  it('does not render when closed', () => {
    render(<EvolutionModeModal open={false} current="balanced" onClose={() => {}} onSubmit={async () => {}} />)
    expect(screen.queryByLabelText('平衡')).not.toBeInTheDocument()
  })
})
