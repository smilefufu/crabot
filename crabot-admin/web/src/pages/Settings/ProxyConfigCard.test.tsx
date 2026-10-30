import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ProxyConfigCard } from './ProxyConfigCard'
import { proxyService } from '../../services/proxy'
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('../../contexts/ToastContext', () => ({ useToast: () => toast }))
vi.mock('../../services/proxy', () => ({ proxyService: { getConfig: vi.fn(), updateConfig: vi.fn() } }))
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(proxyService.getConfig).mockResolvedValue({ config: { mode: 'system' }, system_proxy_url: null })
  vi.mocked(proxyService.updateConfig).mockResolvedValue({ mode: 'system' })
})
describe('system proxy detection feedback', () => {
  it('describes native macOS detection and refreshes the effective address after saving system', async () => {
    vi.mocked(proxyService.getConfig)
      .mockResolvedValueOnce({ config: { mode: 'system' }, system_proxy_url: null })
      .mockResolvedValueOnce({ config: { mode: 'system' }, system_proxy_url: 'http://127.0.0.1:17890' })
    render(<ProxyConfigCard />)
    await screen.findByRole('button', { name: '保存' })
    expect(screen.getByText(/macOS/)).toHaveTextContent('HTTP/HTTPS')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText('http://127.0.0.1:17890')
    expect(proxyService.getConfig).toHaveBeenCalledTimes(2)
    expect(proxyService.updateConfig).toHaveBeenCalledWith({ mode: 'system' })
  })
  it('reports a detection refresh failure separately from a successful configuration save', async () => {
    vi.mocked(proxyService.getConfig)
      .mockResolvedValueOnce({ config: { mode: 'system' }, system_proxy_url: null })
      .mockRejectedValueOnce(new Error('fixture read failure'))
    render(<ProxyConfigCard />)
    fireEvent.click(await screen.findByRole('button', { name: '保存' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('配置已保存，但代理检测结果读取失败，请重新打开此页面查看'))
    expect(toast.error).not.toHaveBeenCalledWith('更新代理配置失败')
  })
})
