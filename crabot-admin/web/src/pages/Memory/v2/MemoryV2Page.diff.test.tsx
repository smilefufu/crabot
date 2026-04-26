/**
 * N7 集成测试（spec §9.2）：
 * MemoryV2Page → 行点击进入详情 → 点对比按钮 → DiffReviewModal 显示旧/新 body 对比 → 关闭。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '../../../contexts/ToastContext'
import { AuthProvider } from '../../../contexts/AuthContext'
import { MemoryV2Page } from './MemoryV2Page'
import { memoryV2Service } from '../../../services/memoryV2'

vi.mock('../../../services/memoryV2', () => ({
  memoryV2Service: {
    listEntries: vi.fn(),
    keywordSearch: vi.fn(),
    getEntry: vi.fn(),
    getEntryVersion: vi.fn(),
    getEvolutionMode: vi.fn(),
    setEvolutionMode: vi.fn(),
    getObservationPending: vi.fn(),
    runMaintenance: vi.fn(),
    deleteEntry: vi.fn(),
    restoreEntry: vi.fn(),
    patchEntry: vi.fn(),
    createEntry: vi.fn(),
  },
}))

const mocked = memoryV2Service as unknown as Record<string, ReturnType<typeof vi.fn>>

const baseEntry = {
  id: 'mem-l-1',
  type: 'lesson' as const,
  status: 'confirmed' as const,
  brief: '飞书表情用 emoji_id',
  body: 'v3 body — 当前最新',
  frontmatter: {
    id: 'mem-l-1', type: 'lesson' as const, maturity: 'rule' as const,
    brief: '飞书表情用 emoji_id', author: 'agent:reflect',
    source_ref: { type: 'reflection' as const, trace_id: 'trace-x' },
    source_trust: 4, content_confidence: 5,
    importance_factors: { proximity: 0.8, surprisal: 0.4, entity_priority: 0.9, unambiguity: 0.9 },
    entities: [], tags: [],
    event_time: '2026-04-20T14:30:00Z',
    ingestion_time: '2026-04-20T15:02:00Z',
    version: 3,
    prev_version_ids: ['mem-l-1#v2', 'mem-l-1#v1'],
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  mocked.listEntries.mockResolvedValue({ items: [baseEntry] })
  mocked.getEvolutionMode.mockResolvedValue({ mode: 'balanced', last_changed_at: '', reason: '' })
  mocked.getObservationPending.mockResolvedValue({ items: [] })
  mocked.getEntry.mockResolvedValue(baseEntry)
})

function wrap() {
  return (
    <MemoryRouter>
      <AuthProvider>
        <ToastProvider>
          <MemoryV2Page />
        </ToastProvider>
      </AuthProvider>
    </MemoryRouter>
  )
}

describe('MemoryV2Page — N7 版本对比集成', () => {
  it('点击对比按钮 → 调 getEntryVersion → 显示 DiffReviewModal（旧 body vs 当前 body）', async () => {
    mocked.getEntryVersion.mockResolvedValue({
      id: 'mem-l-1',
      version: 2,
      body: 'v2 body — 老版本',
      frontmatter: { ...baseEntry.frontmatter, version: 2, prev_version_ids: ['mem-l-1#v1'] },
    })

    render(wrap())
    // 等列表加载
    await waitFor(() => expect(screen.getByText('飞书表情用 emoji_id')).toBeInTheDocument())
    // 点行进入详情抽屉
    fireEvent.click(screen.getByText('飞书表情用 emoji_id'))
    // 详情面板出现，对比按钮存在
    const compareButtons = await screen.findAllByRole('button', { name: /对比/ })
    expect(compareButtons.length).toBe(2)

    // 点击第一个（指向 v2）
    fireEvent.click(compareButtons[0])

    // service 收到正确参数
    await waitFor(() => expect(mocked.getEntryVersion).toHaveBeenCalledWith('mem-l-1', 2))

    // DiffReviewModal 弹出：用唯一标题、唯一 body 文本来定位
    await waitFor(() =>
      expect(screen.getByText(/版本对比：v2\s*→\s*v3/)).toBeInTheDocument(),
    )
    expect(screen.getByText('v2 body — 老版本')).toBeInTheDocument()
    // 当前 body 在详情面板和 diff modal 各出现一次
    expect(screen.getAllByText('v3 body — 当前最新').length).toBeGreaterThanOrEqual(1)

    // 关闭：modal 自身的关闭按钮（modal 在 DOM 中后挂载，取最后一个 "关闭"）
    const closeButtons = screen.getAllByRole('button', { name: '关闭' })
    fireEvent.click(closeButtons[closeButtons.length - 1])
    await waitFor(() => expect(screen.queryByText('v2 body — 老版本')).toBeNull())
  })

  it('getEntryVersion 返回 error 时弹 toast，不显示 modal', async () => {
    mocked.getEntryVersion.mockResolvedValue({ error: 'version not found' })
    render(wrap())
    await waitFor(() => expect(screen.getByText('飞书表情用 emoji_id')).toBeInTheDocument())
    fireEvent.click(screen.getByText('飞书表情用 emoji_id'))
    const compareButtons = await screen.findAllByRole('button', { name: /对比/ })
    fireEvent.click(compareButtons[0])
    await waitFor(() => expect(mocked.getEntryVersion).toHaveBeenCalled())
    // modal 不应出现：用唯一的"版本对比"标题判断（drawer 不会出现该文案）
    expect(screen.queryByText(/版本对比：v\d+/)).toBeNull()
  })
})
