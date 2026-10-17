import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ChangePasswordDialog } from './ChangePasswordDialog'

const mocks = vi.hoisted(() => ({ getMe: vi.fn(), changePassword: vi.fn(), reconnect: vi.fn(), logout: vi.fn(), success: vi.fn() }))
vi.mock('../services/auth', () => ({ authService: mocks }))
vi.mock('../services/desktop-host', () => ({ isDesktop: true, desktopBridge: { reconnect: mocks.reconnect } }))
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ logout: mocks.logout }) }))
vi.mock('../contexts/ToastContext', () => ({ useToast: () => ({ success: mocks.success }) }))
beforeEach(() => { vi.clearAllMocks(); mocks.changePassword.mockResolvedValue(undefined) })

it('first desktop browser password needs no old password and never quits the app', async () => {
  mocks.getMe.mockResolvedValue({ is_temp: false, password_configured: false, auth_method: 'desktop' })
  const close = vi.fn()
  render(<ChangePasswordDialog onClose={close} />)
  await waitFor(() => expect(mocks.getMe).toHaveBeenCalledOnce())
  expect(screen.queryByLabelText('旧密码')).toBeNull()
  fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'new-password' } })
  fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'new-password' } })
  await waitFor(() => expect(screen.getByRole('button', { name: '确定' })).not.toBeDisabled())
  fireEvent.click(screen.getByRole('button', { name: '确定' }))
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(mocks.changePassword).toHaveBeenCalledWith({ new_password: 'new-password' })
  expect(mocks.reconnect).toHaveBeenCalledOnce()
  expect(mocks.logout).not.toHaveBeenCalled()
})

it('an existing browser password still requires the old password', async () => {
  mocks.getMe.mockResolvedValue({ is_temp: true, password_configured: true, auth_method: 'desktop' })
  render(<ChangePasswordDialog onClose={vi.fn()} />)
  const old = await screen.findByLabelText('旧密码')
  fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'new-password' } })
  fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'new-password' } })
  expect(screen.getByRole('button', { name: '确定' })).toBeDisabled()
  fireEvent.change(old, { target: { value: 'existing-password' } })
  fireEvent.click(screen.getByRole('button', { name: '确定' }))
  await waitFor(() => expect(mocks.changePassword).toHaveBeenCalledWith({ old_password: 'existing-password', new_password: 'new-password' }))
})
