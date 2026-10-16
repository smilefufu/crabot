import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ComputerUseSetupCard } from './ComputerUseSetupCard'
import { computerUseService, type ComputerUseSetupStatus } from '../../services/computerUse'
vi.mock('../../services/computerUse', async load => {
  const real: any = await load()
  return { ...real, computerUseService: { status: vi.fn(), start: vi.fn(), cancel: vi.fn(), reveal: vi.fn() } }
})
vi.mock('../../contexts/ToastContext', () => ({ useToast: () => ({ error: vi.fn(), success: vi.fn() }) }))
const status: ComputerUseSetupStatus = { enabled: true, standard: true, host: { platform: 'darwin', hostname: 'Crabot 的电脑', session: 'active' },
  permissions: { accessibility: 'granted', screen_recording: 'missing' }, capture: { status: 'unverified' }, runtime: { state: 'uninitialized' }, app_path: '/fixture/CuaDriver.app' }
beforeEach(() => { vi.clearAllMocks(); vi.mocked(computerUseService.status).mockResolvedValue(structuredClone(status)); vi.mocked(computerUseService.cancel).mockResolvedValue(status) })
const show = () => render(<MemoryRouter><ComputerUseSetupCard /></MemoryRouter>)
describe('guided desktop setup UI', () => {
  it('shows actual missing permission separately from enabled and never requests on mount', async () => {
    vi.mocked(computerUseService.status).mockResolvedValue({ ...status, runtime: { state: 'uninitialized', checks: [{ name: 'ax_capability', status: 'fail' }] } })
    show()
    expect(await screen.findByText('已启用 · 尚需屏幕录制授权')).toBeTruthy()
    expect(screen.getByText(/运行 Crabot 的电脑/)).toBeTruthy()
    expect(computerUseService.start).not.toHaveBeenCalled()
  })
  it('starts only from a human click and cancels its exact operation on leaving', async () => {
    vi.mocked(computerUseService.start).mockResolvedValue({ ...status, setup: { setup_id: 'current', phase: 'permissions', expires_at: new Date(Date.now() + 180000).toISOString() } })
    const page = show(); await screen.findByText(/尚需屏幕录制授权/)
    fireEvent.click(screen.getByRole('button', { name: '设置桌面控制' }))
    expect(await screen.findByText(/CuaDriver 是 Crabot/)).toBeTruthy()
    expect(screen.getByText('1. 辅助功能')).toBeTruthy(); expect(screen.getByText('2. 屏幕与系统音频录制')).toBeTruthy()
    page.unmount()
    expect(computerUseService.cancel).toHaveBeenCalledWith('current')
  })
  it('cancels even when the accepted POST arrives after the page was closed', async () => {
    let finish!: (value: ComputerUseSetupStatus) => void
    vi.mocked(computerUseService.start).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const page = show(); await screen.findByText(/尚需屏幕录制授权/)
    fireEvent.click(screen.getByRole('button', { name: '设置桌面控制' })); page.unmount()
    finish({ ...status, setup: { setup_id: 'late', phase: 'capture', expires_at: new Date().toISOString() } })
    await waitFor(() => expect(computerUseService.cancel).toHaveBeenCalledWith('late'))
  })
  it('requests cancellation with keepalive when the browser page exits', async () => {
    vi.mocked(computerUseService.start).mockResolvedValue({ ...status, setup: { setup_id: 'leaving', phase: 'permissions', expires_at: new Date(Date.now() + 180000).toISOString() } })
    show(); await screen.findByText(/尚需屏幕录制授权/)
    fireEvent.click(screen.getByRole('button', { name: '设置桌面控制' }))
    await screen.findByText(/CuaDriver 是 Crabot/)
    fireEvent(window, new Event('pagehide'))
    expect(computerUseService.cancel).toHaveBeenCalledWith('leaving', true)
  })
  it('keeps disabled and no-GUI conditions visible without asking the user to find an App', async () => {
    vi.mocked(computerUseService.status).mockResolvedValue({ ...status, enabled: false })
    show()
    expect(await screen.findByText('已禁用')).toBeTruthy()
    expect(screen.getByRole('button', { name: '设置桌面控制' })).toBeDisabled()
  })
  it('shows non-mac native prerequisites without macOS grant instructions', async () => {
    const windows: ComputerUseSetupStatus = { ...status, host: { platform: 'win32', hostname: '测试电脑', session: 'active' },
      permissions: { accessibility: 'not_applicable', screen_recording: 'not_applicable' }, capture: { status: 'verified' },
      runtime: { state: 'ready', checks: [{ name: 'session_active', status: 'pass' }, { name: 'ax_capability', status: 'fail' }] } }
    vi.mocked(computerUseService.status).mockResolvedValue(windows)
    vi.mocked(computerUseService.start).mockResolvedValue(windows)
    show(); await screen.findByText('已启用 · 桌面环境检查未通过')
    fireEvent.click(screen.getByRole('button', { name: '设置桌面控制' }))
    expect(await screen.findByText('原生控件读取')).toBeTruthy()
    expect(screen.getByText('未通过')).toBeTruthy()
    expect(screen.queryByText('1. 辅助功能')).toBeNull()
    expect(screen.getByText(/Windows/)).toBeTruthy()
  })
})
