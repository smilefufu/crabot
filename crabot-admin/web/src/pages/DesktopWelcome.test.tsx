import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import { DesktopWelcome } from './DesktopWelcome'

const mocks = vi.hoisted(() => ({ hasManagerModel: vi.fn(), choices: vi.fn(), selectDefault: vi.fn() }))
vi.mock('crabot-client', async () => ({ ...await vi.importActual('crabot-client'), ModelClient: class {
  hasManagerModel = mocks.hasManagerModel
  choices = mocks.choices
  selectDefault = mocks.selectDefault
} }))
vi.mock('../services/api', () => ({ getWebClient: () => ({}) }))
vi.mock('../services/server-state', () => ({ useServerScope: () => 'fixture' }))
vi.mock('./Providers/ProviderDrawerCreate', () => ({ ProviderDrawerCreate: ({ onCreated }: { onCreated(id: string): void }) =>
  <button onClick={() => onCreated('provider')}>完成显式模型服务配置</button> }))
const provider = { id: 'provider', name: '我的模型服务', status: 'active', models: [{ model_id: 'model', display_name: '我的模型', type: 'llm' }] }
beforeEach(() => {
  vi.clearAllMocks(); mocks.hasManagerModel.mockResolvedValue(false); mocks.choices.mockResolvedValue({ items: [provider] })
  mocks.selectDefault.mockResolvedValue({ config: { default_llm_provider_id: 'provider', default_llm_model_id: 'model' } })
})
function show() { render(<MemoryRouter><Routes><Route path="/" element={<DesktopWelcome />} /><Route path="/chat" element={<p>聊天页面</p>} /></Routes></MemoryRouter>) }

it('existing model configuration opens chat without asking for configuration or writing defaults', async () => {
  mocks.hasManagerModel.mockResolvedValue(true)
  show()
  expect(await screen.findByText('聊天页面')).toBeInTheDocument()
  expect(mocks.selectDefault).not.toHaveBeenCalled()
})
it('fresh users can skip model configuration without a password or permission step', async () => {
  mocks.choices.mockResolvedValue({ items: [] }); show()
  expect(await screen.findByRole('button', { name: '添加模型服务' })).toBeInTheDocument()
  expect(screen.queryByLabelText('密码')).toBeNull()
  fireEvent.click(screen.getByRole('link', { name: '稍后设置，进入应用' }))
  expect(await screen.findByText('聊天页面')).toBeInTheDocument()
  expect(mocks.selectDefault).not.toHaveBeenCalled()
})
it('explicit default selection saves references once, then opens chat for an actual reply', async () => {
  show()
  const save = await screen.findByRole('button', { name: '保存并开始聊天' })
  expect(mocks.selectDefault).not.toHaveBeenCalled()
  fireEvent.click(save)
  expect(await screen.findByText('聊天页面')).toBeInTheDocument()
  expect(mocks.selectDefault).toHaveBeenCalledOnce()
  expect(mocks.selectDefault).toHaveBeenCalledWith({ provider_id: 'provider', model_id: 'model' })
})
it('a lost save response preserves the selection and checks facts before allowing another write', async () => {
  mocks.selectDefault.mockRejectedValue(new Error('fixture response lost'))
  show(); fireEvent.click(await screen.findByRole('button', { name: '保存并开始聊天' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('未能确认保存结果')
  expect(screen.getByLabelText('模型服务')).toHaveValue('provider')
  expect(screen.getByRole('button', { name: '保存并开始聊天' })).toBeDisabled()
  mocks.hasManagerModel.mockResolvedValue(true)
  fireEvent.click(screen.getByRole('button', { name: '重新检查配置' }))
  await waitFor(() => expect(screen.getByText('聊天页面')).toBeInTheDocument())
  expect(mocks.selectDefault).toHaveBeenCalledOnce()
})
