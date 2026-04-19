import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../../components/Common/Button'
import { Card } from '../../components/Common/Card'
import { Drawer } from '../../components/Common/Drawer'
import { Input } from '../../components/Common/Input'
import { Loading } from '../../components/Common/Loading'
import { MainLayout } from '../../components/Layout/MainLayout'
import { useToast } from '../../contexts/ToastContext'
import { dialogObjectsService } from '../../services/dialog-objects'
import { friendService } from '../../services/friend'
import { permissionTemplateService } from '../../services/permission-template'
import { sessionService } from '../../services/session'
import { ApplicationQueueModal } from './components/ApplicationQueueModal'
import { DialogDomain, DomainNav } from './components/DomainNav'
import { FriendWorkbench } from './components/FriendWorkbench'
import { GroupWorkbench } from './components/GroupWorkbench'
import { ObjectList } from './components/ObjectList'
import { PrivatePoolWorkbench } from './components/PrivatePoolWorkbench'
import type {
  DialogObjectApplication,
  ChannelIdentity,
  DialogObjectFriend,
  DialogObjectGroupEntry,
  DialogObjectPrivatePoolEntry,
  Friend,
  FriendPermission,
  PermissionTemplate,
  StoragePermission,
  ToolAccessConfig,
  ToolCategory,
} from '../../types'
import { TOOL_CATEGORIES, TOOL_CATEGORY_LABELS } from '../../types'

type QueueTarget = { id: string; channel_id: string; title: string }
type QueueTargetKind = 'privatePool' | 'application'

const panelStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '200px minmax(260px, 340px) minmax(320px, 1fr)',
  gap: '1rem',
  alignItems: 'start',
}

type TriState = 'inherit' | 'on' | 'off'

const triStateLabel = (state: TriState): string => {
  switch (state) {
    case 'on':
      return '开启'
    case 'off':
      return '关闭'
    default:
      return '继承'
  }
}

