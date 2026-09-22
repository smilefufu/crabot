import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { ManagerDetail } from './ManagerDetail'
import { agentObservabilityService } from '../../services/agent-observability'

vi.mock('../../services/agent-observability')
vi.mock('../../components/Layout/MainLayout', () => ({ MainLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))
const messages = ['继续', '现在修复吧', '我不是说了让你现在修复吗？！'].map((preview, index) => ({
  platform_message_id: `m${index}`, platform_timestamp: `2026-09-20T14:0${index}:00.000Z`, preview,
}))
const episode = {
  trace_id: 'ep', manager_key: 'test::session', started_at: '2026-09-20T13:08:27.000Z', status: 'completed' as const,
  trigger: { type: 'human_message' as const, summary: '人类消息 x1：继续' }, spans: [], spawned_worker_ids: [],
  human_inputs: { coverage: 'complete' as const, items: messages },
  reply_excerpt: '最早的回复', latest_reply_excerpt: '已开始执行修复', latest_reply_at: '2026-09-20T14:10:13.000Z',
  actions: [{ kind: 'spawn_worker' as const, label: '派活：修复配置', worker_id: 'w1', occurred_at: '2026-09-20T14:09:59.000Z' }],
}
const page = { page: 1, page_size: 20, total_items: 1, total_pages: 1 }
function open() {
  render(<MemoryRouter initialEntries={['/traces/managers/test%3A%3Asession']}><Routes>
    <Route path="/traces/managers/:managerKey" element={<ManagerDetail />} />
  </Routes></MemoryRouter>)
}
describe('Manager episode human message history', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(agentObservabilityService.listManagers).mockResolvedValue({ items: [], pagination: page })
    vi.mocked(agentObservabilityService.listWorkers).mockResolvedValue({ items: [], pagination: page, total_active: 0, total_terminal: 0, total_legacy: 0, total_candidates: 0, total_attention: 0, total_running: 0, total_queued: 0, worker_views: {} })
    vi.mocked(agentObservabilityService.getManagerInboundStatus).mockResolvedValue({ manager_key: 'test::session', snapshot_at: '2026-09-20T14:11:00.000Z', items: [] })
    vi.mocked(agentObservabilityService.listManagerEpisodes).mockResolvedValue({ items: [episode], pagination: page })
  })
  it('retains all completed messages with latest first and a single shared activity', async () => {
    open()
    await screen.findByText('我不是说了让你现在修复吗？！')
    expect([...document.querySelectorAll('.manager-detail__event-title')].map(x => x.textContent)).toEqual(messages.map(x => x.preview).reverse())
    expect(screen.getAllByText('已开始执行修复', { exact: false })).toHaveLength(1)
    expect(screen.queryByText('最早的回复', { exact: false })).toBeNull()
    expect(screen.getAllByText('所属回合的操作')).toHaveLength(1)
    expect(document.querySelector('time[datetime="2026-09-20T14:09:59.000Z"]')).not.toBeNull()
  })
  it('deduplicates a stale processing snapshot after completion', async () => {
    vi.mocked(agentObservabilityService.getManagerInboundStatus).mockResolvedValue({ manager_key: 'test::session', snapshot_at: '2026-09-20T14:11:00.000Z',
      items: messages.map(item => ({ ...item, status: 'processing', episode_id: 'ep' })) })
    open()
    await screen.findByText('我不是说了让你现在修复吗？！')
    expect(document.querySelectorAll('.manager-detail__event-title')).toHaveLength(3)
    expect([...document.querySelectorAll('.manager-detail__event')].some(item => item.textContent?.includes('正在处理'))).toBe(false)
  })

  it('keeps already observed messages when inbound finishes before the historical response catches up', async () => {
    vi.useFakeTimers()
    vi.mocked(agentObservabilityService.listManagerEpisodes)
      .mockResolvedValueOnce({ items: [{ ...episode, status: 'running', human_inputs: { coverage: 'complete', items: messages.slice(0, 1) } }], pagination: page })
      .mockResolvedValue({ items: [{ ...episode, human_inputs: { coverage: 'complete', items: messages.slice(0, 1) } }], pagination: page })
    vi.mocked(agentObservabilityService.getManagerInboundStatus).mockResolvedValueOnce({ manager_key: 'test::session', snapshot_at: '2026-09-20T14:11:00.000Z',
      items: messages.map(item => ({ ...item, status: 'processing', episode_id: 'ep' })) })
    try {
      open()
      await act(async () => { await Promise.resolve() })
      expect(screen.getByText('我不是说了让你现在修复吗？！')).toBeInTheDocument()
      await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
      expect(screen.getByText('我不是说了让你现在修复吗？！')).toBeInTheDocument()
      expect(screen.getByText('消息记录不完整')).toBeInTheDocument()
    } finally { vi.useRealTimers() }
  })

  it('marks legacy records as missing detail and partial records as incomplete', async () => {
    vi.mocked(agentObservabilityService.listManagerEpisodes).mockResolvedValue({ items: [
      { ...episode, human_inputs: undefined },
      { ...episode, trace_id: 'partial', human_inputs: { coverage: 'partial', items: messages.slice(1) } },
    ], pagination: page })
    open()
    await screen.findByText('历史消息明细未记录')
    expect(screen.getByText('消息记录不完整')).toBeInTheDocument()
  })

})
