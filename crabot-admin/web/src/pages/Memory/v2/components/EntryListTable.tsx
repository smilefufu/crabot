import React from 'react'
import type { MemoryEntryV2 } from '../../../../services/memoryV2'
import { AuthorBadge } from './AuthorBadge'
import { TrashRowActions } from './TrashRowActions'

export type SortColumn = 'ingestion_time' | 'confidence'
export interface SortState { column: SortColumn; direction: 'asc' | 'desc' }

export interface EntryListTableProps {
  entries: MemoryEntryV2[]
  selectedIds: Set<string>
  onToggleSelect: (id: string) => void
  onRowClick: (id: string) => void
  sort?: SortState
  onSortChange?: (s: SortState) => void
  trashMode?: boolean
  onTrashRestore?: (id: string) => void | Promise<void>
}

function formatTime(iso?: string): string {
  if (!iso) return '-'
  try {
    const d = new Date(iso)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  } catch { return iso }
}

function HeaderButton({
  column, label, sort, onSortChange,
}: { column: SortColumn; label: string; sort?: SortState; onSortChange?: (s: SortState) => void }) {
  if (!onSortChange) return <>{label}</>
  const active = sort?.column === column
  const arrow = !active ? '' : sort!.direction === 'asc' ? ' ↑' : ' ↓'
  return (
    <button
      type="button"
      onClick={() => onSortChange({
        column,
        direction: active && sort!.direction === 'desc' ? 'asc' : 'desc',
      })}
    >
      {label}{arrow}
    </button>
  )
}

export const EntryListTable: React.FC<EntryListTableProps> = ({
  entries, selectedIds, onToggleSelect, onRowClick, sort, onSortChange, trashMode, onTrashRestore,
}) => (
  <table className="mem-table">
    <thead>
      <tr>
        <th className="mem-table__checkbox">
          <input
            type="checkbox"
            data-role="select-all"
            checked={selectedIds.size > 0 && selectedIds.size === entries.length}
            onChange={() => onToggleSelect('__all__')}
          />
        </th>
        <th>作者</th>
        <th>摘要</th>
        <th>标签</th>
        <th>
          <HeaderButton column="confidence" label="置信度" sort={sort} onSortChange={onSortChange} />
        </th>
        <th>
          <HeaderButton column="ingestion_time" label="入库时间" sort={sort} onSortChange={onSortChange} />
        </th>
        {trashMode && <th>操作</th>}
      </tr>
    </thead>
    <tbody>
      {entries.map(entry => {
        const fm = entry.frontmatter
        const author = fm?.author ?? '-'
        const tags = fm?.tags?.join(' ') ?? ''
        const conf = fm ? `${fm.source_trust}/${fm.content_confidence}` : '-'
        const updated = formatTime(fm?.ingestion_time)
        return (
          <tr key={entry.id} onClick={() => onRowClick(entry.id)}>
            <td className="mem-table__checkbox" onClick={e => e.stopPropagation()}>
              <input
                type="checkbox"
                data-id={entry.id}
                checked={selectedIds.has(entry.id)}
                onChange={() => onToggleSelect(entry.id)}
              />
            </td>
            <td><AuthorBadge author={author} /></td>
            <td className="mem-table__brief">{entry.brief}</td>
            <td className="mem-table__tags">{tags || '—'}</td>
            <td className="mem-table__meta">{conf}</td>
            <td className="mem-table__meta">{updated}</td>
            {trashMode && (
              <td onClick={e => e.stopPropagation()}>
                <TrashRowActions
                  ingestionTime={fm?.ingestion_time ?? new Date().toISOString()}
                  onRestore={() => onTrashRestore?.(entry.id)}
                />
              </td>
            )}
          </tr>
        )
      })}
    </tbody>
  </table>
)
