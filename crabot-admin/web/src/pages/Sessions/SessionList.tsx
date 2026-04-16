import { useState, useEffect, useCallback, useRef } from 'react'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Button } from '../../components/Common/Button'
import { Input } from '../../components/Common/Input'
import { Loading } from '../../components/Common/Loading'
import { Select } from '../../components/Common/Select'
import { useToast } from '../../contexts/ToastContext'
import { channelService } from '../../services/channel'
import { sessionService } from '../../services/session'
import type { ChannelSession, SessionPermissionConfig } from '../../services/session'
import type { ChannelInstance, StoragePermission, ToolAccessConfig, ToolCategory } from '../../types'
import { TOOL_CATEGORIES, TOOL_CATEGORY_LABELS } from '../../types'
import { colorFromId } from '../../utils/color'

type TriState = 'inherit' | 'on' | 'off'

function permDotColor(state: TriState): string {
  switch (state) {
    case 'on': return 'var(--success)'
    case 'off': return 'var(--error)'
    default: return 'var(--text-muted)'
  }
}

function permDotGlow(state: TriState): string {
  switch (state) {
    case 'on': return '0 0 4px rgba(92,184,122,0.5)'
    case 'off': return '0 0 4px rgba(224,96,96,0.35)'
    default: return 'none'
  }
}

function triStateLabel(state: TriState): string {
  switch (state) {
    case 'on': return '开启'
    case 'off': return '关闭'
    default: return '继承'
  }
}

const PermissionDots: React.FC<{
  toolAccess?: Partial<Record<string, boolean>>
  size?: number
}> = ({ toolAccess, size = 6 }) => {
  return (
    <div className="session-perm-dots" title="工具权限概览">
      {TOOL_CATEGORIES.map(cat => {
        const state: TriState =
          toolAccess && cat in toolAccess
            ? (toolAccess[cat] ? 'on' : 'off')
            : 'inherit'
        return (
          <span
            key={cat}
            className="session-perm-dot"
            title={`${TOOL_CATEGORY_LABELS[cat]}: ${triStateLabel(state)}`}
            style={{
              width: size,
              height: size,
              borderRadius: '50%',
              background: permDotColor(state),
              boxShadow: permDotGlow(state),
              transition: 'all 0.25s ease',
            }}
          />
        )
      })}
    </div>
  )
}

const ParticipantAvatars: React.FC<{
  participants: ChannelSession['participants']
  max?: number
}> = ({ participants, max = 4 }) => {
  const shown = participants.slice(0, max)
  const overflow = participants.length - max
  return (
    <div className="session-avatars">
      {shown.map((p, i) => (
        <div
          key={p.platform_user_id + i}
          className="session-avatar"
          style={{ background: colorFromId(p.platform_user_id) }}
          title={p.platform_user_id}
        >
          {p.platform_user_id.charAt(0).toUpperCase()}
        </div>
      ))}
      {overflow > 0 && (
        <div className="session-avatar session-avatar-overflow">
          +{overflow}
        </div>
      )}
    </div>
  )
}

const TriStateToggle: React.FC<{
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
      title={`${label}: ${triStateLabel(value)}${value === 'inherit' ? '模板' : ''} (点击切换)`}
    >
      <span className="session-tri-toggle-indicator" />
      <span className="session-tri-toggle-label">{label}</span>
    </button>
  )
}