const GroupTriStateToggle: React.FC<{
  label: string
  category: ToolCategory
  value: TriState
  onChange: (cat: string, val: TriState) => void
}> = ({ label, category, value, onChange }) => {
  const cycle = () => {
    const next: TriState = value === 'inherit' ? 'on' : value === 'on' ? 'off' : 'inherit'
    onChange(category, next)
  }

  return (
    <button
      type="button"
      className={`session-tri-toggle session-tri-toggle--${value}`}
      onClick={cycle}
      title={`${label}: ${triStateLabel(value)} (点击切换)`}
    >
      <span className="session-tri-toggle-indicator" />
      <span className="session-tri-toggle-label">{label}: {triStateLabel(value)}</span>
    </button>
  )
}

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
  const [permissionTemplates, setPermissionTemplates] = useState<PermissionTemplate[]>([])

  const [selectedIds, setSelectedIds] = useState<Record<DialogDomain, string | null>>({
    friends: null,
    privatePool: null,
    groups: null,
  })

  const [applicationQueueOpen, setApplicationQueueOpen] = useState(false)
  const [selectedApplicationId, setSelectedApplicationId] = useState<string | null>(null)

  const [createTarget, setCreateTarget] = useState<QueueTarget | null>(null)
  const [createTargetKind, setCreateTargetKind] = useState<QueueTargetKind>('privatePool')
  const [createName, setCreateName] = useState('')
  const [assignTarget, setAssignTarget] = useState<QueueTarget | null>(null)
  const [assignTargetKind, setAssignTargetKind] = useState<QueueTargetKind>('privatePool')
  const [assignFriendId, setAssignFriendId] = useState('')
  const [actionLoading, setActionLoading] = useState(false)

  const [editName, setEditName] = useState('')
  const [editPerm, setEditPerm] = useState<FriendPermission>('normal')
  const [editTemplateId, setEditTemplateId] = useState('')
  const [savingFriend, setSavingFriend] = useState(false)
  const [showBindDrawer, setShowBindDrawer] = useState(false)
  const [bindChannelId, setBindChannelId] = useState('')
  const [bindPlatformUserId, setBindPlatformUserId] = useState('')
  const [bindDisplayName, setBindDisplayName] = useState('')
  const [bindingIdentity, setBindingIdentity] = useState(false)
  const [confirmUnlinkKey, setConfirmUnlinkKey] = useState<string | null>(null)
  const [unlinkingIdentity, setUnlinkingIdentity] = useState(false)
  const [editingGroup, setEditingGroup] = useState<DialogObjectGroupEntry | null>(null)
  const [groupConfigLoading, setGroupConfigLoading] = useState(false)
  const [groupSaving, setGroupSaving] = useState(false)
  const [groupHasExistingConfig, setGroupHasExistingConfig] = useState(false)
  const [groupToolOverrides, setGroupToolOverrides] = useState<Record<string, boolean>>({})
  const [groupStorageEnabled, setGroupStorageEnabled] = useState(false)
  const [groupStoragePath, setGroupStoragePath] = useState('')
  const [groupStorageAccess, setGroupStorageAccess] = useState<'read' | 'readwrite'>('read')
  const [groupMemoryScopes, setGroupMemoryScopes] = useState('')
  const initialLoadDone = useRef(false)

  const loadDialogObjects = useCallback(async (showLoading = false) => {
    try {
      if (showLoading) {
        setLoading(true)
      }
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
      if (showLoading) {
        setLoading(false)
      }
    }
  }, [notifyError])

  useEffect(() => {
    if (!initialLoadDone.current) {
      initialLoadDone.current = true
      void loadDialogObjects(true)
      return
    }
    void loadDialogObjects(false)
  }, [loadDialogObjects, refreshKey])

  useEffect(() => {
    permissionTemplateService.list({ page_size: 100 })
      .then((result) => {
        setPermissionTemplates(result.items)
      })
      .catch(() => {})
  }, [])

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

  const masterFriends = useMemo(
    () => friends.filter((friend) => friend.permission === 'master'),
    [friends]
  )

  useEffect(() => {
    if (domain !== 'friends' || !selectedItem) return
    const friend = selectedItem as DialogObjectFriend
    setEditName(friend.display_name)
    setEditPerm(friend.permission)
    setEditTemplateId(friend.permission_template_id ?? '')
    setShowBindDrawer(false)
    setBindChannelId('')
    setBindPlatformUserId('')
    setBindDisplayName('')
    setConfirmUnlinkKey(null)
  }, [domain, selectedItem])

  const openAssignModal = async (target: QueueTarget, kind: QueueTargetKind) => {
    setAssignTarget(target)
    setAssignTargetKind(kind)
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

  const openCreateModal = (target: QueueTarget, kind: QueueTargetKind, defaultName?: string) => {
    setCreateTarget(target)
    setCreateTargetKind(kind)
    setCreateName(defaultName ?? target.title)
  }

  const handleCreateFriend = async () => {
    if (!createTarget || !createName.trim()) return
    try {
      setActionLoading(true)
      if (createTargetKind === 'application') {
        await dialogObjectsService.createApplicationFriend(createTarget.id, {
          display_name: createName.trim(),
        })
        success('已新建好友')
      } else {
        await dialogObjectsService.createFriendFromPrivatePool(createTarget.id, {
          channel_id: createTarget.channel_id,
          display_name: createName.trim(),
        })
        success('已从私聊池新建好友')
      }
      setCreateTarget(null)
      setCreateName('')
      setRefreshKey((value) => value + 1)
      if (createTargetKind === 'privatePool') {
        setDomain('friends')
      }
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
      if (assignTargetKind === 'application') {
        await dialogObjectsService.assignApplicationFriend(assignTarget.id, {
          friend_id: assignFriendId,
        })
        success('已归属到已有好友')
      } else {
        await dialogObjectsService.assignPrivatePoolToFriend(assignTarget.id, {
          channel_id: assignTarget.channel_id,
          friend_id: assignFriendId,
        })
        success('已归属到已有好友')
      }
      setAssignTarget(null)
      setAssignFriendId('')
      setRefreshKey((value) => value + 1)
      if (assignTargetKind === 'privatePool') {
        setDomain('friends')
      }
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : '归属好友失败'
      notifyError(message)
    } finally {
      setActionLoading(false)
    }
  }

  const handleLinkApplicationMaster = async (application: DialogObjectApplication) => {
    try {
      setActionLoading(true)
      const result = await dialogObjectsService.linkApplicationMaster(application.id)
      success(result.created ? '已新建 Master' : '已并入现有 Master')
      setRefreshKey((value) => value + 1)
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : '处理认主申请失败'
      notifyError(message)
    } finally {
      setActionLoading(false)
    }
  }

  const handleRejectApplication = async (application: DialogObjectApplication) => {
    try {
      setActionLoading(true)
      await dialogObjectsService.rejectApplication(application.id)
      success('已拒绝申请')
      setRefreshKey((value) => value + 1)
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : '拒绝申请失败'
      notifyError(message)
    } finally {
      setActionLoading(false)
    }
  }

  const triggerRefresh = () => {
    setRefreshKey((value) => value + 1)
  }

  const handleSaveFriend = async () => {
    if (domain !== 'friends' || !selectedItem || !editName.trim()) return
    const friend = selectedItem as DialogObjectFriend
    try {
      setSavingFriend(true)
      await friendService.updateFriend(friend.id, {
        display_name: editName.trim(),
        permission: editPerm,
        ...(editPerm === 'normal' ? { permission_template_id: editTemplateId } : {}),
      })
      success('保存成功')
      triggerRefresh()
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : '保存失败'
      notifyError(message)
    } finally {
      setSavingFriend(false)
    }
  }

  const handleBindIdentity = async () => {
    if (domain !== 'friends' || !selectedItem || !bindChannelId.trim() || !bindPlatformUserId.trim()) return
    const friend = selectedItem as DialogObjectFriend
    try {
      setBindingIdentity(true)
      const identity: ChannelIdentity = {
        channel_id: bindChannelId.trim(),
        platform_user_id: bindPlatformUserId.trim(),
        platform_display_name: bindDisplayName.trim() || bindPlatformUserId.trim(),
      }
      await friendService.linkIdentity(friend.id, identity)
      success('身份绑定成功')
      setShowBindDrawer(false)
      setBindChannelId('')
      setBindPlatformUserId('')
      setBindDisplayName('')
      triggerRefresh()
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : '绑定失败'
      notifyError(message)
    } finally {
      setBindingIdentity(false)
    }
  }

  const handleUnlinkIdentity = async (identity: ChannelIdentity) => {
    if (domain !== 'friends' || !selectedItem) return
    const friend = selectedItem as DialogObjectFriend
    try {
      setUnlinkingIdentity(true)
      await friendService.unlinkIdentity(friend.id, identity.channel_id, identity.platform_user_id)
      success('身份已解绑')
      setConfirmUnlinkKey(null)
      triggerRefresh()
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : '解绑失败'
      notifyError(message)
    } finally {
      setUnlinkingIdentity(false)
    }
  }

  const resetGroupConfigForm = useCallback(() => {
    setGroupToolOverrides({})
    setGroupStorageEnabled(false)
    setGroupStoragePath('')
    setGroupStorageAccess('read')
    setGroupMemoryScopes('')
    setGroupHasExistingConfig(false)
  }, [])

  const openGroupPermissionEditor = useCallback(async (group: DialogObjectGroupEntry) => {
    setEditingGroup(group)
    resetGroupConfigForm()
    setGroupConfigLoading(true)

    try {
      const result = await sessionService.getConfig(group.id)
      const config = result.config
      setGroupHasExistingConfig(config != null)
      if (config) {
        setGroupToolOverrides(config.tool_access ? { ...config.tool_access } : {})
        setGroupStorageEnabled(config.storage != null)
        setGroupStoragePath(config.storage?.workspace_path ?? '')
        setGroupStorageAccess(config.storage?.access ?? 'read')
        setGroupMemoryScopes(config.memory_scopes?.join(', ') ?? '')
      }
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : '加载群聊权限失败'
      notifyError(message)
    } finally {
      setGroupConfigLoading(false)
    }
  }, [notifyError, resetGroupConfigForm])

  const closeGroupPermissionEditor = useCallback(() => {
    setEditingGroup(null)
  }, [])

  const getGroupTriState = (cat: string): TriState => {
    if (!(cat in groupToolOverrides)) return 'inherit'
    return groupToolOverrides[cat] ? 'on' : 'off'
  }

  const setGroupTriState = (cat: string, value: TriState) => {
    setGroupToolOverrides((prev) => {
      const { [cat]: _, ...rest } = prev
      return value === 'inherit' ? rest : { ...rest, [cat]: value === 'on' }
    })
  }

  const handleSaveGroupConfig = async () => {
    if (!editingGroup) return

    try {
      setGroupSaving(true)
      const storage: StoragePermission | null = groupStorageEnabled
        ? {
            workspace_path: groupStoragePath.trim(),
            access: groupStorageAccess,
          }
        : null

      const memoryScopes = groupMemoryScopes
        .split(',')
        .map((scope) => scope.trim())
        .filter(Boolean)

      const config = {
        tool_access: Object.keys(groupToolOverrides).length > 0
          ? groupToolOverrides as Partial<ToolAccessConfig>
          : undefined,
        storage,
        memory_scopes: memoryScopes.length > 0 ? memoryScopes : undefined,
      }

      await sessionService.updateConfig(editingGroup.id, config)
      setGroupHasExistingConfig(true)
      success('群聊权限配置已保存')
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : '保存失败'
      notifyError(message)
    } finally {
      setGroupSaving(false)
    }
  }

  const handleResetGroupConfig = async () => {
    if (!editingGroup) return

    try {
      setGroupSaving(true)
      await sessionService.deleteConfig(editingGroup.id)
      resetGroupConfigForm()
      success('已重置为继承模板')
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : '重置失败'
      notifyError(message)
    } finally {
      setGroupSaving(false)
    }
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
              当前对象域：{domain === 'friends' ? '好友' : domain === 'privatePool' ? '私聊池' : '群聊'}
            </div>
          </div>
        </Card>

        <div style={panelStyle}>
          <DomainNav activeDomain={domain} onChange={setDomain} />

          <ObjectList
            domain={domain}
            items={filteredItems}
            selectedId={selectedItem?.id ?? null}
            onSelect={(id) => setSelectedIds((prev) => ({ ...prev, [domain]: id }))}
          />

          {domain === 'friends' ? (
            <FriendWorkbench
              friend={(selectedItem as DialogObjectFriend | null)}
              editName={editName}
              editPerm={editPerm}
              editTemplateId={editTemplateId}
              permissionTemplates={permissionTemplates}
              savingFriend={savingFriend}
              confirmUnlinkKey={confirmUnlinkKey}
              unlinkingIdentity={unlinkingIdentity}
              onEditNameChange={setEditName}
              onEditPermChange={setEditPerm}
              onEditTemplateChange={setEditTemplateId}
              onSave={handleSaveFriend}
              onOpenBindDrawer={() => setShowBindDrawer(true)}
              onRequestUnlink={setConfirmUnlinkKey}
              onCancelUnlink={() => setConfirmUnlinkKey(null)}
              onConfirmUnlink={handleUnlinkIdentity}
            />
          ) : domain === 'privatePool' ? (
            <PrivatePoolWorkbench
              entry={(selectedItem as DialogObjectPrivatePoolEntry | null)}
              onAssignToFriend={() => {
                if (selectedItem) {
                  void openAssignModal(selectedItem as DialogObjectPrivatePoolEntry, 'privatePool')
                }
              }}
              onCreateFriend={() => {
                if (selectedItem) {
                  openCreateModal(selectedItem as DialogObjectPrivatePoolEntry, 'privatePool')
                }
              }}
            />
          ) : (
            <GroupWorkbench
              group={(selectedItem as DialogObjectGroupEntry | null)}
              onEditPermission={() => {
                if (selectedItem) {
                  void openGroupPermissionEditor(selectedItem as DialogObjectGroupEntry)
                }
              }}
            />
          )}
        </div>
      </div>

      <Drawer open={applicationQueueOpen} onClose={() => setApplicationQueueOpen(false)} width={520}>
        <ApplicationQueueModal
          applications={applications}
          selectedApplicationId={selectedApplicationId}
          masterFriendCount={masterFriends.length}
          actionLoading={actionLoading}
          onSelectApplication={setSelectedApplicationId}
          onAssignExistingFriend={(application) => openAssignModal({
            id: application.id,
            channel_id: application.channel_id,
            title: application.platform_display_name,
          }, 'application')}
          onCreateFriend={(application) => openCreateModal({
            id: application.id,
            channel_id: application.channel_id,
            title: application.platform_display_name,
          }, 'application', application.platform_display_name)}
          onLinkMaster={(application) => void handleLinkApplicationMaster(application)}
          onReject={(application) => void handleRejectApplication(application)}
        />
      </Drawer>

      {showBindDrawer && domain === 'friends' && selectedItem && (
        <Drawer open onClose={() => setShowBindDrawer(false)} width={420}>
          <div style={{ display: 'grid', gap: '1rem' }}>
            <h2 style={{ margin: 0 }}>绑定 Channel 身份</h2>
            <Input
              label="Channel ID"
              aria-label="Channel ID"
              value={bindChannelId}
              onChange={(event) => setBindChannelId(event.target.value)}
            />
            <Input
              label="平台用户 ID"
              aria-label="平台用户 ID"
              value={bindPlatformUserId}
              onChange={(event) => setBindPlatformUserId(event.target.value)}
            />
            <Input
              label="平台显示名称（可选）"
              aria-label="平台显示名称（可选）"
              value={bindDisplayName}
              onChange={(event) => setBindDisplayName(event.target.value)}
            />
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <Button
                variant="primary"
                onClick={handleBindIdentity}
                disabled={bindingIdentity || !bindChannelId.trim() || !bindPlatformUserId.trim()}
              >
                {bindingIdentity ? '绑定中...' : '绑定'}
              </Button>
              <Button variant="secondary" onClick={() => setShowBindDrawer(false)} disabled={bindingIdentity}>
                取消
              </Button>
            </div>
          </div>
        </Drawer>
      )}

      {createTarget && (
        <Drawer open onClose={() => {
          setCreateTarget(null)
          setCreateTargetKind('privatePool')
        }} width={420}>
          <div style={{ display: 'grid', gap: '1rem' }}>
            <h2 style={{ margin: 0 }}>{createTargetKind === 'application' ? '从申请新建好友' : '从私聊新建好友'}</h2>
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
              <Button variant="secondary" onClick={() => {
                setCreateTarget(null)
                setCreateTargetKind('privatePool')
              }} disabled={actionLoading}>
                取消
              </Button>
            </div>
          </div>
        </Drawer>
      )}

      {assignTarget && (
        <Drawer open onClose={() => {
          setAssignTarget(null)
          setAssignTargetKind('privatePool')
        }} width={420}>
          <div style={{ display: 'grid', gap: '1rem' }}>
            <h2 style={{ margin: 0 }}>{assignTargetKind === 'application' ? '申请归到已有好友' : '归到已有好友'}</h2>
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
              <Button variant="secondary" onClick={() => {
                setAssignTarget(null)
                setAssignTargetKind('privatePool')
              }} disabled={actionLoading}>
                取消
              </Button>
            </div>
          </div>
        </Drawer>
      )}

      {editingGroup && (
        <Drawer open onClose={closeGroupPermissionEditor} width={540}>
          <div style={{ display: 'grid', gap: '1rem' }}>
            <div>
              <h2 style={{ margin: 0 }}>群聊权限编辑</h2>
              <p style={{ color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
                只编辑群聊自己的会话覆盖，不包含 `template_id`。
              </p>
            </div>

            {groupConfigLoading ? (
              <Loading />
            ) : (
              <>
                <div style={{ display: 'grid', gap: '0.75rem' }}>
                  <div style={{ fontWeight: 600 }}>工具访问覆盖</div>
                  <div className="session-tri-grid">
                    {TOOL_CATEGORIES.map((category) => (
                      <GroupTriStateToggle
                        key={category}
                        label={TOOL_CATEGORY_LABELS[category]}
                        category={category}
                        value={getGroupTriState(category)}
                        onChange={setGroupTriState}
                      />
                    ))}
                  </div>
                </div>

                <div style={{ display: 'grid', gap: '0.75rem' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <input
                      type="checkbox"
                      checked={groupStorageEnabled}
                      onChange={(event) => setGroupStorageEnabled(event.target.checked)}
                    />
                    覆盖存储权限
                  </label>
                  {groupStorageEnabled && (
                    <div style={{ display: 'grid', gap: '0.75rem' }}>
                      <Input
                        label="存储路径"
                        aria-label="存储路径"
                        value={groupStoragePath}
                        onChange={(event) => setGroupStoragePath(event.target.value)}
                      />
                      <label style={{ display: 'grid', gap: '0.35rem' }}>
                        <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>存储权限</span>
                        <select
                          aria-label="存储权限"
                          value={groupStorageAccess}
                          onChange={(event) => setGroupStorageAccess(event.target.value as 'read' | 'readwrite')}
                          className="select"
                        >
                          <option value="read">只读</option>
                          <option value="readwrite">读写</option>
                        </select>
                      </label>
                    </div>
                  )}
                </div>

                <Input
                  label="记忆范围覆盖"
                  aria-label="记忆范围覆盖"
                  value={groupMemoryScopes}
                  onChange={(event) => setGroupMemoryScopes(event.target.value)}
                  help="逗号分隔，如：group-a, group-b"
                />

                <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                  <Button
                    variant="primary"
                    onClick={() => void handleSaveGroupConfig()}
                    disabled={groupSaving}
                  >
                    {groupSaving ? '保存中...' : '保存配置'}
                  </Button>
                  {groupHasExistingConfig && (
                    <Button
                      variant="secondary"
                      onClick={() => void handleResetGroupConfig()}
                      disabled={groupSaving}
                    >
                      重置为继承
                    </Button>
                  )}
                </div>
              </>
            )}
          </div>
        </Drawer>
      )}
    </MainLayout>
  )
}

export default DialogObjectsPage
