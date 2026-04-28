import React from 'react'
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

const TITLE_BY_DOMAIN: Record<DialogDomain, string> = {
  friends: '好友',
  privatePool: '私聊池',
  groups: '群聊',
}

function describe(item: DialogObjectListItem): { title: string; subtitle: string; tag?: string } {
  if ('display_name' in item) {
    const friend = item as DialogObjectFriend
    return {
      title: friend.display_name,
      subtitle: `${friend.identities.length} 个渠道身份`,
      tag: friend.permission === 'master' ? 'Master' : undefined,
    }
  }
  return {
    title: 'title' in item ? item.title : '',
    subtitle: 'channel_id' in item ? `${item.channel_id} · ${item.type}` : '',
  }
}

export const ObjectList: React.FC<ObjectListProps> = ({ domain, items, selectedId, onSelect }) => {
  return (
    <div className="dlg-list">
      <div className="dlg-list__header">
        <span className="dlg-list__title">{TITLE_BY_DOMAIN[domain]}</span>
        <span className="dlg-list__count">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <div className="dlg-list__empty">当前对象域暂无数据</div>
      ) : (
        <ul className="dlg-list__items">
          {items.map((item) => {
            const active = item.id === selectedId
            const { title, subtitle, tag } = describe(item)
            return (
              <li key={`${domain}:${item.id}`}>
                <button
                  type="button"
                  aria-label={title}
                  onClick={() => onSelect(item.id)}
                  className={`dlg-list__item${active ? ' is-active' : ''}`}
                >
                  <span className="dlg-list__item-title">
                    {title}
                    {tag && <span className="dlg-intent-badge dlg-intent-badge--pair">{tag}</span>}
                  </span>
                  <span className="dlg-list__item-subtitle">{subtitle}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
