import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '../../components/Common/Button'
import { Card } from '../../components/Common/Card'
import { Drawer } from '../../components/Common/Drawer'
import { Input } from '../../components/Common/Input'
import { Loading } from '../../components/Common/Loading'
import { MainLayout } from '../../components/Layout/MainLayout'
import { useToast } from '../../contexts/ToastContext'
import { dialogObjectsService } from '../../services/dialog-objects'
import { friendService } from '../../services/friend'
import type {
  DialogObjectApplication,
  DialogObjectFriend,
  DialogObjectGroupEntry,
  DialogObjectPrivatePoolEntry,
  Friend,
} from '../../types'

type DialogDomain = 'friends' | 'privatePool' | 'groups'

const domainOptions: Array<{ key: DialogDomain; label: string }> = [
  { key: 'friends', label: '好友' },
  { key: 'privatePool', label: '私聊池' },
  { key: 'groups', label: '群聊' },
]

const panelStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '200px minmax(260px, 340px) minmax(320px, 1fr)',
  gap: '1rem',
  alignItems: 'start',
}

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

export const DialogObjectsPage: React.FC = () => {
  const { success, error: notifyError } = useToast()
  const [loading, setLoading] = useState(true)
  const [refreshKey, setRefreshKey] = useState(0)
  const [search, setSearch] = useState('')
  const [domain, setDomain] = useState<DialogDomain>('friends')

  const [friends, setFriends] = useState<DialogObjectFriend[]>([])
  const [privatePool, setPrivatePool] = useState<DialogObjectPrivatePoolEntry[]>([])
  const [groups, setGroups] = useState<DialogObjectGroupEntry[]>([])
  const [applications, setApplications] = useState<DialogObjectApplication[]>([])
  const [friendOptions, setFriendOptions] = useState<Friend[]>([])

  const [selectedIds, setSelectedIds] = useState<Record<DialogDomain, string | null>>({
    friends: null,
    privatePool: null,
    groups: null,
  })

  const [applicationQueueOpen, setApplicationQueueOpen] = useState(false)
  const [selectedApplicationId, setSelectedApplicationId] = useState<string | null>(null)

  const [createTarget, setCreateTarget] = useState<DialogObjectPrivatePoolEntry | null>(null)
  const [createName, setCreateName] = useState('')
  const [assignTarget, setAssignTarget] = useState<DialogObjectPrivatePoolEntry | null>(null)
  const [assignFriendId, setAssignFriendId] = useState('')
  const [actionLoading, setActionLoading] = useState(false)

  const refreshAll = useCallback(async () => {
    try {
      setLoading(true)
      const results = await Promise.allSettled([
        dialogObjectsService.listFriends(),
        dialogObjectsService.listPrivatePool(),
        dialogObjectsService.listGroups(),
        dialogObjectsService.listApplications(),
      ])
      const failures: string[] = []

      if (results[0].status === 'fulfilled') {
        setFriends(results[0].value.items)
      } else {
        setFriends([])
        failures.push('好友')
      }

      if (results[1].status === 'fulfilled') {
        setPrivatePool(results[1].value.items)
      } else {
        setPrivatePool([])
        failures.push('私聊池')
      }

      if (results[2].status === 'fulfilled') {
        setGroups(results[2].value.items)
      } else {
        setGroups([])
        failures.push('群聊')
      }

      if (results[3].status === 'fulfilled') {
        setApplications(results[3].value.items)
      } else {
        setApplications([])
        failures.push('申请队列')
      }

      if (failures.length > 0) {
        notifyError(`部分数据加载失败：${failures.join('、')}`)
      }
    } finally {
      setLoading(false)
    }
  }, [notifyError])

  useEffect(() => {
    refreshAll()
  }, [refreshAll, refreshKey])

  const itemsByDomain = useMemo(() => ({
    friends,
    privatePool,
    groups,
  }), [friends, privatePool, groups])

  const filteredItems = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    const currentItems = itemsByDomain[domain]
    if (!keyword) return currentItems

    return currentItems.filter((item) => {
      const haystacks = [
        'channel_id' in item ? item.channel_id : '',
        'display_name' in item ? item.display_name : '',
        'title' in item ? item.title : '',
        ...('identities' in item ? item.identities.map((identity) => identity.platform_display_name) : []),
        ...('participants' in item ? item.participants.map((participant) => participant.platform_user_id) : []),
      ].map((value) => value.toLowerCase())

      return haystacks.some((value) => value.includes(keyword))
    })
  }, [domain, itemsByDomain, search])

  useEffect(() => {
    const currentItems = itemsByDomain[domain]
    const selectedId = selectedIds[domain]

    if (currentItems.length === 0) {
      if (selectedId !== null) {
        setSelectedIds((prev) => ({ ...prev, [domain]: null }))
      }
      return
    }

    if (!selectedId || !currentItems.some((item) => item.id === selectedId)) {
      setSelectedIds((prev) => ({ ...prev, [domain]: currentItems[0].id }))
    }
  }, [domain, itemsByDomain, selectedIds])

  useEffect(() => {
    if (!selectedApplicationId && applications.length > 0) {
      setSelectedApplicationId(applications[0].id)
    }
    if (applications.length === 0) {
      setSelectedApplicationId(null)
    }
  }, [applications, selectedApplicationId])

  const selectedItem = filteredItems.find((item) => item.id === selectedIds[domain]) ?? filteredItems[0] ?? null
  const selectedApplication = applications.find((item) => item.id === selectedApplicationId) ?? applications[0] ?? null

  const groupedApplications = useMemo(() => ({
    pair: applications.filter((item) => item.intent === 'pair'),
    apply: applications.filter((item) => item.intent === 'apply'),
  }), [applications])

  const openAssignModal = async (entry: DialogObjectPrivatePoolEntry) => {
    setAssignTarget(entry)
    setAssignFriendId('')
    try {
      const result = await friendService.listFriends({ page: 1, page_size: 200 })
      setFriendOptions(result.items)
      if (result.items.length > 0) {
        setAssignFriendId(result.items[0].id)
      }
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : '加载好友列表失败'
      notifyError(message)
    }
  }

  const handleCreateFriend = async () => {
    if (!createTarget || !createName.trim()) return
    try {
      setActionLoading(true)
      await dialogObjectsService.createFriendFromPrivatePool(createTarget.id, {
        channel_id: createTarget.channel_id,
        display_name: createName.trim(),
      })
      success('已从私聊池新建好友')
      setCreateTarget(null)
      setCreateName('')
      setRefreshKey((value) => value + 1)
      setDomain('friends')
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : '新建好友失败'
      notifyError(message)
    } finally {
      setActionLoading(false)
    }
  }

  const handleAssignFriend = async () => {
    if (!assignTarget || !assignFriendId) return
    try {
      setActionLoading(true)
      await dialogObjectsService.assignPrivatePoolToFriend(assignTarget.id, {
        channel_id: assignTarget.channel_id,
        friend_id: assignFriendId,
      })
      success('已归属到已有好友')
      setAssignTarget(null)
      setAssignFriendId('')
      setRefreshKey((value) => value + 1)
      setDomain('friends')
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : '归属好友失败'
      notifyError(message)
    } finally {
      setActionLoading(false)
    }
  }

  const renderList = () => {
    if (filteredItems.length === 0) {
      return (
        <Card>
          <div style={{ color: 'var(--text-secondary)' }}>
            当前对象域暂无数据
          </div>
        </Card>
      )
    }

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {filteredItems.map((item) => {
          const active = item.id === selectedItem?.id
          const title = 'display_name' in item ? item.display_name : item.title
          const subtitle = 'display_name' in item
            ? `${item.identities.length} 个渠道身份`
            : `${item.channel_id} · ${item.type}`

          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setSelectedIds((prev) => ({ ...prev, [domain]: item.id }))}
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
    )
  }

  const renderDetail = () => {
    if (!selectedItem) {
      return (
        <Card title="详情">
          <div style={{ color: 'var(--text-secondary)' }}>请选择一个对象</div>
        </Card>
      )
    }

    if (domain === 'friends') {
      const friend = selectedItem as DialogObjectFriend
      return (
        <Card title="好友详情">
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            <div><strong>{friend.display_name}</strong></div>
            <div>权限等级：{friend.permission}</div>
            <div>状态：{friend.status === 'active' ? '活跃' : '无渠道'}</div>
            <div>权限模板：{friend.permission_template_id ?? '未设置'}</div>
            <div>
              渠道身份：
              <ul style={{ margin: '0.5rem 0 0 1.25rem' }}>
                {friend.identities.map((identity) => (
                  <li key={`${identity.channel_id}:${identity.platform_user_id}`}>
                    {identity.platform_display_name} · {identity.channel_id}
                  </li>
                ))}
              </ul>
            </div>
            <div style={{ color: 'var(--text-secondary)' }}>
              统一私聊权限、私聊场景和记忆工作台将在这里继续扩展。
            </div>
          </div>
        </Card>
      )
    }

    if (domain === 'privatePool') {
      const entry = selectedItem as DialogObjectPrivatePoolEntry
      return (
        <Card title="私聊池详情">
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            <div><strong>{entry.title}</strong></div>
            <div>来源渠道：{entry.channel_id}</div>
            <div>Session ID：{entry.id}</div>
            <div>参与者：{entry.participants.map((participant) => participant.platform_user_id).join(', ')}</div>
            <div>关联申请：{entry.matching_pending_application_ids.length}</div>
            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
              <Button variant="secondary" onClick={() => openAssignModal(entry)}>
                归到已有好友
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  setCreateTarget(entry)
                  setCreateName(entry.title)
                }}
              >
                从私聊新建好友
              </Button>
            </div>
          </div>
        </Card>
      )
    }

    const group = selectedItem as DialogObjectGroupEntry
    return (
      <Card title="群聊详情">
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          <div><strong>{group.title}</strong></div>
          <div>来源渠道：{group.channel_id}</div>
          <div>群成员数量：{group.participant_count}</div>
          <div>master_in_group：{group.master_in_group ? '是' : '否'}</div>
          <div>会话配置：{group.has_session_config ? '已配置' : '未配置'}</div>
          <div style={{ color: 'var(--text-secondary)' }}>
            群权限、群场景和记忆工作台将在这里继续展开；当前列表已和运行时 `master_in_group` 规则保持一致。
          </div>
        </div>
      </Card>
    )
  }

  if (loading) {
    return (
      <MainLayout>
        <Loading />
      </MainLayout>
    )
  }

  return (
    <MainLayout>
      <div style={{ display: 'grid', gap: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
          <div>
            <h1 style={{ fontSize: '1.6rem', fontWeight: 700, marginBottom: '0.25rem' }}>对话对象管理</h1>
            <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
              用统一模型查看好友、未归属私聊和可处理群聊。
            </p>
          </div>
          <Button variant="secondary" onClick={() => setApplicationQueueOpen(true)}>
            申请队列 {applications.length}
          </Button>
        </div>

        <Card>
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ minWidth: '280px' }}>
              <Input
                label="搜索"
                placeholder="按名字、渠道或参与者搜索"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '0.5rem' }}>
              当前对象域：{domainOptions.find((option) => option.key === domain)?.label}
            </div>
          </div>
        </Card>

        <div style={panelStyle}>
          <Card title="对象域">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {domainOptions.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => setDomain(option.key)}
                  style={sidebarButtonStyle(option.key === domain)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </Card>

          <Card title="对象列表">
            {renderList()}
          </Card>

          {renderDetail()}
        </div>
      </div>

      <Drawer open={applicationQueueOpen} onClose={() => setApplicationQueueOpen(false)} width={520}>
        <div style={{ display: 'grid', gap: '1rem' }}>
          <div>
            <h2 style={{ margin: 0 }}>申请队列</h2>
            <p style={{ color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
              这里先集中查看 `/认主` 和 `/apply` 事件，动作流将在后续和新模型完全对齐。
            </p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: '1rem' }}>
            <div style={{ display: 'grid', gap: '0.75rem' }}>
              {([
                ['认主申请', groupedApplications.pair],
                ['普通申请', groupedApplications.apply],
              ] as const).map(([title, items]) => (
                <Card key={title} title={title}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {items.length === 0 ? (
                      <div style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>暂无</div>
                    ) : (
                      items.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => setSelectedApplicationId(item.id)}
                          style={{
                            width: '100%',
                            textAlign: 'left',
                            border: item.id === selectedApplication?.id ? '1px solid var(--primary)' : '1px solid var(--border)',
                            background: item.id === selectedApplication?.id ? 'rgba(59, 130, 246, 0.06)' : 'var(--bg-primary)',
                            borderRadius: '10px',
                            padding: '0.625rem 0.75rem',
                            cursor: 'pointer',
                          }}
                        >
                          <div style={{ fontWeight: 600 }}>{item.platform_display_name}</div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{item.channel_id}</div>
                        </button>
                      ))
                    )}
                  </div>
                </Card>
              ))}
            </div>

            <Card title="申请详情">
              {selectedApplication ? (
                <div style={{ display: 'grid', gap: '0.75rem' }}>
                  <div><strong>{selectedApplication.platform_display_name}</strong></div>
                  <div>类型：{selectedApplication.intent === 'pair' ? '认主申请' : '普通申请'}</div>
                  <div>来源渠道：{selectedApplication.channel_id}</div>
                  <div>来源私聊：{selectedApplication.source_session_id}</div>
                  <div>内容预览：{selectedApplication.content_preview}</div>
                  <div style={{ color: 'var(--text-secondary)' }}>
                    审批动作将在后续接入新的“归到已有好友 / 新建好友 / 并入现有 master”流程。
                  </div>
                </div>
              ) : (
                <div style={{ color: 'var(--text-secondary)' }}>暂无申请</div>
              )}
            </Card>
          </div>
        </div>
      </Drawer>

      {createTarget && (
        <Drawer open onClose={() => setCreateTarget(null)} width={420}>
          <div style={{ display: 'grid', gap: '1rem' }}>
            <h2 style={{ margin: 0 }}>从私聊新建好友</h2>
            <Input
              label="好友名称"
              aria-label="好友名称"
              value={createName}
              onChange={(event) => setCreateName(event.target.value)}
            />
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <Button variant="primary" onClick={handleCreateFriend} disabled={actionLoading || !createName.trim()}>
                确认新建
              </Button>
              <Button variant="secondary" onClick={() => setCreateTarget(null)} disabled={actionLoading}>
                取消
              </Button>
            </div>
          </div>
        </Drawer>
      )}

      {assignTarget && (
        <Drawer open onClose={() => setAssignTarget(null)} width={420}>
          <div style={{ display: 'grid', gap: '1rem' }}>
            <h2 style={{ margin: 0 }}>归到已有好友</h2>
            <label style={{ display: 'grid', gap: '0.5rem' }}>
              <span>选择好友</span>
              <select
                aria-label="选择好友"
                value={assignFriendId}
                onChange={(event) => setAssignFriendId(event.target.value)}
                className="select"
              >
                {friendOptions.map((friend) => (
                  <option key={friend.id} value={friend.id}>
                    {friend.display_name}
                  </option>
                ))}
              </select>
            </label>
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <Button variant="primary" onClick={handleAssignFriend} disabled={actionLoading || !assignFriendId}>
                确认归属
              </Button>
              <Button variant="secondary" onClick={() => setAssignTarget(null)} disabled={actionLoading}>
                取消
              </Button>
            </div>
          </div>
        </Drawer>
      )}
    </MainLayout>
  )
}

export default DialogObjectsPage