export const SessionList: React.FC = () => {
  const toast = useToast()

  const [channels, setChannels] = useState<ChannelInstance[]>([])
  const [selectedChannelId, setSelectedChannelId] = useState('')
  const [channelsLoading, setChannelsLoading] = useState(true)

  const [sessions, setSessions] = useState<ChannelSession[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [typeFilter, setTypeFilter] = useState<string>('')
  const [searchQuery, setSearchQuery] = useState('')

  const [permCache, setPermCache] = useState<Record<string, SessionPermissionConfig | null>>({})
  const permLoadedRef = useRef<Set<string>>(new Set())
  const loadRequestIdRef = useRef(0)

  const [editingSession, setEditingSession] = useState<ChannelSession | null>(null)
  const [configLoading, setConfigLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const [toolOverrides, setToolOverrides] = useState<Record<string, boolean>>({})
  const [storageEnabled, setStorageEnabled] = useState(false)
  const [storagePath, setStoragePath] = useState('')
  const [storageAccess, setStorageAccess] = useState<'read' | 'readwrite'>('read')
  const [memoryScopes, setMemoryScopes] = useState('')
  const [templateId, setTemplateId] = useState('')

  const modalOpen = editingSession !== null
  const hasExistingConfig = editingSession != null && permCache[editingSession.id] != null

  useEffect(() => {
    const loadChannels = async () => {
      try {
        setChannelsLoading(true)
        const result = await channelService.listInstances()
        setChannels(result.items)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : '加载 Channel 列表失败')
      } finally {
        setChannelsLoading(false)
      }
    }
    loadChannels()
  }, [toast])

  useEffect(() => {
    if (channelsLoading) return

    const requestId = ++loadRequestIdRef.current

    const load = async () => {
      setSessionsLoading(true)
      try {
        let items: ChannelSession[]
        if (selectedChannelId) {
          const result = await sessionService.listSessions(
            selectedChannelId,
            typeFilter || undefined
          )
          items = result.items.filter(s => s.channel_id === selectedChannelId)
        } else {
          const results = await Promise.allSettled(
            channels.map(ch =>
              sessionService.listSessions(ch.id, typeFilter || undefined)
                .then(r => ({
                  ...r,
                  items: r.items.filter(s => s.channel_id === ch.id),
                }))
            )
          )
          const seen = new Set<string>()
          const merged: ChannelSession[] = []
          for (const r of results) {
            if (r.status === 'fulfilled') {
              for (const s of r.value.items) {
                if (!seen.has(s.id)) {
                  seen.add(s.id)
                  merged.push(s)
                }
              }
            }
          }
          items = merged
        }
        if (requestId === loadRequestIdRef.current) {
          setSessions(items)
        }
      } catch (err) {
        if (requestId === loadRequestIdRef.current) {
          toast.error(err instanceof Error ? err.message : '加载会话列表失败')
          setSessions([])
        }
      } finally {
        if (requestId === loadRequestIdRef.current) {
          setSessionsLoading(false)
        }
      }
    }
    load()
  }, [selectedChannelId, channels, channelsLoading, typeFilter, toast])

  // Generation counter prevents stale permission batches from overwriting fresh data
  const sessionGenRef = useRef(0)

  useEffect(() => {
    const gen = ++sessionGenRef.current
    permLoadedRef.current = new Set()
    setPermCache({})

    const loadPerms = async () => {
      const toLoad = sessions.filter(s => !permLoadedRef.current.has(s.id))
      if (toLoad.length === 0) return

      const BATCH_SIZE = 6
      for (let i = 0; i < toLoad.length; i += BATCH_SIZE) {
        if (gen !== sessionGenRef.current) return

        const batch = toLoad.slice(i, i + BATCH_SIZE)
        const results: Record<string, SessionPermissionConfig | null> = {}
        await Promise.allSettled(
          batch.map(async (s) => {
            try {
              const res = await sessionService.getConfig(s.id)
              results[s.id] = res.config
            } catch {
              results[s.id] = null
            }
            permLoadedRef.current.add(s.id)
          })
        )
        if (gen !== sessionGenRef.current) return
        setPermCache(prev => ({ ...prev, ...results }))
      }
    }
    loadPerms()
  }, [sessions])

  const filteredSessions = sessions.filter(s => {
    if (!searchQuery) return true
    const q = searchQuery.toLowerCase()
    return (
      (s.title && s.title.toLowerCase().includes(q)) ||
      s.platform_session_id.toLowerCase().includes(q) ||
      s.participants.some(p => p.platform_user_id.toLowerCase().includes(q))
    )
  })

  const privateSessions = filteredSessions.filter(s => s.type === 'private')
  const groupSessions = filteredSessions.filter(s => s.type === 'group')

  const overrideCount = sessions.filter(s => permCache[s.id] != null).length

  const resetForm = useCallback(() => {
    setToolOverrides({})
    setStorageEnabled(false)
    setStoragePath('')
    setStorageAccess('read')
    setMemoryScopes('')
    setTemplateId('')
  }, [])

  const openConfig = useCallback(async (session: ChannelSession) => {
    setEditingSession(session)
    resetForm()
    setConfigLoading(true)
    try {
      const result = await sessionService.getConfig(session.id)
      const cfg = result.config
      if (cfg) {
        setToolOverrides(cfg.tool_access ? { ...cfg.tool_access } : {})
        if (cfg.storage) {
          setStorageEnabled(true)
          setStoragePath(cfg.storage.workspace_path)
          setStorageAccess(cfg.storage.access)
        }
        setMemoryScopes(cfg.memory_scopes ? cfg.memory_scopes.join(', ') : '')
        setTemplateId(cfg.template_id ?? '')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加载会话配置失败')
    } finally {
      setConfigLoading(false)
    }
  }, [toast, resetForm])

  const closeModal = useCallback(() => {
    setEditingSession(null)
  }, [])

  useEffect(() => {
    if (!modalOpen) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeModal()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [modalOpen, closeModal])

  const getTriState = (cat: string): TriState => {
    if (!(cat in toolOverrides)) return 'inherit'
    return toolOverrides[cat] ? 'on' : 'off'
  }

  const setTriState = (cat: string, value: TriState) => {
    setToolOverrides(prev => {
      const { [cat]: _, ...rest } = prev
      return value === 'inherit' ? rest : { ...rest, [cat]: value === 'on' }
    })
  }

  const handleSave = async () => {
    if (!editingSession) return
    setSaving(true)
    try {
      const storage: StoragePermission | null = storageEnabled
        ? { workspace_path: storagePath, access: storageAccess }
        : null

      const scopesArr = memoryScopes
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)

      const newConfig = {
        tool_access: Object.keys(toolOverrides).length > 0
          ? toolOverrides as Partial<ToolAccessConfig>
          : undefined,
        storage,
        memory_scopes: scopesArr.length > 0 ? scopesArr : undefined,
        template_id: templateId || undefined,
      }

      await sessionService.updateConfig(editingSession.id, newConfig)
      toast.success('会话权限配置已保存')

      setPermCache(prev => ({
        ...prev,
        [editingSession.id]: {
          ...newConfig,
          updated_at: new Date().toISOString(),
        } as SessionPermissionConfig,
      }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleResetConfig = async () => {
    if (!editingSession) return
    setSaving(true)
    try {
      await sessionService.deleteConfig(editingSession.id)
      toast.success('已重置为继承模板')
      resetForm()
      setPermCache(prev => ({ ...prev, [editingSession.id]: null }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重置失败')
    } finally {
      setSaving(false)
    }
  }

  const channelOptions = [
    { value: '', label: '全部 Channel' },
    ...channels.map(ch => ({
      value: ch.id,
      label: `${ch.name} (${ch.platform})`,
    })),
  ]

  const typeOptions = [
    { value: '', label: '全部类型' },
    { value: 'private', label: '私聊' },
    { value: 'group', label: '群聊' },
  ]

  const renderSessionCard = (session: ChannelSession) => {
    const perm = permCache[session.id]
    const isCustomized = perm != null
    const isActive = editingSession?.id === session.id

    return (
      <div
        key={session.id}
        className={`session-card ${isActive ? 'session-card--active' : ''} ${isCustomized ? 'session-card--customized' : ''}`}
        onClick={() => openConfig(session)}
      >
        <div className="session-card-header">
          <div className="session-card-title-row">
            <span className={`session-type-indicator session-type-indicator--${session.type}`} />
            <span className="session-card-title">
              {session.title || session.platform_session_id}
            </span>
          </div>
          {isCustomized && (
            <span className="session-customized-badge">
              已自定义
            </span>
          )}
        </div>

        <div className="session-card-body">
          <PermissionDots toolAccess={perm?.tool_access} />
          <ParticipantAvatars participants={session.participants} />
        </div>

        <div className="session-card-footer">
          <span className="session-card-meta">
            {session.participants.length} 位参与者
          </span>
          {perm?.template_id && (
            <span className="session-template-tag">
              {perm.template_id}
            </span>
          )}
          {perm?.memory_scopes && perm.memory_scopes.length > 0 && (
            <span className="session-scope-tag">
              {perm.memory_scopes.length} 个记忆范围
            </span>
          )}
        </div>
      </div>
    )
  }

  const renderGroup = (title: string, icon: string, items: ChannelSession[]) => {
    if (items.length === 0) return null
    return (
      <div className="session-group">
        <div className="session-group-header">
          <span className="session-group-icon">{icon}</span>
          <span className="session-group-title">{title}</span>
          <span className="session-group-count">{items.length}</span>
          <span className="session-group-line" />
        </div>
        <div className="session-grid">
          {items.map(renderSessionCard)}
        </div>
      </div>
    )
  }

  return (
    <MainLayout>
      <div className="session-page">
        <div className="session-page-header">
          <div>
            <h1 className="session-page-title">会话管理</h1>
            <p className="session-page-subtitle">
              权限观察与覆盖配置
              {sessions.length > 0 && (
                <span className="session-stats">
                  <span className="session-stats-dot" />
                  {sessions.length} 个会话
                  {overrideCount > 0 && (
                    <>, <span style={{ color: 'var(--primary-light)' }}>{overrideCount} 个已自定义</span></>
                  )}
                </span>
              )}
            </p>
          </div>
        </div>

        {channelsLoading ? (
          <Loading />
        ) : channels.length === 0 ? (
          <div className="session-empty-state">
            <div className="session-empty-icon">
              <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                <circle cx="24" cy="24" r="20" stroke="var(--text-muted)" strokeWidth="1.5" strokeDasharray="4 3" />
                <path d="M17 20h14M17 28h8" stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </div>
            <p className="session-empty-text">暂无已注册的 Channel 模块</p>
            <p className="session-empty-hint">请先在 Channel 配置中添加连接</p>
          </div>
        ) : (
          <>
            <div className="session-filter-bar">
              <div className="session-filter-channel">
                <Select
                  label="Channel"
                  options={channelOptions}
                  value={selectedChannelId}
                  onChange={e => setSelectedChannelId(e.target.value)}
                />
              </div>
              <div className="session-filter-type">
                <Select
                  label="类型"
                  options={typeOptions}
                  value={typeFilter}
                  onChange={e => setTypeFilter(e.target.value)}
                />
              </div>
              <div className="session-filter-search">
                <Input
                  label="搜索"
                  placeholder="会话名、参与者..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                />
              </div>
            </div>

            <div className="session-legend">
              <span className="session-legend-label">权限图例</span>
              {(['on', 'off', 'inherit'] as const).map(s => (
                <span key={s} className="session-legend-item">
                  <span className="session-legend-dot" style={{ background: permDotColor(s), boxShadow: permDotGlow(s) }} />
                  {triStateLabel(s)}
                </span>
              ))}
              <span className="session-legend-sep" />
              {TOOL_CATEGORIES.map((cat, i) => (
                <span key={cat} className="session-legend-cat" title={TOOL_CATEGORY_LABELS[cat]}>
                  {i + 1}.{TOOL_CATEGORY_LABELS[cat]}
                </span>
              ))}
            </div>

            {sessionsLoading ? (
              <Loading />
            ) : filteredSessions.length === 0 ? (
              <div className="session-empty-state">
                <div className="session-empty-icon">
                  <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                    <rect x="8" y="12" width="32" height="24" rx="4" stroke="var(--text-muted)" strokeWidth="1.5" />
                    <path d="M8 20h32" stroke="var(--text-muted)" strokeWidth="1.5" />
                    <circle cx="14" cy="16" r="1.5" fill="var(--text-muted)" />
                    <circle cx="20" cy="16" r="1.5" fill="var(--text-muted)" />
                  </svg>
                </div>
                <p className="session-empty-text">
                  {searchQuery ? '没有匹配的会话' : '该 Channel 暂无会话'}
                </p>
              </div>
            ) : typeFilter ? (
              <div className="session-grid">
                {filteredSessions.map(renderSessionCard)}
              </div>
            ) : (
              <>
                {renderGroup('私聊', '◈', privateSessions)}
                {renderGroup('群聊', '◇', groupSessions)}
              </>
            )}
          </>
        )}
      </div>

      {editingSession && (
        <div className="session-modal-overlay" onClick={closeModal}>
          <div className="session-modal" onClick={e => e.stopPropagation()}>
            <button className="session-modal-close" onClick={closeModal} aria-label="关闭">&times;</button>

            <div className="session-modal-header">
              <span className={`session-type-indicator session-type-indicator--${editingSession.type} session-type-indicator--lg`} />
              <div>
                <h2 className="session-modal-title">
                  {editingSession.title || editingSession.platform_session_id}
                </h2>
                <span className="session-modal-subtitle">
                  {editingSession.type === 'private' ? '私聊' : '群聊'} · {editingSession.participants.length} 位参与者
                </span>
              </div>
            </div>

            {editingSession.participants.length > 0 && (
              <div className="session-modal-participants">
                {editingSession.participants.map((p, i) => (
                  <div key={p.platform_user_id + i} className="session-modal-participant">
                    <div
                      className="session-avatar session-avatar--sm"
                      style={{ background: colorFromId(p.platform_user_id) }}
                    >
                      {p.platform_user_id.charAt(0).toUpperCase()}
                    </div>
                    <span className="session-modal-participant-id">{p.platform_user_id}</span>
                    <span className="session-modal-participant-role">{p.role}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="session-modal-divider" />

            {configLoading ? (
              <Loading />
            ) : (
              <>
                <Input
                  label="权限模板"
                  placeholder="留空使用默认模板"
                  value={templateId}
                  onChange={e => setTemplateId(e.target.value)}
                  help="指定后，未覆盖的权限项将继承该模板"
                />

                <div className="session-modal-section">
                  <label className="form-label">工具权限覆盖</label>
                  <div className="session-tri-grid">
                    {TOOL_CATEGORIES.map(cat => (
                      <TriStateToggle
                        key={cat}
                        label={TOOL_CATEGORY_LABELS[cat]}
                        category={cat}
                        value={getTriState(cat)}
                        onChange={setTriState}
                      />
                    ))}
                  </div>
                </div>

                <div className="session-modal-section">
                  <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      type="checkbox"
                      checked={storageEnabled}
                      onChange={e => setStorageEnabled(e.target.checked)}
                    />
                    覆盖存储权限
                  </label>
                  {storageEnabled && (
                    <div style={{ marginTop: 8, display: 'flex', gap: '0.5rem' }}>
                      <input
                        className="input"
                        placeholder="workspace_path"
                        value={storagePath}
                        onChange={e => setStoragePath(e.target.value)}
                        style={{ flex: 1 }}
                      />
                      <select
                        className="select"
                        value={storageAccess}
                        onChange={e => setStorageAccess(e.target.value as 'read' | 'readwrite')}
                        style={{ width: 120 }}
                      >
                        <option value="read">只读</option>
                        <option value="readwrite">读写</option>
                      </select>
                    </div>
                  )}
                </div>

                <Input
                  label="记忆范围覆盖"
                  placeholder="逗号分隔，如: personal, shared"
                  value={memoryScopes}
                  onChange={e => setMemoryScopes(e.target.value)}
                />

                <div className="session-modal-actions">
                  <Button onClick={handleSave} disabled={saving}>
                    {saving ? '保存中...' : '保存配置'}
                  </Button>
                  {hasExistingConfig && (
                    <Button variant="secondary" onClick={handleResetConfig} disabled={saving}>
                      重置为继承
                    </Button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </MainLayout>
  )
}
