import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { EntryDetailPanel } from './EntryDetailPanel'
import type { MemoryEntryV2 } from '../../../../services/memoryV2'

function wrap(ui: React.ReactNode) {
  return <MemoryRouter>{ui}</MemoryRouter>
}

const entry: MemoryEntryV2 = {
  id: 'mem-l-1', type: 'lesson', status: 'confirmed',
  brief: '飞书表情用 emoji_id',
  body: '不要用图片 URL。',
  frontmatter: {
    id: 'mem-l-1', type: 'lesson', maturity: 'rule',
    brief: '飞书表情用 emoji_id', author: 'agent:reflect',
    source_ref: { type: 'reflection', task_id: 'task-1', session_id: 'sess-a', trace_id: 'trace-x' },
    source_trust: 4, content_confidence: 5,
    importance_factors: { proximity: 0.8, surprisal: 0.4, entity_priority: 0.9, unambiguity: 0.9 },
    entities: [{ type: 'user', id: 'master', name: 'master' }],
    tags: ['#channel:feishu'],
    event_time: '2026-04-20T14:30:00Z',
    ingestion_time: '2026-04-20T15:02:00Z',
    version: 3, prev_version_ids: ['mem-l-1#v2', 'mem-l-1#v1'],
    observation: { promoted_at: '2026-04-20T15:02:00Z', observation_window_days: 7, validation_outcome: 'pending' },
  },
}

describe('EntryDetailPanel — 6 sections', () => {
  it('renders 身份 / 来源 / 可信度 / 时间线 / 版本历史 / 正文 sections', () => {
    render(wrap(<EntryDetailPanel entry={entry} onEdit={() => {}} onDelete={() => {}} />))
    expect(screen.getByText(/身份/)).toBeInTheDocument()
    expect(screen.getByText(/来源/)).toBeInTheDocument()
    expect(screen.getByText(/可信度/)).toBeInTheDocument()
    expect(screen.getByText(/时间线/)).toBeInTheDocument()
    expect(screen.getByText(/版本历史/)).toBeInTheDocument()
  })

  it('shows trace_id as link to /traces/:id', () => {
    render(wrap(<EntryDetailPanel entry={entry} onEdit={() => {}} onDelete={() => {}} />))
    const link = screen.getByRole('link', { name: /trace-x/ }) as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/traces/trace-x')
  })

  it('shows version history with 对比 buttons for non-current versions', () => {
    render(wrap(<EntryDetailPanel entry={entry} onEdit={() => {}} onDelete={() => {}} />))
    expect(screen.getByText(/v3/)).toBeInTheDocument()
    expect(screen.getByText(/当前/)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /对比/ }).length).toBe(2)
  })

  it('clicking 对比 invokes onCompareVersion with the corresponding prev_version_id', () => {
    const onCompareVersion = vi.fn()
    render(wrap(
      <EntryDetailPanel
        entry={entry}
        onEdit={() => {}}
        onDelete={() => {}}
        onCompareVersion={onCompareVersion}
      />,
    ))
    const buttons = screen.getAllByRole('button', { name: /对比/ })
    expect(buttons.length).toBe(2)
    // 第一个按钮 → prev_version_ids[0] = 'mem-l-1#v2'
    fireEvent.click(buttons[0])
    expect(onCompareVersion).toHaveBeenLastCalledWith('mem-l-1#v2')
    // 第二个按钮 → prev_version_ids[1] = 'mem-l-1#v1'
    fireEvent.click(buttons[1])
    expect(onCompareVersion).toHaveBeenLastCalledWith('mem-l-1#v1')
    expect(onCompareVersion).toHaveBeenCalledTimes(2)
  })

  it('对比 button is a no-op when onCompareVersion not provided', () => {
    // 不应抛错——按钮存在但点击是 no-op
    render(wrap(<EntryDetailPanel entry={entry} onEdit={() => {}} onDelete={() => {}} />))
    const buttons = screen.getAllByRole('button', { name: /对比/ })
    expect(() => fireEvent.click(buttons[0])).not.toThrow()
  })

  it('renders invalidated_by banner when set', () => {
    const withInv: MemoryEntryV2 = {
      ...entry,
      frontmatter: { ...entry.frontmatter!, invalidated_by: 'mem-l-y' },
    }
    render(wrap(<EntryDetailPanel entry={withInv} onEdit={() => {}} onDelete={() => {}} />))
    expect(screen.getByText(/已被/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /mem-l-y/ })).toBeInTheDocument()
  })

  it('shows 恢复 / 永久删除 buttons instead of 编辑 / 删除 when status=trash', () => {
    const onRestore = vi.fn()
    const trash: MemoryEntryV2 = { ...entry, status: 'trash' }
    render(wrap(<EntryDetailPanel entry={trash} onEdit={() => {}} onDelete={() => {}} onRestore={onRestore} />))
    expect(screen.getByRole('button', { name: /恢复/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /永久删除/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^编辑$/ })).toBeNull()
  })

  it('shows 选择记忆查看详情 placeholder when entry is null', () => {
    render(wrap(<EntryDetailPanel entry={null} onEdit={() => {}} onDelete={() => {}} />))
    expect(screen.getByText(/选择记忆查看详情/)).toBeInTheDocument()
  })
})
