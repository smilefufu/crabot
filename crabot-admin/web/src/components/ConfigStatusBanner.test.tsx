import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import { ConfigStatusBanner } from './ConfigStatusBanner'

vi.mock('../services/api', () => ({ api: { get: vi.fn().mockResolvedValue({ configured: false, missing: ['缺少 LLM 配置'], warnings: [] }) } }))

it('continues setup from the model services page when there is no inline configuration target', async () => {
  render(<MemoryRouter initialEntries={['/providers']}><Routes>
    <Route path="/providers" element={<ConfigStatusBanner />} />
    <Route path="/setup" element={<p>共用首次使用流程</p>} />
  </Routes></MemoryRouter>)
  fireEvent.click(await screen.findByRole('link', { name: /继续配置模型服务/ }))
  expect(await screen.findByText('共用首次使用流程')).toBeInTheDocument()
})
