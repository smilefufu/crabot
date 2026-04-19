import React from 'react'
import { Card } from '../../../components/Common/Card'
import type {
  DialogObjectFriend,
  DialogObjectGroupEntry,
  DialogObjectPrivatePoolEntry,
} from '../../../types'
import type { DialogDomain } from './DomainNav'

type DialogObjectListItem = DialogObjectFriend | DialogObjectPrivatePoolEntry | DialogObjectGroupEntry

interface ObjectListProps {
  domain: DialogDomain
  items: DialogObjectListItem[]
  selectedId: string | null
  onSelect: (id: string) => void
}

export const ObjectList: React.FC<ObjectListProps> = ({
  domain,
  items,
  selectedId,
  onSelect,
}) => {
  if (items.length === 0) {
    return (
      <Card title="对象列表">
        <div style={{ color: 'var(--text-secondary)' }}>
          当前对象域暂无数据
        </div>
      </Card>
    )
  }

  return (
    <Card title="对象列表">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {items.map((item) => {
          const active = item.id === selectedId
          const title = 'display_name' in item ? item.display_name : item.title
          const subtitle = 'display_name' in item
            ? `${item.identities.length} 个渠道身份`
            : `${item.channel_id} · ${item.type}`

          return (
            <button
              key={`${domain}:${item.id}`}
              type="button"
              aria-label={title}
              onClick={() => onSelect(item.id)}
              style={{
                width: '100%',
                textAlign: 'left',
                padding: '0.875rem 1rem',
                borderRadius: '12px',
                border: active ? '1px solid var(--primary)' : '1px solid var(--border)',
                background: active ? 'rgba(59, 130, 246, 0.06)' : 'var(--bg-primary)',
                color: 'var(--text-primary)',
                cursor: 'pointer',
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>{title}</div>
              <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>{subtitle}</div>
            </button>
          )
        })}
      </div>
    </Card>
  )
}
