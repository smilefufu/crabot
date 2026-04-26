import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { EntryListTable } from './EntryListTable'
import type { MemoryEntryV2 } from '../../../../services/memoryV2'

const sample: MemoryEntryV2[] = [
  {
    id: 'mem-l-1', type: 'fact', status: 'confirmed', brief: '张三的微信',
    frontmatter: {
      id: 'mem-l-1', type: 'fact', maturity: 'confirmed',
      brief: '张三的微信', author: 'agent:foo',
      source_ref: { type: 'conversation' },
      source_trust: 4, content_confidence: 4,
      importance_factors: { proximity: 0.8, surprisal: 0.5, entity_priority: 0.5, unambiguity: 0.5 },
      entities: [], tags: ['#contact'],
      event_time: '2026-04-23T00:00:00Z', ingestion_time: '2026-04-23T00:00:00Z',
      version: 1,
    },
  },
]

describe('EntryListTable', () => {
  it('renders rows with brief', () => {
    render(<EntryListTable entries={sample} selectedIds={new Set()} onToggleSelect={() => {}} onRowClick={() => {}} />)
    expect(screen.getByText('张三的微信')).toBeInTheDocument()
  })

  it('shows author badge', () => {
    render(<EntryListTable entries={sample} selectedIds={new Set()} onToggleSelect={() => {}} onRowClick={() => {}} />)
    expect(screen.getByText('agent:foo')).toBeInTheDocument()
  })

  it('clicking checkbox triggers onToggleSelect', () => {
    const onToggle = vi.fn()
    render(<EntryListTable entries={sample} selectedIds={new Set()} onToggleSelect={onToggle} onRowClick={() => {}} />)
    const cb = screen.getAllByRole('checkbox').find(el => el.getAttribute('data-id') === 'mem-l-1')!
    fireEvent.click(cb)
    expect(onToggle).toHaveBeenCalledWith('mem-l-1')
  })

  it('clicking row triggers onRowClick', () => {
    const onClick = vi.fn()
    render(<EntryListTable entries={sample} selectedIds={new Set()} onToggleSelect={() => {}} onRowClick={onClick} />)
    fireEvent.click(screen.getByText('张三的微信'))
    expect(onClick).toHaveBeenCalledWith('mem-l-1')
  })

  it('shows select-all checkbox in header', () => {
    const onToggle = vi.fn()
    render(<EntryListTable entries={sample} selectedIds={new Set()} onToggleSelect={onToggle} onRowClick={() => {}} />)
    const cb = screen.getAllByRole('checkbox').find(el => el.getAttribute('data-role') === 'select-all')!
    fireEvent.click(cb)
    expect(onToggle).toHaveBeenCalledWith('__all__')
  })

  it('renders all three author color classes (user=blue, agent=gray, system=purple) — spec §9.1', () => {
    const baseFm = sample[0].frontmatter!
    const threeAuthors: MemoryEntryV2[] = [
      { ...sample[0], id: 'mem-l-user',   brief: 'user-row',   frontmatter: { ...baseFm, id: 'mem-l-user',   author: 'user' } },
      { ...sample[0], id: 'mem-l-agent',  brief: 'agent-row',  frontmatter: { ...baseFm, id: 'mem-l-agent',  author: 'agent:foo' } },
      { ...sample[0], id: 'mem-l-system', brief: 'system-row', frontmatter: { ...baseFm, id: 'mem-l-system', author: 'system' } },
    ]
    render(<EntryListTable entries={threeAuthors} selectedIds={new Set()} onToggleSelect={() => {}} onRowClick={() => {}} />)

    const userBadge = screen.getByText('user')
    const agentBadge = screen.getByText('agent:foo')
    const systemBadge = screen.getByText('system')

    expect(userBadge.className).toMatch(/mem-author--user/)
    expect(agentBadge.className).toMatch(/mem-author--other/)
    expect(systemBadge.className).toMatch(/mem-author--system/)
  })

  it('preserves entries iteration order (default sort = caller-provided)', () => {
    // 排序由父组件传入 sorted entries 决定；表格只忠实渲染顺序
    const baseFm = sample[0].frontmatter!
    const ordered: MemoryEntryV2[] = [
      { ...sample[0], id: 'mem-l-c', brief: 'C-row', frontmatter: { ...baseFm, id: 'mem-l-c', author: 'system' } },
      { ...sample[0], id: 'mem-l-a', brief: 'A-row', frontmatter: { ...baseFm, id: 'mem-l-a', author: 'user' } },
      { ...sample[0], id: 'mem-l-b', brief: 'B-row', frontmatter: { ...baseFm, id: 'mem-l-b', author: 'agent:x' } },
    ]
    render(<EntryListTable entries={ordered} selectedIds={new Set()} onToggleSelect={() => {}} onRowClick={() => {}} />)
    const briefs = ['C-row', 'A-row', 'B-row'].map(t => screen.getByText(t))
    // DOM 顺序应等于传入顺序（document.compareDocumentPosition < 0 = preceding）
    expect(briefs[0].compareDocumentPosition(briefs[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(briefs[1].compareDocumentPosition(briefs[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('EntryListTable — Chinese headers + sorting', () => {
  it('renders chinese headers', () => {
    render(<EntryListTable entries={sample} selectedIds={new Set()} onToggleSelect={() => {}} onRowClick={() => {}} />)
    expect(screen.getByText('作者')).toBeInTheDocument()
    expect(screen.getByText('摘要')).toBeInTheDocument()
    expect(screen.getByText('标签')).toBeInTheDocument()
    expect(screen.getByText('置信度')).toBeInTheDocument()
    expect(screen.getByText('入库时间')).toBeInTheDocument()
  })

  it('clicking 入库时间 header calls onSortChange with ingestion_time', () => {
    const onSortChange = vi.fn()
    render(<EntryListTable
      entries={sample} selectedIds={new Set()} onToggleSelect={() => {}} onRowClick={() => {}}
      sort={{ column: 'ingestion_time', direction: 'desc' }} onSortChange={onSortChange}
    />)
    fireEvent.click(screen.getByRole('button', { name: /入库时间/ }))
    expect(onSortChange).toHaveBeenCalledWith({ column: 'ingestion_time', direction: 'asc' })
  })

  it('renders TrashRowActions for trash rows when mode=trash', () => {
    const onRestore = vi.fn()
    const trashSample: MemoryEntryV2[] = [{ ...sample[0], status: 'trash' }]
    render(<EntryListTable
      entries={trashSample} selectedIds={new Set()} onToggleSelect={() => {}} onRowClick={() => {}}
      trashMode onTrashRestore={onRestore}
    />)
    expect(screen.getByRole('button', { name: /restore/i })).toBeInTheDocument()
  })
})
