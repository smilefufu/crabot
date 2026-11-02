import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { AgentConfig } from './AgentConfig'

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), success: vi.fn(), error: vi.fn() }))
vi.mock('../../services/agent', () => ({ agentService: { getConfig: mocks.read, updateConfig: mocks.write } }))
vi.mock('../../components/Layout/MainLayout', () => ({ MainLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock('../../contexts/ToastContext', () => ({ useToast: () => ({ success: mocks.success, error: mocks.error }) }))
beforeEach(() => { vi.clearAllMocks(); mocks.write.mockResolvedValue({}) })

it('edits only personality and cannot overwrite model slots or tool settings from this entry', async () => {
  mocks.read.mockResolvedValue({ system_prompt: '原有个性', model_config: { powerful: { provider_id: 'p', model_id: 'm' } }, extra: { enabled_tools: ['existing'] } })
  render(<AgentConfig profileOnly />)
  await screen.findByText('我的 CRABOT')
  expect(screen.queryByText('模型角色')).toBeNull()
  expect(screen.queryByText('时区')).toBeNull()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '温暖、坦诚。' } })
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }))
  await waitFor(() => expect(mocks.write).toHaveBeenCalledWith({ system_prompt: '温暖、坦诚。' }))
})

it('never saves an empty replacement personality after a configuration read failure', async () => {
  mocks.read.mockRejectedValue(new Error('fixture offline'))
  render(<AgentConfig profileOnly />)
  await screen.findByText('fixture offline')
  expect(screen.getByRole('button', { name: '保存配置' })).toBeDisabled()
  expect(mocks.write).not.toHaveBeenCalled()
})
