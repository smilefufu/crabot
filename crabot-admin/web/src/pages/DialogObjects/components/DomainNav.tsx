import React from 'react'

export type DialogDomain = 'friends' | 'privatePool' | 'groups'

const domainOptions: Array<{ key: DialogDomain; label: string }> = [
  { key: 'friends', label: '好友' },
  { key: 'privatePool', label: '私聊池' },
  { key: 'groups', label: '群聊' },
]

interface DomainNavProps {
  activeDomain: DialogDomain
  onChange: (domain: DialogDomain) => void
  counts?: Partial<Record<DialogDomain, number>>
}

export const DomainNav: React.FC<DomainNavProps> = ({ activeDomain, onChange, counts }) => (
  <div className="dlg-domain-switch" role="tablist" aria-label="对象域">
    {domainOptions.map((option) => {
      const active = option.key === activeDomain
      const count = counts?.[option.key]
      return (
        <button
          key={option.key}
          type="button"
          role="tab"
          aria-selected={active}
          onClick={() => onChange(option.key)}
          className={`dlg-domain-switch__btn${active ? ' is-active' : ''}`}
        >
          {option.label}
          {typeof count === 'number' && (
            <span className="dlg-domain-switch__count">{count}</span>
          )}
        </button>
      )
    })}
  </div>
)
