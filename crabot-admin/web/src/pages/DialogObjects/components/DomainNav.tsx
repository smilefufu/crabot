import React from 'react'
import { Card } from '../../../components/Common/Card'

export type DialogDomain = 'friends' | 'privatePool' | 'groups'

const domainOptions: Array<{ key: DialogDomain; label: string }> = [
  { key: 'friends', label: '好友' },
  { key: 'privatePool', label: '私聊池' },
  { key: 'groups', label: '群聊' },
]

const sidebarButtonStyle = (active: boolean): React.CSSProperties => ({
  width: '100%',
  textAlign: 'left',
  padding: '0.75rem 0.875rem',
  borderRadius: '10px',
  border: active ? '1px solid var(--primary)' : '1px solid var(--border)',
  background: active ? 'rgba(59, 130, 246, 0.08)' : 'var(--bg-primary)',
  color: 'var(--text-primary)',
  cursor: 'pointer',
  fontSize: '0.95rem',
  fontWeight: active ? 600 : 500,
})

interface DomainNavProps {
  activeDomain: DialogDomain
  onChange: (domain: DialogDomain) => void
}

export const DomainNav: React.FC<DomainNavProps> = ({ activeDomain, onChange }) => (
  <Card title="对象域">
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {domainOptions.map((option) => (
        <button
          key={option.key}
          type="button"
          onClick={() => onChange(option.key)}
          style={sidebarButtonStyle(option.key === activeDomain)}
        >
          {option.label}
        </button>
      ))}
    </div>
  </Card>
)
