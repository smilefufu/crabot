import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../../components/Common/Button'
import { Drawer } from '../../components/Common/Drawer'
import { Input } from '../../components/Common/Input'
import { Loading } from '../../components/Common/Loading'
import { MainLayout } from '../../components/Layout/MainLayout'
import { useToast } from '../../contexts/ToastContext'
import { useDialogApplications } from '../../contexts/DialogApplicationsContext'
import { dialogObjectsService } from '../../services/dialog-objects'
import { friendService } from '../../services/friend'
import { permissionTemplateService } from '../../services/permission-template'
import { sessionService } from '../../services/session'
import { ApplicationQueueModal } from './components/ApplicationQueueModal'
import { DialogDomain, DomainNav } from './components/DomainNav'
import { FriendWorkbench } from './components/FriendWorkbench'
import { GroupWorkbench } from './components/GroupWorkbench'
import {
  buildExplicitFriendPermissionConfig,
  parseMemoryScopes,
  summarizeFriendMemoryScopes,
  summarizeFriendStorage,
} from './friend-permission-utils'
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
type FriendPermissionState = 'idle' | 'loading' | 'ready' | 'unavailable'

const DEFAULT_STORAGE_PATH = '/workspace'

function buildToolAccess(defaultValue: boolean): ToolAccessConfig {
  return {
    memory: defaultValue,
    messaging: defaultValue,
    task: defaultValue,
    mcp_skill: defaultValue,
    file_io: defaultValue,
    browser: defaultValue,
    shell: defaultValue,
    remote_exec: defaultValue,
    desktop: defaultValue,
  }
}

function resolveGroupPermissions(
  sessionId: string,
  template: PermissionTemplate,
  config: {
    tool_access?: Partial<ToolAccessConfig>
    storage?: StoragePermission | null
    memory_scopes?: string[]
  } | null
): {
  tool_access: ToolAccessConfig
  storage: StoragePermission | null
  memory_scopes: string[]
} {
  const tool_access = {
    ...template.tool_access,
    ...(config?.tool_access ?? {}),
  }
  const storage = config?.storage !== undefined ? config.storage : template.storage
  const memory_scopes = config?.memory_scopes !== undefined
    ? config.memory_scopes
    : template.memory_scopes

  return {
    tool_access,
    storage,
    memory_scopes: memory_scopes.length > 0 ? memory_scopes : [sessionId],
  }
}

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

