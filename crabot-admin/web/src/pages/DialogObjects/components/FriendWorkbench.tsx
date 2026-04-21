import React from 'react'
import { Button } from '../../../components/Common/Button'
import { Card } from '../../../components/Common/Card'
import { Input } from '../../../components/Common/Input'
import { Loading } from '../../../components/Common/Loading'
import { parseMemoryScopes, summarizeFriendMemoryScopes, summarizeFriendStorage } from '../friend-permission-utils'
import type {
  ChannelIdentity,
  DialogObjectFriend,
  FriendPermission,
  ToolAccessConfig,
  ToolCategory,
} from '../../../types'
import { TOOL_CATEGORIES, TOOL_CATEGORY_LABELS } from '../../../types'

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
  savingMetadata: boolean
  friendPermissionLoading: boolean
  friendPermissionState: 'idle' | 'loading' | 'ready' | 'unavailable'
  friendPermissionUnavailableMessage: string | null
  savingPermissions: boolean
  friendToolAccess: ToolAccessConfig
  friendStorageEnabled: boolean
  friendStoragePath: string
  friendStorageAccess: 'read' | 'readwrite'
  friendMemoryMode: 'empty' | 'custom'
  friendMemoryScopesInput: string
  confirmUnlinkKey: string | null
  unlinkingIdentity: boolean
  onEditNameChange: (value: string) => void
  onEditPermChange: (value: FriendPermission) => void
  onSaveMetadata: () => void
  onFriendToolAccessChange: (category: ToolCategory, checked: boolean) => void
  onFriendStorageEnabledChange: (enabled: boolean) => void
  onFriendStoragePathChange: (value: string) => void
  onFriendStorageAccessChange: (value: 'read' | 'readwrite') => void
  onFriendMemoryModeChange: (value: 'empty' | 'custom') => void
  onFriendMemoryScopesInputChange: (value: string) => void
  onSavePermissions: () => void
  onOpenBindDrawer: () => void
  onRequestUnlink: (key: string) => void
  onCancelUnlink: () => void
  onConfirmUnlink: (identity: ChannelIdentity) => void
}

const DEFAULT_STORAGE_PATH = '/workspace'

const PermissionSwitchRow: React.FC<{
  label: string
  category: ToolCategory
  checked: boolean
  onChange: (cat: ToolCategory, checked: boolean) => void
}> = ({ label, category, checked, onChange }) => {
  return (
    <label className="session-permission-switch-row">
      <span className="session-permission-switch-value">
        <span>{label}</span>
        <span>{checked ? '开启' : '关闭'}</span>
      </span>
      <span className="toggle-switch">
        <input
          aria-label={label}
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(category, event.target.checked)}
        />
        <span className="toggle-track" />
      </span>
    </label>
  )
}

