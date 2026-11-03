import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ProviderDrawerCreate } from './ProviderDrawerCreate'

const mocks = vi.hoisted(() => ({ list: vi.fn(), importVendor: vi.fn(), error: vi.fn(), success: vi.fn() }))
vi.mock('../../contexts/ToastContext', () => ({ useToast: () => ({ error: mocks.error, success: mocks.success }) }))
vi.mock('../../services/provider', () => ({ providerService: { listPresetVendors: mocks.list, importFromVendor: mocks.importVendor } }))
const vendors = [
  { id: 'openai', name: 'OpenAI', endpoint: 'https://api.openai.com/v1' },
  { id: 'dashscope', name: '阿里云百炼', endpoint: 'https://dashscope.aliyuncs.com' },
  { id: 'dashscope-coding', name: '百炼 Coding Plan', endpoint: 'https://coding.example' },
  { id: 'ollama', name: 'Ollama', endpoint: 'http://localhost:11434/v1' },
]
beforeEach(() => { vi.clearAllMocks(); mocks.list.mockResolvedValue({ items: vendors }); mocks.importVendor.mockResolvedValue({ provider: { id: 'created' } }) })

it('shows local provider logos and omits only the retired new-provider choice', async () => {
  render(<ProviderDrawerCreate onCreated={vi.fn()} onCancel={vi.fn()} />)
  expect(await screen.findByRole('button', { name: /阿里云百炼/ })).toBeInTheDocument()
  expect(screen.queryByText('百炼 Coding Plan')).toBeNull()
  expect(screen.getByAltText('OpenAI Logo')).toHaveAttribute('src', '/assets/vendors/openai.svg')
  expect(screen.queryByLabelText('API Key')).toBeNull()
  expect(mocks.importVendor).not.toHaveBeenCalled()
})

it('requires explicit credentials and clears them when selecting a different provider', async () => {
  render(<ProviderDrawerCreate onCreated={vi.fn()} onCancel={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: /OpenAI/ }))
  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'fixture-key' } })
  fireEvent.click(screen.getByRole('button', { name: '重新选择供应商' }))
  fireEvent.click(screen.getByRole('button', { name: /阿里云百炼/ }))
  expect(screen.getByLabelText('API Key')).toHaveValue('')
  expect(mocks.importVendor).not.toHaveBeenCalled()
})

it('connects a local Ollama service without requiring a real credential', async () => {
  const created = vi.fn()
  render(<ProviderDrawerCreate onCreated={created} onCancel={vi.fn()} />)
  fireEvent.click((await screen.findByAltText('Ollama Logo')).closest('button')!)
  fireEvent.click(screen.getByRole('button', { name: '导入' }))
  await waitFor(() => expect(created).toHaveBeenCalledWith('created'))
  expect(mocks.importVendor).toHaveBeenCalledWith('ollama', 'ollama', undefined)
})