export const DialogObjectsPage: React.FC = () => {
  const { success, error: notifyError } = useToast()
  const { refresh: refreshApplicationCount } = useDialogApplications()
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
  const [savingFriendMetadata, setSavingFriendMetadata] = useState(false)
  const [friendPermissionLoading, setFriendPermissionLoading] = useState(false)
  const [friendPermissionState, setFriendPermissionState] = useState<FriendPermissionState>('idle')
  const [friendPermissionUnavailableMessage, setFriendPermissionUnavailableMessage] = useState<string | null>(null)
  const [savingFriendPermissions, setSavingFriendPermissions] = useState(false)
  const [friendToolAccess, setFriendToolAccess] = useState<ToolAccessConfig>(() => buildToolAccess(false))
  const [friendStorageEnabled, setFriendStorageEnabled] = useState(false)
  const [friendStoragePath, setFriendStoragePath] = useState('')
  const [friendStorageAccess, setFriendStorageAccess] = useState<'read' | 'readwrite'>('read')
  const [friendMemoryMode, setFriendMemoryMode] = useState<'empty' | 'custom'>('empty')
  const [friendMemoryScopesInput, setFriendMemoryScopesInput] = useState('')
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
  const [groupToolAccess, setGroupToolAccess] = useState<ToolAccessConfig>(() => buildToolAccess(false))
  const [groupStorageEnabled, setGroupStorageEnabled] = useState(false)
  const [groupStoragePath, setGroupStoragePath] = useState('')
  const [groupStorageAccess, setGroupStorageAccess] = useState<'read' | 'readwrite'>('read')
  const [groupMemoryMode, setGroupMemoryMode] = useState<'session' | 'custom'>('session')
  const [groupMemoryScopesInput, setGroupMemoryScopesInput] = useState('')
  const initialLoadDone = useRef(false)

  const resetFriendPermissionForm = useCallback(() => {
    setFriendPermissionState('idle')
    setFriendPermissionUnavailableMessage(null)
    setFriendToolAccess(buildToolAccess(false))
    setFriendStorageEnabled(false)
    setFriendStoragePath('')
    setFriendStorageAccess('read')
    setFriendMemoryMode('empty')
    setFriendMemoryScopesInput('')
  }, [])

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
        refreshApplicationCount().catch(() => {})
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
  }, [notifyError, refreshApplicationCount])

  useEffect(() => {
    if (!initialLoadDone.current) {
      initialLoadDone.current = true
      void loadDialogObjects(true)
      return
    }
    void loadDialogObjects(false)
  }, [loadDialogObjects, refreshKey])

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void loadDialogObjects(false)
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', onVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', onVisibilityChange)
    }
  }, [loadDialogObjects])

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
    setShowBindDrawer(false)
    setBindChannelId('')
    setBindPlatformUserId('')
    setBindDisplayName('')
    setConfirmUnlinkKey(null)
    resetFriendPermissionForm()
  }, [domain, selectedItem, resetFriendPermissionForm])

  useEffect(() => {
    if (domain !== 'friends' || !selectedItem) return undefined
    const friend = selectedItem as DialogObjectFriend
    if (friend.permission === 'master') {
      resetFriendPermissionForm()
      return undefined
    }

    let active = true
    setFriendPermissionState('loading')
    setFriendPermissionUnavailableMessage(null)
    setFriendPermissionLoading(true)

    void friendService.getPermissions(friend.id)
      .then((result) => {
        if (!active) return
        if (!result.resolved) {
          setFriendPermissionState('unavailable')
          setFriendPermissionUnavailableMessage('好友权限暂时不可编辑，请先刷新或修复加载错误。')
          notifyError('好友权限未返回可编辑配置')
          return
        }
        const resolved = result.resolved
        setFriendToolAccess(resolved.tool_access)
        setFriendStorageEnabled(resolved.storage !== null)
        setFriendStoragePath(resolved.storage?.workspace_path ?? DEFAULT_STORAGE_PATH)
        setFriendStorageAccess(resolved.storage?.access ?? 'read')
        setFriendMemoryMode(resolved.memory_scopes.length === 0 ? 'empty' : 'custom')
        setFriendMemoryScopesInput(resolved.memory_scopes.join(', '))
        setFriendPermissionState('ready')
      })
      .catch((caughtError) => {
        if (!active) return
        const message = caughtError instanceof Error ? caughtError.message : '加载好友权限失败'
        setFriendPermissionState('unavailable')
        setFriendPermissionUnavailableMessage('好友权限暂时不可编辑，请先刷新或修复加载错误。')
        notifyError(message)
      })
      .finally(() => {
        if (active) {
          setFriendPermissionLoading(false)
        }
      })

    return () => {
      active = false
    }
  }, [domain, selectedItem, notifyError, resetFriendPermissionForm])

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

  const handleSaveFriendMetadata = async () => {
    if (domain !== 'friends' || !selectedItem || !editName.trim()) return
    const friend = selectedItem as DialogObjectFriend
    try {
      setSavingFriendMetadata(true)
      await friendService.updateFriend(friend.id, {
        display_name: editName.trim(),
        permission: editPerm,
      })
      success('好友基础信息已保存')
      triggerRefresh()
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : '保存失败'
      notifyError(message)
    } finally {
      setSavingFriendMetadata(false)
    }
  }

  const handleSaveFriendPermissions = async () => {
    if (domain !== 'friends' || !selectedItem) return
    const friend = selectedItem as DialogObjectFriend
    if (friend.permission === 'master' || friendPermissionState !== 'ready') return

    try {
      setSavingFriendPermissions(true)
      const trimmedStoragePath = friendStoragePath.trim()
      if (friendStorageEnabled && !trimmedStoragePath) {
        notifyError('存储路径不能为空')
        return
      }

      const memoryScopes = friendMemoryMode === 'empty'
        ? []
        : parseMemoryScopes(friendMemoryScopesInput)
      if (friendMemoryMode === 'custom' && memoryScopes.length === 0) {
        notifyError('请至少填写一个记忆范围，或切换到空范围')
        return
      }

      await friendService.updatePermissions(friend.id, buildExplicitFriendPermissionConfig({
        tool_access: friendToolAccess,
        storage: friendStorageEnabled
          ? {
              workspace_path: trimmedStoragePath,
              access: friendStorageAccess,
            }
          : null,
        memory_scopes: memoryScopes,
      }))
      success('好友权限已保存')
      triggerRefresh()
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : '保存失败'
      notifyError(message)
    } finally {
      setSavingFriendPermissions(false)
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
    setGroupToolAccess(buildToolAccess(false))
    setGroupStorageEnabled(false)
    setGroupStoragePath('')
    setGroupStorageAccess('read')
    setGroupMemoryMode('session')
    setGroupMemoryScopesInput('')
  }, [])

  const openGroupPermissionEditor = useCallback(async (group: DialogObjectGroupEntry) => {
    setEditingGroup(group)
    resetGroupConfigForm()
    setGroupConfigLoading(true)

    try {
      const cachedGroupDefault = permissionTemplates.find((template) => template.id === 'group_default')
      const [configResult, templateResult] = await Promise.all([
        sessionService.getConfig(group.id),
        cachedGroupDefault
          ? Promise.resolve({ template: cachedGroupDefault })
          : permissionTemplateService.get('group_default'),
      ])
      const resolved = resolveGroupPermissions(group.id, templateResult.template, configResult.config)

      setGroupToolAccess(resolved.tool_access)
      setGroupStorageEnabled(resolved.storage !== null)
      setGroupStoragePath(resolved.storage?.workspace_path ?? DEFAULT_STORAGE_PATH)
      setGroupStorageAccess(resolved.storage?.access ?? 'read')
      if (resolved.memory_scopes.length === 1 && resolved.memory_scopes[0] === group.id) {
        setGroupMemoryMode('session')
        setGroupMemoryScopesInput('')
      } else {
        setGroupMemoryMode('custom')
        setGroupMemoryScopesInput(resolved.memory_scopes.join(', '))
      }
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : '加载群聊权限失败'
      notifyError(message)
    } finally {
      setGroupConfigLoading(false)
    }
  }, [notifyError, permissionTemplates, resetGroupConfigForm])

  const closeGroupPermissionEditor = useCallback(() => {
    setEditingGroup(null)
  }, [])

  const handleSaveGroupConfig = async () => {
    if (!editingGroup) return

    try {
      setGroupSaving(true)
      const trimmedStoragePath = groupStoragePath.trim()
      if (groupStorageEnabled && !trimmedStoragePath) {
        notifyError('存储路径不能为空')
        return
      }

      const memoryScopes = groupMemoryMode === 'session'
        ? [editingGroup.id]
        : parseMemoryScopes(groupMemoryScopesInput)
      if (memoryScopes.length === 0) {
        notifyError('请至少填写一个记忆范围')
        return
      }

      const storage: StoragePermission | null = groupStorageEnabled
        ? {
            workspace_path: trimmedStoragePath,
            access: groupStorageAccess,
          }
        : null

      const config = {
        tool_access: groupToolAccess,
        storage,
        memory_scopes: memoryScopes,
      }

      await sessionService.updateConfig(editingGroup.id, config)
      success('群聊权限配置已保存')
      triggerRefresh()
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : '保存失败'
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
      <div className="dlg-page">
        <header className="dlg-page__header">
          <div>
            <span className="dlg-page__eyebrow">Dialog Objects</span>
            <h1 className="dlg-page__title">对话对象管理</h1>
            <p className="dlg-page__subtitle">
              用统一模型查看好友、未归属私聊与可处理群聊；事件归属与权限调整在此一站完成。
            </p>
          </div>
          <div className="dlg-page__actions">
            <Button variant="secondary" onClick={triggerRefresh}>刷新</Button>
            <button
              type="button"
              className={`dlg-page__queue-btn${applications.length > 0 ? ' has-pending' : ''}`}
              onClick={() => setApplicationQueueOpen(true)}
              aria-label={
                applications.length > 0
                  ? `申请队列，${applications.length} 条待处理`
                  : '申请队列，暂无待处理'
              }
            >
              <span>申请队列</span>
              <span className="dlg-page__queue-count" aria-hidden="true">
                {applications.length}
              </span>
            </button>
          </div>
        </header>

        <div className="dlg-toolbar">
          <Input
            placeholder="按名字、渠道或参与者搜索"
            aria-label="搜索"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <DomainNav
            activeDomain={domain}
            onChange={setDomain}
            counts={{
              friends: friends.length,
              privatePool: privatePool.length,
              groups: groups.length,
            }}
          />
          <span className="dlg-toolbar__meta">{filteredItems.length} / {itemsByDomain[domain].length}</span>
        </div>

        <div className="dlg-body">
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
              savingMetadata={savingFriendMetadata}
              friendPermissionLoading={friendPermissionLoading}
              friendPermissionState={friendPermissionState}
              friendPermissionUnavailableMessage={friendPermissionUnavailableMessage}
              savingPermissions={savingFriendPermissions}
              friendToolAccess={friendToolAccess}
              friendStorageEnabled={friendStorageEnabled}
              friendStoragePath={friendStoragePath}
              friendStorageAccess={friendStorageAccess}
              friendMemoryMode={friendMemoryMode}
              friendMemoryScopesInput={friendMemoryScopesInput}
              confirmUnlinkKey={confirmUnlinkKey}
              unlinkingIdentity={unlinkingIdentity}
              onEditNameChange={setEditName}
              onEditPermChange={setEditPerm}
              onSaveMetadata={handleSaveFriendMetadata}
              onFriendToolAccessChange={(category, checked) => {
                setFriendToolAccess((prev) => ({ ...prev, [category]: checked }))
              }}
              onFriendStorageEnabledChange={(enabled) => {
                setFriendStorageEnabled(enabled)
                if (enabled && !friendStoragePath.trim()) {
                  setFriendStoragePath(DEFAULT_STORAGE_PATH)
                }
              }}
              onFriendStoragePathChange={setFriendStoragePath}
              onFriendStorageAccessChange={setFriendStorageAccess}
              onFriendMemoryModeChange={setFriendMemoryMode}
              onFriendMemoryScopesInputChange={setFriendMemoryScopesInput}
              onSavePermissions={handleSaveFriendPermissions}
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

      <ApplicationQueueModal
        open={applicationQueueOpen}
        onClose={() => setApplicationQueueOpen(false)}
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
                直接编辑当前生效权限。
              </p>
            </div>

            {groupConfigLoading ? (
              <Loading />
            ) : (
              <>
                <div style={{ display: 'grid', gap: '0.75rem' }}>
                  <div style={{ fontWeight: 600 }}>工具权限</div>
                  <div className="session-permission-switch-list">
                    {TOOL_CATEGORIES.map((category) => (
                      <PermissionSwitchRow
                        key={category}
                        label={TOOL_CATEGORY_LABELS[category]}
                        category={category}
                        checked={groupToolAccess[category]}
                        onChange={(cat, checked) => {
                          setGroupToolAccess((prev) => ({ ...prev, [cat]: checked }))
                        }}
                      />
                    ))}
                  </div>
                </div>

                <div style={{ display: 'grid', gap: '0.75rem' }}>
                  <div style={{ fontWeight: 600 }}>存储权限</div>
                  <label className="session-permission-switch-row">
                      <span className="session-permission-switch-value">
                        <span>启用存储</span>
                        <span>
                          {groupStorageEnabled
                          ? summarizeFriendStorage({
                              workspace_path: groupStoragePath.trim() || DEFAULT_STORAGE_PATH,
                              access: groupStorageAccess,
                            })
                          : '未开启'}
                      </span>
                    </span>
                    <span className="toggle-switch">
                      <input
                        aria-label="启用存储"
                        type="checkbox"
                        checked={groupStorageEnabled}
                        onChange={(event) => {
                          const checked = event.target.checked
                          setGroupStorageEnabled(checked)
                          if (checked && !groupStoragePath.trim()) {
                            setGroupStoragePath(DEFAULT_STORAGE_PATH)
                          }
                        }}
                      />
                      <span className="toggle-track" />
                    </span>
                  </label>
                  {groupStorageEnabled && (
                    <div className="session-detail-grid">
                      <Input
                        label="工作区路径"
                        aria-label="工作区路径"
                        value={groupStoragePath}
                        onChange={(event) => setGroupStoragePath(event.target.value)}
                        help="输入当前群聊可访问的工作区路径。"
                      />
                      <label style={{ display: 'grid', gap: '0.35rem' }}>
                        <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>访问级别</span>
                        <select
                          aria-label="访问级别"
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

                <div style={{ display: 'grid', gap: '0.75rem' }}>
                  <div style={{ fontWeight: 600 }}>记忆范围</div>
                  <div className="session-segmented-control" role="radiogroup" aria-label="记忆范围模式">
                    <label className={`session-segmented-option ${groupMemoryMode === 'session' ? 'session-segmented-option--active' : ''}`}>
                      <input
                        aria-label="当前会话"
                        type="radio"
                        name="group-memory-mode"
                        checked={groupMemoryMode === 'session'}
                        onChange={() => setGroupMemoryMode('session')}
                      />
                      <span>当前会话</span>
                    </label>
                    <label className={`session-segmented-option ${groupMemoryMode === 'custom' ? 'session-segmented-option--active' : ''}`}>
                      <input
                        aria-label="自定义范围"
                        type="radio"
                        name="group-memory-mode"
                        checked={groupMemoryMode === 'custom'}
                        onChange={() => setGroupMemoryMode('custom')}
                      />
                      <span>自定义范围</span>
                    </label>
                  </div>

                  {groupMemoryMode === 'custom' && (
                    <label style={{ display: 'grid', gap: '0.35rem' }}>
                      <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>范围标识</span>
                      <textarea
                        aria-label="范围标识"
                        className="textarea"
                        value={groupMemoryScopesInput}
                        onChange={(event) => setGroupMemoryScopesInput(event.target.value)}
                        placeholder="例如：group-a, group-b"
                      />
                      <span className="form-help">多个范围可用逗号或换行分隔。</span>
                    </label>
                  )}

                  <div className="session-inline-summary">
                    当前生效：
                    {' '}
                    {summarizeFriendMemoryScopes(
                      editingGroup.id,
                      groupMemoryMode === 'session'
                        ? [editingGroup.id]
                        : parseMemoryScopes(groupMemoryScopesInput)
                    )}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                  <Button
                    variant="primary"
                    onClick={() => void handleSaveGroupConfig()}
                    disabled={groupSaving}
                  >
                    {groupSaving ? '保存中...' : '保存配置'}
                  </Button>
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
