import { it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { VersionUpgradeCard } from './VersionUpgradeCard'

const mocks = vi.hoisted(() => ({ open: vi.fn(), server: vi.fn(), error: vi.fn(), success: vi.fn() }))
vi.mock('../../services/desktop-host', () => ({ isDesktop: true,
  desktopBridge: { openUpdateDialog: mocks.open }, useDesktopState: () => ({ app_version: '1.2.3', phase: 'stopped' }) }))
vi.mock('../../hooks/useSystemVersion', () => ({ useSystemVersion: mocks.server }))
vi.mock('../../services/version', () => ({ versionService: { startUpgrade: mocks.server } }))
vi.mock('../../contexts/ToastContext', () => ({ useToast: () => ({ error: mocks.error, success: mocks.success }) }))
beforeEach(() => { vi.clearAllMocks(); mocks.open.mockResolvedValue(true) })

it('desktop settings opens the native version channel while stopped, without a legacy server check or success claim', async () => {
  render(<VersionUpgradeCard />)
  expect(screen.getByText('1.2.3')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '打开桌面更新' }))
  await waitFor(() => expect(mocks.open).toHaveBeenCalledOnce())
  expect(mocks.server).not.toHaveBeenCalled(); expect(mocks.success).not.toHaveBeenCalled()
})
it('failure to present native UI remains a recoverable error, not an upgrade success', async () => {
  mocks.open.mockResolvedValue(false)
  render(<VersionUpgradeCard />); fireEvent.click(screen.getByRole('button', { name: '打开桌面更新' }))
  await waitFor(() => expect(mocks.error).toHaveBeenCalledOnce())
  expect(mocks.server).not.toHaveBeenCalled(); expect(mocks.success).not.toHaveBeenCalled()
})
