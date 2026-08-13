import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ManualCleanupDialog, AutoCleanupSettingsDialog } from './CleanupDialogs'
import { agentObservabilityService } from '../../services/agent-observability'
import { providerService } from '../../services/provider'
import { ToastProvider } from '../../contexts/ToastContext'

vi.mock('../../services/agent-observability')
vi.mock('../../services/provider')

describe('ManualCleanupDialog', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('预览 → 显示影响数', async () => {
    ;(agentObservabilityService.cleanupOldTraces as ReturnType<typeof vi.fn>).mockResolvedValue({
      affected_count: 156, affected_bytes: 4_400_000, deleted_trace_ids: [],
    })
    render(<ToastProvider><ManualCleanupDialog open onClose={vi.fn()} onDeleted={vi.fn()} /></ToastProvider>)
    const dayInput = screen.getByLabelText(/天前/) as HTMLInputElement
    fireEvent.change(dayInput, { target: { value: '30' } })
    fireEvent.click(screen.getByText('预览'))
    await waitFor(() => {
      expect(screen.getByText(/156 条 trace/)).toBeInTheDocument()
    })
    expect(agentObservabilityService.cleanupOldTraces).toHaveBeenCalledWith(30, true)
  })

  it('确认删除 → 调 dry_run=false', async () => {
    ;(agentObservabilityService.cleanupOldTraces as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ affected_count: 5, affected_bytes: 1024, deleted_trace_ids: [] })
      .mockResolvedValueOnce({ affected_count: 5, affected_bytes: 1024, deleted_trace_ids: ['t1','t2','t3','t4','t5'] })
    const onDeleted = vi.fn()
    render(<ToastProvider><ManualCleanupDialog open onClose={vi.fn()} onDeleted={onDeleted} /></ToastProvider>)
    fireEvent.change(screen.getByLabelText(/天前/), { target: { value: '30' } })
    fireEvent.click(screen.getByText('预览'))
    await waitFor(() => screen.getByText(/5 条 trace/))
    fireEvent.click(screen.getByText('确认删除'))
    await waitFor(() => {
      expect(agentObservabilityService.cleanupOldTraces).toHaveBeenLastCalledWith(30, false)
      expect(onDeleted).toHaveBeenCalled()
    })
  })
})

describe('AutoCleanupSettingsDialog', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('toggle off 时保存 days/count 都为 null', async () => {
    ;(providerService.getGlobalConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ trace_retention_days: 30 })
    ;(providerService.updateGlobalConfig as ReturnType<typeof vi.fn>).mockResolvedValue({})
    render(<ToastProvider><AutoCleanupSettingsDialog open onClose={vi.fn()} /></ToastProvider>)
    await waitFor(() => screen.getByLabelText('启用自动清理'))
    fireEvent.click(screen.getByLabelText('启用自动清理'))  // 关
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => {
      expect(providerService.updateGlobalConfig).toHaveBeenCalledWith({
        trace_retention_days: null,
        task_retention_count: null,
      })
    })
  })

  it('启用 + days 模式（默认）+ 输入 7 → 保存 days=7 / count=null', async () => {
    ;(providerService.getGlobalConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ trace_retention_days: null, task_retention_count: null })
    ;(providerService.updateGlobalConfig as ReturnType<typeof vi.fn>).mockResolvedValue({})
    render(<ToastProvider><AutoCleanupSettingsDialog open onClose={vi.fn()} /></ToastProvider>)
    await waitFor(() => screen.getByLabelText('启用自动清理'))
    fireEvent.click(screen.getByLabelText('启用自动清理'))
    fireEvent.change(screen.getByLabelText('保留最近天数'), { target: { value: '7' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => {
      expect(providerService.updateGlobalConfig).toHaveBeenCalledWith({
        trace_retention_days: 7,
        task_retention_count: null,
      })
    })
  })

  it('启用 + 切到 count 模式 + 输入 200 → 保存 count=200 / days=null', async () => {
    ;(providerService.getGlobalConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ trace_retention_days: null, task_retention_count: null })
    ;(providerService.updateGlobalConfig as ReturnType<typeof vi.fn>).mockResolvedValue({})
    render(<ToastProvider><AutoCleanupSettingsDialog open onClose={vi.fn()} /></ToastProvider>)
    await waitFor(() => screen.getByLabelText('启用自动清理'))
    fireEvent.click(screen.getByLabelText('启用自动清理'))
    fireEvent.click(screen.getByLabelText('按任务数清理'))
    fireEvent.change(screen.getByLabelText('保留最近任务数'), { target: { value: '200' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => {
      expect(providerService.updateGlobalConfig).toHaveBeenCalledWith({
        trace_retention_days: null,
        task_retention_count: 200,
      })
    })
  })

  it('加载已存的 count → 默认选中 count 模式', async () => {
    ;(providerService.getGlobalConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ trace_retention_days: null, task_retention_count: 500 })
    ;(providerService.updateGlobalConfig as ReturnType<typeof vi.fn>).mockResolvedValue({})
    render(<ToastProvider><AutoCleanupSettingsDialog open onClose={vi.fn()} /></ToastProvider>)
    await waitFor(() => screen.getByLabelText('按任务数清理'))
    const countRadio = screen.getByLabelText('按任务数清理') as HTMLInputElement
    const daysRadio = screen.getByLabelText('按天清理') as HTMLInputElement
    expect(countRadio.checked).toBe(true)
    expect(daysRadio.checked).toBe(false)
    expect((screen.getByLabelText('保留最近任务数') as HTMLInputElement).value).toBe('500')
  })

  it('同时存在 days/count 时 days 优先', async () => {
    ;(providerService.getGlobalConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ trace_retention_days: 10, task_retention_count: 500 })
    ;(providerService.updateGlobalConfig as ReturnType<typeof vi.fn>).mockResolvedValue({})
    render(<ToastProvider><AutoCleanupSettingsDialog open onClose={vi.fn()} /></ToastProvider>)
    await waitFor(() => screen.getByLabelText('按天清理'))
    expect((screen.getByLabelText('按天清理') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('保留最近天数') as HTMLInputElement).value).toBe('10')
  })
})
