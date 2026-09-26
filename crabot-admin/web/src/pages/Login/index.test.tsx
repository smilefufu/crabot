import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Login } from './index'

const mocks = vi.hoisted(() => ({ login: vi.fn(), global: vi.fn(), agent: vi.fn() }))
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ login: mocks.login }) }))
vi.mock('../../services/provider', () => ({ providerService: { getGlobalConfig: mocks.global } }))
vi.mock('../../services/agent', () => ({ agentService: { getConfig: mocks.agent } }))

function submit() {
  render(<MemoryRouter initialEntries={['/login']}><Routes>
    <Route path="/login" element={<Login />} />
    <Route path="/chat" element={<div>聊天落地页</div>} />
    <Route path="/providers" element={<div>模型配置落地页</div>} />
  </Routes></MemoryRouter>)
  fireEvent.change(screen.getByPlaceholderText('请输入管理员密码'), { target: { value: 'password' } })
  fireEvent.click(screen.getByText('进入系统'))
}

describe('登录落地页', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.login.mockResolvedValue(undefined)
    mocks.global.mockResolvedValue({})
    mocks.agent.mockResolvedValue({ model_config: {} })
  })

  it('已配置全局模型时进入聊天', async () => {
    mocks.global.mockResolvedValue({ default_llm_provider_id: 'p', default_llm_model_id: 'm' })
    submit()
    expect(await screen.findByText('聊天落地页')).toBeInTheDocument()
  })

  it('只配置 Agent default slot 也进入聊天', async () => {
    mocks.agent.mockResolvedValue({ model_config: { default: { provider_id: 'p', model_id: 'm' } } })
    submit()
    expect(await screen.findByText('聊天落地页')).toBeInTheDocument()
  })

  it('未配置模型时进入配置', async () => {
    submit()
    expect(await screen.findByText('模型配置落地页')).toBeInTheDocument()
  })

  it('配置查询失败不把已成功登录显示成失败', async () => {
    mocks.global.mockRejectedValue(new Error('offline'))
    submit()
    expect(await screen.findByText('聊天落地页')).toBeInTheDocument()
  })

  it('密码错误时留在登录页且不查询配置', async () => {
    mocks.login.mockRejectedValue(new Error('密码错误'))
    submit()
    expect(await screen.findByText('密码错误')).toBeInTheDocument()
    expect(mocks.global).not.toHaveBeenCalled()
    expect(mocks.agent).not.toHaveBeenCalled()
  })
})
