import React from 'react'
import { Button } from '../../../components/Common/Button'
import { Card } from '../../../components/Common/Card'
import { Input } from '../../../components/Common/Input'
import type {
  ChannelIdentity,
  DialogObjectFriend,
  FriendPermission,
  PermissionTemplate,
} from '../../../types'

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
  friendId?: string
  accessibleScopes?: string[]
  contextLabel?: string
}): string => {
  const search = new URLSearchParams()
  if (params.friendId) {
    search.set('friend_id', params.friendId)
  }
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

interface FriendWorkbenchProps {
  friend: DialogObjectFriend | null
  editName: string
  editPerm: FriendPermission
  editTemplateId: string
  permissionTemplates: PermissionTemplate[]
  savingFriend: boolean
  confirmUnlinkKey: string | null
  unlinkingIdentity: boolean
  onEditNameChange: (value: string) => void
  onEditPermChange: (value: FriendPermission) => void
  onEditTemplateChange: (value: string) => void
  onSave: () => void
  onOpenBindDrawer: () => void
  onRequestUnlink: (key: string) => void
  onCancelUnlink: () => void
  onConfirmUnlink: (identity: ChannelIdentity) => void
}

export const FriendWorkbench: React.FC<FriendWorkbenchProps> = ({
  friend,
  editName,
  editPerm,
  editTemplateId,
  permissionTemplates,
  savingFriend,
  confirmUnlinkKey,
  unlinkingIdentity,
  onEditNameChange,
  onEditPermChange,
  onEditTemplateChange,
  onSave,
  onOpenBindDrawer,
  onRequestUnlink,
  onCancelUnlink,
  onConfirmUnlink,
}) => {
  if (!friend) {
    return (
      <Card title="好友详情">
        <div style={{ color: 'var(--text-secondary)' }}>请选择一个对象</div>
      </Card>
    )
  }

  const friendSceneHref = buildSceneProfileHref(`friend:${friend.id}`)
  const friendMemoryHref = buildMemoryBrowserHref({
    friendId: friend.id,
    contextLabel: friend.display_name,
  })
  const isLockedMaster = friend.permission === 'master'
  const hasChanges = editName !== friend.display_name
    || editPerm !== friend.permission
    || editTemplateId !== (friend.permission_template_id ?? '')

  return (
    <Card title="好友详情">
      <div style={{ display: 'grid', gap: '1rem' }}>
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          <Input
            label="显示名称"
            aria-label="显示名称"
            value={editName}
            onChange={(event) => onEditNameChange(event.target.value)}
          />
          <label style={{ display: 'grid', gap: '0.35rem' }}>
            <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>权限</span>
            <select
              aria-label="权限"
              value={editPerm}
              onChange={(event) => onEditPermChange(event.target.value as FriendPermission)}
              disabled={isLockedMaster}
              className="select"
            >
              <option value="normal">Normal</option>
              <option value="master">Master</option>
            </select>
          </label>
          {editPerm === 'normal' && (
            <label style={{ display: 'grid', gap: '0.35rem' }}>
              <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>权限模板</span>
              <select
                aria-label="权限模板"
                value={editTemplateId}
                onChange={(event) => onEditTemplateChange(event.target.value)}
                className="select"
              >
                <option value="">未选择</option>
                {permissionTemplates
                  .filter((template) => template.id !== 'master_private')
                  .map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}{template.is_system ? ' (系统)' : ''}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <div style={{ display: 'flex', gap: '1rem', fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
            <span>状态：{friend.status === 'active' ? '活跃' : '无渠道'}</span>
            <span>权限等级：{friend.permission}</span>
          </div>
          <Button
            variant="primary"
            onClick={onSave}
            disabled={savingFriend || !editName.trim() || !hasChanges}
          >
            {savingFriend ? '保存中...' : '保存修改'}
          </Button>
        </div>

        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
            <strong>Channel 身份</strong>
            <Button variant="secondary" onClick={onOpenBindDrawer}>绑定新身份</Button>
          </div>
          {friend.identities.length === 0 ? (
            <div style={{ color: 'var(--text-secondary)' }}>暂无绑定的 Channel 身份</div>
          ) : (
            <div style={{ display: 'grid', gap: '0.75rem' }}>
              {friend.identities.map((identity) => {
                const key = `${identity.channel_id}:${identity.platform_user_id}`
                return (
                  <div
                    key={key}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '0.75rem',
                      borderRadius: '10px',
                      background: 'var(--bg-secondary)',
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 600 }}>{identity.platform_display_name}</div>
                      <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                        {identity.channel_id} / {identity.platform_user_id}
                      </div>
                    </div>
                    {confirmUnlinkKey === key ? (
                      <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <Button
                          variant="danger"
                          onClick={() => onConfirmUnlink(identity)}
                          disabled={unlinkingIdentity}
                        >
                          确认解绑
                        </Button>
                        <Button variant="secondary" onClick={onCancelUnlink}>
                          取消
                        </Button>
                      </div>
                    ) : (
                      <Button variant="danger" onClick={() => onRequestUnlink(key)}>
                        解绑
                      </Button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div style={{ display: 'grid', gap: '0.75rem' }}>
          <strong>私聊场景与记忆</strong>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <a
              href={friendSceneHref}
              aria-label="打开私聊场景画像"
              style={workbenchLinkStyle}
            >
              打开私聊场景画像
            </a>
            <a
              href={friendMemoryHref}
              aria-label="查看私聊记忆"
              style={workbenchLinkStyle}
            >
              查看私聊记忆
            </a>
          </div>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
            好友统一承接该人的私聊场景画像和私聊记忆范围。
          </div>
        </div>

        <div style={{ color: 'var(--text-secondary)' }}>
          权限在此编辑，场景与记忆通过独立工作台继续深入查看。
        </div>
      </div>
    </Card>
  )
}
