import React, { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { Loading } from '../../components/Common/Loading'
import { useToast } from '../../contexts/ToastContext'
import { friendService } from '../../services/friend'
import { permissionTemplateService } from '../../services/permission-template'
import type { Friend, FriendPermission, ChannelIdentity, PermissionTemplate } from '../../types'

export const FriendDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const toast = useToast()

  const [friend, setFriend] = useState<Friend | null>(null)
  const [loading, setLoading] = useState(true)

  // 编辑状态
  const [editName, setEditName] = useState('')
  const [editPerm, setEditPerm] = useState<FriendPermission>('normal')
  const [editTemplateId, setEditTemplateId] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const [templates, setTemplates] = useState<PermissionTemplate[]>([])

  // 绑定身份表单
  const [showBind, setShowBind] = useState(false)
  const [bindChannelId, setBindChannelId] = useState('')
  const [bindPlatformUserId, setBindPlatformUserId] = useState('')
  const [bindDisplayName, setBindDisplayName] = useState('')
  const [binding, setBinding] = useState(false)

  // 解绑确认
  const [confirmUnlink, setConfirmUnlink] = useState<string | null>(null)
  const [unlinking, setUnlinking] = useState(false)

  const loadFriend = useCallback(async () => {
    if (!id) return
    try {
      const result = await friendService.getFriend(id)
      setFriend(result.friend)
      setEditName(result.friend.display_name)
      setEditPerm(result.friend.permission)
      setEditTemplateId(result.friend.permission_template_id ?? '')
    } catch (err) {
      toast.error('加载熟人信息失败')
      navigate('/friends')
    } finally {
      setLoading(false)
    }
  }, [id, toast, navigate])

  useEffect(() => {
    loadFriend()
  }, [loadFriend])

  useEffect(() => {
    permissionTemplateService.list().then(result => {
      setTemplates(result.items)
    }).catch(() => {})
  }, [])

  const handleSave = async () => {
    if (!friend || !editName.trim()) return
    setSaving(true)
    try {
      const result = await friendService.updateFriend(friend.id, {
        display_name: editName.trim(),
        permission: editPerm,
        ...(editPerm === 'normal' && editTemplateId ? { permission_template_id: editTemplateId } : {}),
      })
      setFriend(result.friend)
      toast.success('保存成功')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleBind = async () => {
    if (!friend || !bindChannelId.trim() || !bindPlatformUserId.trim()) return
    setBinding(true)
    try {
      const identity: ChannelIdentity = {
        channel_id: bindChannelId.trim(),
        platform_user_id: bindPlatformUserId.trim(),
        platform_display_name: bindDisplayName.trim() || bindPlatformUserId.trim(),
      }
      const result = await friendService.linkIdentity(friend.id, identity)
      setFriend(result.friend)
      setShowBind(false)
      setBindChannelId('')
      setBindPlatformUserId('')
      setBindDisplayName('')
      toast.success('身份绑定成功')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '绑定失败')
    } finally {
      setBinding(false)
    }
  }

  const handleUnlink = async (ci: ChannelIdentity) => {
    if (!friend) return
    setUnlinking(true)
    try {
      const result = await friendService.unlinkIdentity(friend.id, ci.channel_id, ci.platform_user_id)
      setFriend(result.friend)
      setConfirmUnlink(null)
      toast.success('身份已解绑')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '解绑失败')
    } finally {
      setUnlinking(false)
    }
  }

  if (loading) {
    return <MainLayout><Loading /></MainLayout>
  }

  if (!friend) {
    return <MainLayout><div>熟人不存在</div></MainLayout>
  }

  const hasChanges = editName !== friend.display_name || editPerm !== friend.permission || editTemplateId !== (friend.permission_template_id ?? '')

  return (
    <MainLayout>
      <div style={{ maxWidth: '700px', margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700 }}>熟人详情</h1>
          <Button variant="secondary" onClick={() => navigate('/friends')}>返回列表</Button>
        </div>

        {/* 基本信息 */}
        <Card title="基本信息">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, marginBottom: '0.25rem' }}>
                ID
              </label>
              <span style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>{friend.id}</span>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, marginBottom: '0.25rem' }}>
                显示名称
              </label>
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                style={{
                  width: '100%',
                  padding: '0.5rem 0.75rem',
                  borderRadius: '6px',
                  border: '1px solid var(--border)',
                  background: 'var(--bg-secondary)',
                  color: 'var(--text-primary)',
                  fontSize: '0.875rem',
                  boxSizing: 'border-box',
                }}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, marginBottom: '0.25rem' }}>
                权限
              </label>
              <select
                value={editPerm}
                onChange={(e) => setEditPerm(e.target.value as FriendPermission)}
                disabled={friend.permission === 'master'}
                style={{
                  width: '100%',
                  padding: '0.5rem 0.75rem',
                  borderRadius: '6px',
                  border: '1px solid var(--border)',
                  background: 'var(--bg-secondary)',
                  color: 'var(--text-primary)',
                  fontSize: '0.875rem',
                  boxSizing: 'border-box',
                }}
              >
                <option value="normal">Normal</option>
                <option value="master">Master</option>
              </select>
            </div>
            {editPerm === 'normal' && (
              <div>
                <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, marginBottom: '0.25rem' }}>
                  权限模板
                </label>
                <select
                  value={editTemplateId}
                  onChange={(e) => setEditTemplateId(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '0.5rem 0.75rem',
                    borderRadius: '6px',
                    border: '1px solid var(--border)',
                    background: 'var(--bg-secondary)',
                    color: 'var(--text-primary)',
                    fontSize: '0.875rem',
                    boxSizing: 'border-box',
                  }}
                >
                  <option value="">未选择</option>
                  {templates.filter(t => t.id !== 'master_private').map(t => (
                    <option key={t.id} value={t.id}>{t.name}{t.is_system ? ' (系统)' : ''}</option>
                  ))}
                </select>
              </div>
            )}
            <div style={{ display: 'flex', gap: '1rem', fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
              <span>创建于 {new Date(friend.created_at).toLocaleString()}</span>
              <span>更新于 {new Date(friend.updated_at).toLocaleString()}</span>
            </div>
            {hasChanges && (
              <div>
                <Button variant="primary" onClick={handleSave} disabled={saving || !editName.trim()}>
                  {saving ? '保存中...' : '保存修改'}
                </Button>
              </div>
            )}
          </div>
        </Card>

        {/* Channel 身份 */}
        <div style={{ marginTop: '1.5rem' }}>
          <Card title="Channel 身份">
            {friend.channel_identities.length === 0 ? (
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>暂无绑定的 Channel 身份</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {friend.channel_identities.map((ci) => {
                  const key = `${ci.channel_id}:${ci.platform_user_id}`
                  return (
                    <div
                      key={key}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '0.75rem',
                        background: 'var(--bg-secondary)',
                        borderRadius: '8px',
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 500, fontSize: '0.875rem', marginBottom: '0.25rem' }}>
                          {ci.platform_display_name}
                        </div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                          Channel: {ci.channel_id} / {ci.platform_user_id}
                        </div>
                      </div>
                      {confirmUnlink === key ? (
                        <div style={{ display: 'flex', gap: '0.25rem' }}>
                          <Button variant="danger" onClick={() => handleUnlink(ci)} disabled={unlinking}
                            style={{ fontSize: '0.8125rem', padding: '0.375rem 0.75rem' }}>
                            确认
                          </Button>
                          <Button variant="secondary" onClick={() => setConfirmUnlink(null)}
                            style={{ fontSize: '0.8125rem', padding: '0.375rem 0.75rem' }}>
                            取消
                          </Button>
                        </div>
                      ) : (
                        <Button variant="danger" onClick={() => setConfirmUnlink(key)}
                          style={{ fontSize: '0.8125rem', padding: '0.375rem 0.75rem' }}>
                          解绑
                        </Button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            <div style={{ marginTop: '1rem' }}>
              {showBind ? (
                <div style={{ padding: '1rem', background: 'var(--bg-secondary)', borderRadius: '8px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    <input
                      type="text"
                      placeholder="Channel ID"
                      value={bindChannelId}
                      onChange={(e) => setBindChannelId(e.target.value)}
                      style={{
                        padding: '0.5rem 0.75rem',
                        borderRadius: '6px',
                        border: '1px solid var(--border)',
                        background: 'var(--bg-primary)',
                        color: 'var(--text-primary)',
                        fontSize: '0.875rem',
                      }}
                    />
                    <input
                      type="text"
                      placeholder="平台用户 ID"
                      value={bindPlatformUserId}
                      onChange={(e) => setBindPlatformUserId(e.target.value)}
                      style={{
                        padding: '0.5rem 0.75rem',
                        borderRadius: '6px',
                        border: '1px solid var(--border)',
                        background: 'var(--bg-primary)',
                        color: 'var(--text-primary)',
                        fontSize: '0.875rem',
                      }}
                    />
                    <input
                      type="text"
                      placeholder="平台显示名称（可选）"
                      value={bindDisplayName}
                      onChange={(e) => setBindDisplayName(e.target.value)}
                      style={{
                        padding: '0.5rem 0.75rem',
                        borderRadius: '6px',
                        border: '1px solid var(--border)',
                        background: 'var(--bg-primary)',
                        color: 'var(--text-primary)',
                        fontSize: '0.875rem',
                      }}
                    />
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <Button variant="primary" onClick={handleBind}
                        disabled={binding || !bindChannelId.trim() || !bindPlatformUserId.trim()}>
                        {binding ? '绑定中...' : '绑定'}
                      </Button>
                      <Button variant="secondary" onClick={() => setShowBind(false)}>取消</Button>
                    </div>
                  </div>
                </div>
              ) : (
                <Button variant="secondary" onClick={() => setShowBind(true)}>绑定新身份</Button>
              )}
            </div>
          </Card>
        </div>
      </div>
    </MainLayout>
  )
}
