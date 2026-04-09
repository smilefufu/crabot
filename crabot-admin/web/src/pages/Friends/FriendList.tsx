import React, { useState, useEffect, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { Loading } from '../../components/Common/Loading'
import { useToast } from '../../contexts/ToastContext'
import { friendService } from '../../services/friend'
import { permissionTemplateService } from '../../services/permission-template'
import type { Friend, FriendPermission, PermissionTemplate } from '../../types'

export const FriendList: React.FC = () => {
  const toast = useToast()
  const navigate = useNavigate()
  const [friends, setFriends] = useState<Friend[]>([])
  const [pendingCount, setPendingCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [permFilter, setPermFilter] = useState<FriendPermission | ''>('')

  // 创建模态框
  const [showCreate, setShowCreate] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createPerm, setCreatePerm] = useState<FriendPermission>('normal')
  const [creating, setCreating] = useState(false)
  const [templates, setTemplates] = useState<PermissionTemplate[]>([])
  const [createTemplateId, setCreateTemplateId] = useState<string>('standard')

  // 删除确认
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  const loadFriends = useCallback(async () => {
    try {
      const result = await friendService.listFriends({
        permission: permFilter || undefined,
        search: search || undefined,
      })
      setFriends(result.items)
    } catch (err) {
      toast.error('加载熟人列表失败')
    } finally {
      setLoading(false)
    }
  }, [toast, search, permFilter])

  const loadPendingCount = useCallback(async () => {
    try {
      const result = await friendService.listPendingMessages({ page_size: 1 })
      setPendingCount(result.pagination.total_items)
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    loadFriends()
    loadPendingCount()
  }, [loadFriends, loadPendingCount])

  useEffect(() => {
    permissionTemplateService.list().then(result => {
      setTemplates(result.items)
    }).catch(() => {})
  }, [])

  const handleCreate = async () => {
    if (!createName.trim()) return
    setCreating(true)
    try {
      await friendService.createFriend({
        display_name: createName.trim(),
        permission: createPerm,
        ...(createPerm === 'normal' ? { permission_template_id: createTemplateId } : {}),
      })
      toast.success('熟人创建成功')
      setShowCreate(false)
      setCreateName('')
      setCreatePerm('normal')
      setCreateTemplateId('standard')
      await loadFriends()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建失败')
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async (id: string) => {
    setDeleting(true)
    try {
      await friendService.deleteFriend(id)
      toast.success('已删除')
      setConfirmDelete(null)
      await loadFriends()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    } finally {
      setDeleting(false)
    }
  }

  if (loading) {
    return <MainLayout><Loading /></MainLayout>
  }

  return (
    <MainLayout>
      <div style={{ maxWidth: '900px', margin: '0 auto' }}>
        {/* 头部 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700 }}>熟人管理</h1>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <Link to="/friends/pending" style={{ textDecoration: 'none' }}>
              <Button variant="secondary">
                待审批 {pendingCount > 0 && (
                  <span style={{
                    marginLeft: '0.5rem',
                    background: '#ef4444',
                    color: '#fff',
                    borderRadius: '9999px',
                    padding: '0.125rem 0.5rem',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                  }}>
                    {pendingCount}
                  </span>
                )}
              </Button>
            </Link>
            <Button variant="primary" onClick={() => setShowCreate(true)}>创建熟人</Button>
          </div>
        </div>

        {/* 筛选栏 */}
        <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.5rem' }}>
          <input
            type="text"
            placeholder="搜索熟人..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              flex: 1,
              padding: '0.5rem 0.75rem',
              borderRadius: '6px',
              border: '1px solid var(--border)',
              background: 'var(--bg-secondary)',
              color: 'var(--text-primary)',
              fontSize: '0.875rem',
            }}
          />
          <select
            value={permFilter}
            onChange={(e) => setPermFilter(e.target.value as FriendPermission | '')}
            style={{
              padding: '0.5rem 0.75rem',
              borderRadius: '6px',
              border: '1px solid var(--border)',
              background: 'var(--bg-secondary)',
              color: 'var(--text-primary)',
              fontSize: '0.875rem',
            }}
          >
            <option value="">全部权限</option>
            <option value="master">Master</option>
            <option value="normal">Normal</option>
          </select>
        </div>

        {/* 列表 */}
        {friends.length === 0 ? (
          <Card>
            <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>
              暂无熟人
            </div>
          </Card>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {friends.map((f) => (
              <div key={f.id} className="card" style={{ cursor: 'pointer' }} onClick={() => navigate(`/friends/${f.id}`)}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.25rem' }}>
                      <span style={{ fontWeight: 600 }}>{f.display_name}</span>
                      <span style={{
                        fontSize: '0.75rem',
                        padding: '0.125rem 0.5rem',
                        borderRadius: '9999px',
                        background: f.permission === 'master'
                          ? 'rgba(234, 179, 8, 0.15)'
                          : 'rgba(59, 130, 246, 0.1)',
                        color: f.permission === 'master' ? '#ca8a04' : 'var(--primary)',
                        fontWeight: 500,
                      }}>
                        {f.permission}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: '1rem', fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                      <span>{f.channel_identities.length} 个身份</span>
                      <span>创建于 {new Date(f.created_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem' }} onClick={(e) => e.stopPropagation()}>
                    {f.permission !== 'master' && (
                      confirmDelete === f.id ? (
                        <div style={{ display: 'flex', gap: '0.25rem' }}>
                          <Button variant="danger" onClick={() => handleDelete(f.id)} disabled={deleting}
                            style={{ fontSize: '0.8125rem', padding: '0.375rem 0.75rem' }}>
                            确认
                          </Button>
                          <Button variant="secondary" onClick={() => setConfirmDelete(null)}
                            style={{ fontSize: '0.8125rem', padding: '0.375rem 0.75rem' }}>
                            取消
                          </Button>
                        </div>
                      ) : (
                        <Button variant="danger" onClick={() => setConfirmDelete(f.id)}
                          style={{ fontSize: '0.8125rem', padding: '0.375rem 0.75rem' }}>
                          删除
                        </Button>
                      )
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 创建模态框 */}
      {showCreate && (
        <div
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0, 0, 0, 0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={() => setShowCreate(false)}
        >
          <div
            style={{
              background: 'var(--bg-primary)',
              borderRadius: '12px',
              padding: '2rem',
              width: '400px',
              maxWidth: '90vw',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginBottom: '1.5rem', fontSize: '1.125rem' }}>创建熟人</h3>

            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, marginBottom: '0.25rem' }}>
                显示名称
              </label>
              <input
                type="text"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="输入名称"
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

            <div style={{ marginBottom: '1.5rem' }}>
              <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, marginBottom: '0.25rem' }}>
                权限
              </label>
              <select
                value={createPerm}
                onChange={(e) => setCreatePerm(e.target.value as FriendPermission)}
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

            {createPerm === 'normal' && (
              <div style={{ marginBottom: '1.5rem' }}>
                <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, marginBottom: '0.25rem' }}>
                  权限模板
                </label>
                <select
                  value={createTemplateId}
                  onChange={(e) => setCreateTemplateId(e.target.value)}
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
                  {templates.filter(t => t.id !== 'master_private').map(t => (
                    <option key={t.id} value={t.id}>{t.name}{t.is_system ? ' (系统)' : ''}</option>
                  ))}
                </select>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
              <Button variant="secondary" onClick={() => setShowCreate(false)}>取消</Button>
              <Button
                variant="primary"
                onClick={handleCreate}
                disabled={!createName.trim() || creating}
              >
                {creating ? '创建中...' : '创建'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </MainLayout>
  )
}
