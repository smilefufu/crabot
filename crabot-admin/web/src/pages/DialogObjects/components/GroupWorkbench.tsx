import React from 'react'
import { Button } from '../../../components/Common/Button'
import { Card } from '../../../components/Common/Card'
import type { DialogObjectGroupEntry } from '../../../types'

const workbenchLinkStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '0.625rem 0.875rem',
  borderRadius: '10px',
  border: '1px solid var(--border)',
  background: 'var(--bg-secondary)',
  color: 'var(--text-primary)',
  textDecoration: 'none',
  fontSize: '0.875rem',
  fontWeight: 500,
}

const buildSceneProfileHref = (sceneKey: string): string => `/memory/scenes/${encodeURIComponent(sceneKey)}`

const buildMemoryBrowserHref = (params: {
  accessibleScopes?: string[]
  contextLabel?: string
}): string => {
  const search = new URLSearchParams()
  params.accessibleScopes?.forEach((scope) => {
    if (scope.trim()) {
      search.append('accessible_scope', scope.trim())
    }
  })
  if (params.contextLabel) {
    search.set('context_label', params.contextLabel)
  }
  const query = search.toString()
  return query ? `/memory?${query}` : '/memory'
}

interface GroupWorkbenchProps {
  group: DialogObjectGroupEntry | null
  onEditPermission: () => void
}

export const GroupWorkbench: React.FC<GroupWorkbenchProps> = ({
  group,
  onEditPermission,
}) => {
  if (!group) {
    return (
      <Card title="群聊详情">
        <div style={{ color: 'var(--text-secondary)' }}>请选择一个对象</div>
      </Card>
    )
  }

  const groupSceneHref = buildSceneProfileHref(`group:${group.channel_id}:${group.id}`)
  const groupMemoryHref = buildMemoryBrowserHref({
    accessibleScopes: [group.id],
    contextLabel: group.title,
  })

  return (
    <Card title="群聊详情">
      <div style={{ display: 'grid', gap: '0.75rem' }}>
        <div><strong>{group.title}</strong></div>
        <div>来源渠道：{group.channel_id}</div>
        <div>群成员数量：{group.participant_count}</div>
        <div>master_in_group：{group.master_in_group ? '是' : '否'}</div>
        <Button variant="secondary" onClick={onEditPermission}>
          编辑群权限
        </Button>
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          <strong>群场景与记忆</strong>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <a
              href={groupSceneHref}
              aria-label="打开群聊场景画像"
              style={workbenchLinkStyle}
            >
              打开群聊场景画像
            </a>
            <a
              href={groupMemoryHref}
              aria-label="查看群聊记忆"
              style={workbenchLinkStyle}
            >
              查看群聊记忆
            </a>
          </div>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
            当前群聊记忆入口默认按 session scope 过滤，和 `master_in_group` 可处理规则保持一致。
          </div>
        </div>
        <div style={{ color: 'var(--text-secondary)' }}>
          当前列表已和运行时 `master_in_group` 规则保持一致。
        </div>
      </div>
    </Card>
  )
}
