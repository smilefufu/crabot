import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { GlobalModelConfigCard } from './GlobalModelConfigCard'

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), success: vi.fn(), error: vi.fn() }))
vi.mock('../../services/provider', () => ({ providerService: { getGlobalConfig: mocks.read, updateGlobalConfig: mocks.write } }))
vi.mock('../../contexts/ToastContext', () => ({ useToast: () => ({ success: mocks.success, error: mocks.error }) }))
beforeEach(() => { vi.clearAllMocks() })

it('does not expose a writable empty form until the current configuration is known', async () => {
  let finish!: (value: object) => void
  mocks.read.mockReturnValue(new Promise(resolve => { finish = resolve }))
  render(<GlobalModelConfigCard providers={[]} />)
  expect(screen.getByRole('status')).toHaveTextContent('正在读取')
  expect(screen.queryByRole('button', { name: '保存为全局默认' })).toBeNull()
  finish({})
  await screen.findByLabelText('供应商')
  expect(mocks.write).not.toHaveBeenCalled()
})

it('preserves unknown configuration on read failure and recovers with a read-only retry', async () => {
  mocks.read.mockRejectedValueOnce(new Error('fixture offline')).mockResolvedValue({})
  render(<GlobalModelConfigCard providers={[]} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('已有设置保持保留')
  fireEvent.click(screen.getByRole('button', { name: '重新检查' }))
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  expect(mocks.write).not.toHaveBeenCalled()
})
