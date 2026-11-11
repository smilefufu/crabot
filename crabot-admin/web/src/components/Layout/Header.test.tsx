import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { Header } from './Header'

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ logout: vi.fn() }) }))
vi.mock('../../services/desktop-host', () => ({ isDesktop: false }))
vi.mock('../ChangePasswordDialog', () => ({ ChangePasswordDialog: () => null }))

it.each(['/channels/config', '/channels/new', '/channels/new/voice'])('协作相关页面 %s 的全局标题与导航名称一致', path => {
  render(<MemoryRouter initialEntries={[path]}><Header /></MemoryRouter>)
  expect(screen.getByRole('banner')).toHaveTextContent('协作入口')
  expect(screen.getByRole('banner')).not.toHaveTextContent('聊天方式')
})
