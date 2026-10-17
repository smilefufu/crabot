import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { DesktopDiagnosticsPanel } from './DesktopDiagnosticsPanel'

const mocks = vi.hoisted(() => ({ getDiagnostics: vi.fn(), exportDiagnostics: vi.fn(), revealDataFolder: vi.fn() }))
vi.mock('../services/desktop-host', () => ({ desktopBridge: mocks }))
const report = { schema_version: 1, report_id: 'b232f3cb-a297-440f-8aba-03af28359e36', created_at: '2026-10-18T00:00:00Z',
  system: { platform: 'darwin', arch: 'arm64', os_release: 'fixture' }, state: { phase: 'error', app_version: 'fixture', platform: 'darwin', code: 'CRABOT_RUNTIME_INVALID' },
  runtime: { status: 'unavailable', versions: {} }, resources: [{ name: 'native_helper', status: 'unavailable' }], recent: [] }
beforeEach(() => { vi.clearAllMocks(); mocks.getDiagnostics.mockResolvedValue(report); mocks.exportDiagnostics.mockResolvedValue(true) })
it('renders independent local diagnostics and exports the exact preview ID, with no Admin request', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch')
  try {
    render(<DesktopDiagnosticsPanel />)
    expect(await screen.findByText('入口检查未通过，请修复安装')).toBeInTheDocument()
    expect(screen.getByText('error · CRABOT_RUNTIME_INVALID')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '导出基础诊断' }))
    expect(await screen.findByRole('status')).toHaveTextContent('诊断文件已保存')
    expect(mocks.exportDiagnostics).toHaveBeenCalledWith(report.report_id)
    expect(fetcher).not.toHaveBeenCalled()
  } finally { fetcher.mockRestore() }
})
it('a failed check remains recoverable and never offers an unreviewed export', async () => {
  mocks.getDiagnostics.mockRejectedValueOnce(new Error('fixture unavailable'))
  render(<DesktopDiagnosticsPanel />)
  expect(await screen.findByRole('status')).toHaveTextContent('本地诊断暂时无法读取')
  expect(screen.getByRole('button', { name: '导出基础诊断' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '重新检查' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '导出基础诊断' })).not.toBeDisabled())
  expect(mocks.exportDiagnostics).not.toHaveBeenCalled()
})