export const FriendWorkbench: React.FC<FriendWorkbenchProps> = ({
  friend,
  editName,
  editPerm,
  savingMetadata,
  friendPermissionLoading,
  friendPermissionState,
  friendPermissionUnavailableMessage,
  savingPermissions,
  friendToolAccess,
  friendStorageEnabled,
  friendStoragePath,
  friendStorageAccess,
  friendMemoryMode,
  friendMemoryScopesInput,
  confirmUnlinkKey,
  unlinkingIdentity,
  onEditNameChange,
  onEditPermChange,
  onSaveMetadata,
  onFriendToolAccessChange,
  onFriendStorageEnabledChange,
  onFriendStoragePathChange,
  onFriendStorageAccessChange,
  onFriendMemoryModeChange,
  onFriendMemoryScopesInputChange,
  onSavePermissions,
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
  const canEditPermissions = friendPermissionState === 'ready'
  const hasChanges = editName !== friend.display_name
    || editPerm !== friend.permission
  const parsedMemoryScopes = parseMemoryScopes(friendMemoryScopesInput)
  const memorySummary = summarizeFriendMemoryScopes(friend.id, friendMemoryMode === 'empty' ? [] : parsedMemoryScopes)

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
          <div style={{ display: 'flex', gap: '1rem', fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
            <span>状态：{friend.status === 'active' ? '活跃' : '无渠道'}</span>
            <span>权限等级：{friend.permission}</span>
          </div>
          <Button
            variant="primary"
            onClick={onSaveMetadata}
            disabled={savingMetadata || !editName.trim() || !hasChanges}
          >
            {savingMetadata ? '保存中...' : '保存基础信息'}
          </Button>
        </div>

        <div className="dialog-object-permission-panel">
          <div style={{ display: 'grid', gap: '0.35rem' }}>
            <strong>好友权限</strong>
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
              直接编辑当前生效权限，保存后写入该好友的显式私聊权限配置。
            </div>
          </div>

          {isLockedMaster ? (
            <div className="dialog-object-permission-readonly">
              Master 好友权限保持锁定，不在这里编辑。
            </div>
          ) : friendPermissionLoading || friendPermissionState === 'loading' ? (
            <Loading />
          ) : !canEditPermissions ? (
            <div className="dialog-object-permission-readonly">
              {friendPermissionUnavailableMessage ?? '好友权限暂时不可编辑，请先刷新或修复加载错误。'}
            </div>
          ) : (
            <div style={{ display: 'grid', gap: '1rem' }}>
              <div className="session-modal-section">
                <div style={{ fontWeight: 600 }}>工具权限</div>
                <div className="session-permission-switch-list">
                  {TOOL_CATEGORIES.filter((category) => category !== 'desktop').map((category) => (
                    <PermissionSwitchRow
                      key={category}
                      label={TOOL_CATEGORY_LABELS[category]}
                      category={category}
                      checked={friendToolAccess[category]}
                      onChange={onFriendToolAccessChange}
                    />
                  ))}
                </div>
              </div>

              <div className="session-modal-section">
                <div style={{ fontWeight: 600 }}>存储权限</div>
                <label className="session-permission-switch-row">
                  <span className="session-permission-switch-value">
                    <span>启用存储</span>
                    <span>
                      {friendStorageEnabled
                        ? summarizeFriendStorage({
                            workspace_path: friendStoragePath.trim() || DEFAULT_STORAGE_PATH,
                            access: friendStorageAccess,
                          })
                        : '未开启'}
                    </span>
                  </span>
                  <span className="toggle-switch">
                    <input
                      aria-label="启用存储"
                      type="checkbox"
                      checked={friendStorageEnabled}
                      onChange={(event) => onFriendStorageEnabledChange(event.target.checked)}
                    />
                    <span className="toggle-track" />
                  </span>
                </label>
                {friendStorageEnabled && (
                  <div className="session-detail-grid">
                    <Input
                      label="工作区路径"
                      aria-label="工作区路径"
                      value={friendStoragePath}
                      onChange={(event) => onFriendStoragePathChange(event.target.value)}
                      help="输入当前好友私聊可访问的工作区路径。"
                    />
                    <label style={{ display: 'grid', gap: '0.35rem' }}>
                      <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>访问级别</span>
                      <select
                        aria-label="访问级别"
                        value={friendStorageAccess}
                        onChange={(event) => onFriendStorageAccessChange(event.target.value as 'read' | 'readwrite')}
                        className="select"
                      >
                        <option value="read">只读</option>
                        <option value="readwrite">读写</option>
                      </select>
                    </label>
                  </div>
                )}
              </div>

              <div className="session-modal-section">
                <div style={{ fontWeight: 600 }}>记忆范围</div>
                <div className="session-segmented-control" role="radiogroup" aria-label="记忆范围模式">
                  <label className={`session-segmented-option ${friendMemoryMode === 'empty' ? 'session-segmented-option--active' : ''}`}>
                    <input
                      aria-label="空范围"
                      type="radio"
                      name="friend-memory-mode"
                      checked={friendMemoryMode === 'empty'}
                      onChange={() => onFriendMemoryModeChange('empty')}
                    />
                    <span>空范围</span>
                  </label>
                  <label className={`session-segmented-option ${friendMemoryMode === 'custom' ? 'session-segmented-option--active' : ''}`}>
                    <input
                      aria-label="自定义范围"
                      type="radio"
                      name="friend-memory-mode"
                      checked={friendMemoryMode === 'custom'}
                      onChange={() => onFriendMemoryModeChange('custom')}
                    />
                    <span>自定义范围</span>
                  </label>
                </div>

                {friendMemoryMode === 'custom' && (
                  <label style={{ display: 'grid', gap: '0.35rem' }}>
                    <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>范围标识</span>
                    <textarea
                      aria-label="范围标识"
                      className="textarea"
                      value={friendMemoryScopesInput}
                      onChange={(event) => onFriendMemoryScopesInputChange(event.target.value)}
                      placeholder="例如：friend:friend-1, friend:shared"
                    />
                    <span className="form-help">多个范围可用逗号或换行分隔。</span>
                  </label>
                )}

                <div className="session-inline-summary">
                  当前生效：
                  {' '}
                  {memorySummary}
                </div>
              </div>

              <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                <Button
                  variant="primary"
                  onClick={onSavePermissions}
                  disabled={savingPermissions || friendPermissionLoading}
                >
                  {savingPermissions ? '保存中...' : '保存权限'}
                </Button>
              </div>
            </div>
          )}
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
