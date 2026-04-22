import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { Loading } from '../../components/Common/Loading'
import { ConfirmModal } from '../../components/Common/ConfirmModal'
import { useToast } from '../../contexts/ToastContext'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  memoryService,
  sceneToKey,
  type MemoryModule,
  type MemoryStats,
  type SceneProfile,
  type ShortTermMemoryEntry,
  type LongTermMemoryEntry,
} from '../../services/memory'
import type { MemoryContextQuery } from './memoryContextQuery'

type TabType = 'short' | 'long'
type DetailLevel = 'L0' | 'L1' | 'L2'
type TaskMode = 'browse' | 'search' | 'context'

interface MemoryBrowserProps {
  initialTab?: TabType
  initialMode?: TaskMode
  initialContext?: MemoryContextQuery
}

const MODE_LABELS: Record<TaskMode, string> = {
  browse: '浏览最近',
  search: '语义搜索',
  context: '按上下文查看',
}

export const MemoryBrowser: React.FC<MemoryBrowserProps> = ({
  initialTab = 'short',
  initialMode = 'browse',
  initialContext,
}) => {
  const toast = useToast()
  const navigate = useNavigate()

  const contextFilters = useMemo(
    () => ({
      friendId: initialContext?.friendId,
      accessibleScopes: initialContext?.accessibleScopes ?? [],
      contextLabel: initialContext?.contextLabel?.trim() ?? '',
      memoryId: initialContext?.memoryId,
    }),
    [initialContext],
  )
  const hasContextFilter = Boolean(
    contextFilters.friendId || contextFilters.accessibleScopes.length > 0,
  )

  const [modules, setModules] = useState<MemoryModule[]>([])
  const [selectedModuleId, setSelectedModuleId] = useState<string | undefined>(undefined)
  const [stats, setStats] = useState<MemoryStats | null>(null)
  const [tab, setTab] = useState<TabType>(initialTab)
  const [mode, setMode] = useState<TaskMode>(initialMode)
  const [query, setQuery] = useState('')
  const [shortTermEntries, setShortTermEntries] = useState<ShortTermMemoryEntry[]>([])
  const [longTermEntries, setLongTermEntries] = useState<LongTermMemoryEntry[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [longTermDetailLevels, setLongTermDetailLevels] = useState<Map<string, DetailLevel>>(new Map())
  const [loading, setLoading] = useState(true)
  const [listLoading, setListLoading] = useState(false)
  const [serviceError, setServiceError] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [l2Loading, setL2Loading] = useState<string | null>(null)
  const [relatedSceneProfiles, setRelatedSceneProfiles] = useState<Record<string, SceneProfile[]>>({})

  useEffect(() => {
    setTab(initialTab)
  }, [initialTab])

  useEffect(() => {
    setMode(initialMode)
    setQuery('')
  }, [initialMode])

  const loadModules = useCallback(async () => {
    try {
      const result = await memoryService.listModules()
      setModules(result.items)
      setSelectedModuleId((current) => current ?? result.items[0]?.module_id)
      setServiceError('')
    } catch {
      setServiceError('Memory 服务未运行，请确认 Memory 模块已启动')
    }
  }, [])

  const loadStats = useCallback(async () => {
    try {
      const result = await memoryService.getStats(selectedModuleId)
      setStats(result)
    } catch {
      setStats(null)
    }
  }, [selectedModuleId])

  const loadShortTerm = useCallback(async (queryInput?: string) => {
    setListLoading(true)
    try {
      const result = await memoryService.searchShortTerm({
        q: queryInput?.trim() || undefined,
        limit: 50,
        moduleId: selectedModuleId,
        friendId: contextFilters.friendId,
        accessibleScopes: contextFilters.accessibleScopes,
      })
      setShortTermEntries(result.results)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加载短期记忆失败')
    } finally {
      setListLoading(false)
    }
  }, [contextFilters.accessibleScopes, contextFilters.friendId, selectedModuleId, toast])

  const loadLongTerm = useCallback(async (input: { query?: string; mode: TaskMode }) => {
    setListLoading(true)
    try {
      if (input.mode !== 'search') {
        const result = await memoryService.browseLongTerm({
          limit: 50,
          moduleId: selectedModuleId,
          friendId: contextFilters.friendId,
          accessibleScopes: contextFilters.accessibleScopes,
        })
        setLongTermEntries(result.results)
        return
      }

      const result = await memoryService.searchLongTerm({
        q: input.query?.trim() || undefined,
        limit: 50,
        moduleId: selectedModuleId,
        friendId: contextFilters.friendId,
        accessibleScopes: contextFilters.accessibleScopes,
      })
      setLongTermEntries(result.results.map((entry) => entry.memory))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加载长期记忆失败')
    } finally {
      setListLoading(false)
    }
  }, [contextFilters.accessibleScopes, contextFilters.friendId, selectedModuleId, toast])

  const loadCurrentEntries = useCallback(async (queryInput?: string) => {
    if (tab === 'short') {
      await loadShortTerm(mode === 'search' ? queryInput : undefined)
      return
    }
    await loadLongTerm({
      query: mode === 'search' ? queryInput : undefined,
      mode,
    })
  }, [loadLongTerm, loadShortTerm, mode, tab])

  useEffect(() => {
    const init = async () => {
      setLoading(true)
      await loadModules()
      setLoading(false)
    }
    init()
  }, [loadModules])

  useEffect(() => {
    if (serviceError || modules.length === 0) {
      return
    }

    loadStats()

    if (mode === 'search') {
      if (tab === 'short') {
        setShortTermEntries([])
      } else {
        setLongTermEntries([])
      }
      return
    }

    loadCurrentEntries()
  }, [loadCurrentEntries, loadStats, mode, modules.length, serviceError, tab, contextFilters.friendId, contextFilters.accessibleScopes])

  useEffect(() => {
    setExpandedId(null)
    setLongTermDetailLevels(new Map())
  }, [tab, mode, contextFilters.friendId, contextFilters.accessibleScopes])

  useEffect(() => {
    if (!contextFilters.memoryId || tab !== 'long' || mode !== 'search') {
      return
    }
    setQuery(contextFilters.memoryId)
    loadCurrentEntries(contextFilters.memoryId)
  }, [contextFilters.memoryId, loadCurrentEntries, mode, tab])

  useEffect(() => {
    if (tab !== 'long' || longTermEntries.length === 0) {
      setRelatedSceneProfiles({})
      return
    }

    let cancelled = false
    const entryIds = longTermEntries.map((entry) => entry.id)
    const missingIds = entryIds.filter((id) => relatedSceneProfiles[id] === undefined)

    if (missingIds.length === 0) {
      return
    }

    const loadRelatedSceneProfiles = async () => {
      try {
        const pairs = await Promise.all(
          missingIds.map(async (id) => {
            const result = await memoryService.getRelatedSceneProfiles(id, selectedModuleId)
            return [id, result.profiles] as const
          }),
        )
        if (!cancelled) {
          setRelatedSceneProfiles((prev) => ({
            ...prev,
            ...Object.fromEntries(pairs),
          }))
        }
      } catch (err) {
        if (!cancelled) {
          toast.error(err instanceof Error ? err.message : '加载关联场景画像失败')
        }
      }
    }

    loadRelatedSceneProfiles()
    return () => {
      cancelled = true
    }
  }, [longTermEntries, relatedSceneProfiles, selectedModuleId, tab, toast])

  useEffect(() => {
    const style = document.createElement('style')
    style.textContent = `
      .memory-markdown pre {
        background: rgba(0,0,0,0.2);
        padding: 0.75rem;
        border-radius: 6px;
        overflow-x: auto;
        margin: 0.5rem 0;
      }
      .memory-markdown code {
        padding: 0.1rem 0.3rem;
        background: rgba(0,0,0,0.15);
        border-radius: 3px;
        font-size: 0.85em;
      }
      .memory-markdown pre code {
        padding: 0;
        background: none;
      }
      .memory-markdown p { margin: 0.4rem 0; }
      .memory-markdown ul, .memory-markdown ol { margin: 0.4rem 0; padding-left: 1.5rem; }
      .memory-markdown h1, .memory-markdown h2, .memory-markdown h3 { margin: 0.5rem 0 0.25rem; }
    `
    document.head.appendChild(style)
    return () => { document.head.removeChild(style) }
  }, [])

  const handleTabChange = (nextTab: TabType) => {
    setTab(nextTab)
    setQuery('')
  }

  const handleModeChange = (nextMode: TaskMode) => {
    setMode(nextMode)
    setQuery('')
  }

  const handleSearch = () => {
    if (mode !== 'search') {
      loadCurrentEntries()
      return
    }
    loadCurrentEntries(query)
  }

  const handleClear = () => {
    setQuery('')
    if (mode === 'search') {
      if (tab === 'short') {
        setShortTermEntries([])
      } else {
        setLongTermEntries([])
      }
      return
    }
    loadCurrentEntries()
  }

  const handleRequestDelete = (id: string) => {
    setConfirmDeleteId(id)
  }

  const handleDeleteConfirmed = async (id: string) => {
    setDeletingId(id)
    try {
      await memoryService.deleteMemory(id, selectedModuleId)
      toast.success('记忆已删除')
      setConfirmDeleteId(null)
      if (tab === 'short') {
        setShortTermEntries((prev) => prev.filter((entry) => entry.id !== id))
      } else {
        setLongTermEntries((prev) => prev.filter((entry) => entry.id !== id))
      }
      loadStats()
      setRelatedSceneProfiles((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    } finally {
      setDeletingId(null)
    }
  }

  const handleToggleLongTermDetail = (id: string) => {
    setLongTermDetailLevels((prev) => {
      const next = new Map(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.set(id, 'L1')
      }
      return next
    })
  }

  const handleShowL2 = async (id: string) => {
    setL2Loading(id)
    try {
      const result = await memoryService.getMemory(id, selectedModuleId)
      if (result.type === 'long') {
        setLongTermEntries((prev) => prev.map((entry) => (
          entry.id === id ? { ...entry, ...result.memory } : entry
        )))
        setLongTermDetailLevels((prev) => {
          const next = new Map(prev)
          next.set(id, 'L2')
          return next
        })
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加载全文失败')
    } finally {
      setL2Loading(null)
    }
  }

  if (loading) {
    return <MainLayout><Loading /></MainLayout>
  }

  const currentResultCount = tab === 'short' ? shortTermEntries.length : longTermEntries.length

  return (
    <MainLayout>
      <div style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 700, marginBottom: '0.5rem' }}>记忆条目</h1>
        <p style={{ color: 'var(--text-secondary)' }}>
          按浏览、搜索或上下文模式查看 Memory 模块中的短期与长期记忆。
        </p>
      </div>

      {serviceError && (
        <Card>
          <div style={{ color: 'var(--danger)', textAlign: 'center', padding: '2rem' }}>
            <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>⚠️</div>
            <div>{serviceError}</div>
          </div>
        </Card>
      )}

      {!serviceError && (
        <>
          {modules.length > 1 && (
            <div style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <span style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>选择 Memory 模块：</span>
              <select
                value={selectedModuleId ?? ''}
                onChange={(event) => setSelectedModuleId(event.target.value)}
                style={{
                  padding: '0.4rem 0.8rem',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border)',
                  borderRadius: '6px',
                  color: 'var(--text-primary)',
                }}
              >
                {modules.map((module) => (
                  <option key={module.module_id} value={module.module_id}>{module.module_id}</option>
                ))}
              </select>
            </div>
          )}

          {stats && (
            <>
              <div style={{ fontWeight: 600, marginBottom: '0.75rem' }}>全局统计</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
                <Card>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '2.5rem', fontWeight: 700, color: 'var(--primary)' }}>
                      {stats.short_term.entry_count}
                    </div>
                    <div style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>短期记忆</div>
                    {stats.short_term.latest_entry_at && (
                      <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginTop: '0.25rem' }}>
                        最新：{new Date(stats.short_term.latest_entry_at).toLocaleString('zh-CN')}
                      </div>
                    )}
                  </div>
                </Card>
                <Card>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '2.5rem', fontWeight: 700, color: '#8b5cf6' }}>
                      {stats.long_term.entry_count}
                    </div>
                    <div style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>长期记忆</div>
                    {stats.long_term.latest_entry_at && (
                      <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginTop: '0.25rem' }}>
                        最新：{new Date(stats.long_term.latest_entry_at).toLocaleString('zh-CN')}
                      </div>
                    )}
                  </div>
                </Card>
              </div>
            </>
          )}

          <Card>
            <div style={{ display: 'grid', gap: '0.75rem' }}>
              <div style={{ fontWeight: 600 }}>当前视图</div>
              <div>模式：{MODE_LABELS[mode]}</div>
              <div>结果数：{currentResultCount}</div>
              <div>类型：{tab === 'short' ? '短期记忆' : '长期记忆'}</div>
              {contextFilters.contextLabel && <div>上下文：{contextFilters.contextLabel}</div>}
              {contextFilters.friendId && <div>friend_id：{contextFilters.friendId}</div>}
              {contextFilters.accessibleScopes.length > 0 && (
                <div>scopes：{contextFilters.accessibleScopes.join('、')}</div>
              )}
              {hasContextFilter && (
                <div>
                  <Button variant="secondary" onClick={() => navigate('/memory/entries')}>
                    清除上下文过滤
                  </Button>
                </div>
              )}
            </div>
          </Card>

          <Card>
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
              <Button
                variant={tab === 'short' ? 'primary' : 'secondary'}
                onClick={() => handleTabChange('short')}
              >
                短期记忆
              </Button>
              <Button
                variant={tab === 'long' ? 'primary' : 'secondary'}
                onClick={() => handleTabChange('long')}
              >
                长期记忆
              </Button>
            </div>

            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
              <Button
                variant={mode === 'browse' ? 'primary' : 'secondary'}
                onClick={() => handleModeChange('browse')}
              >
                浏览最近
              </Button>
              <Button
                variant={mode === 'search' ? 'primary' : 'secondary'}
                onClick={() => handleModeChange('search')}
              >
                语义搜索
              </Button>
              <Button
                variant={mode === 'context' ? 'primary' : 'secondary'}
                onClick={() => handleModeChange('context')}
              >
                按上下文查看
              </Button>
            </div>

            {mode === 'search' && (
              <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.5rem' }}>
                <input
                  type="text"
                  placeholder={tab === 'short' ? '搜索短期记忆内容...' : '搜索长期记忆...'}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => event.key === 'Enter' && handleSearch()}
                  style={{
                    flex: 1,
                    padding: '0.5rem 1rem',
                    background: 'var(--bg-secondary)',
                    border: '1px solid var(--border)',
                    borderRadius: '6px',
                    color: 'var(--text-primary)',
                    fontSize: '0.9rem',
                  }}
                />
                <Button onClick={handleSearch}>搜索</Button>
                <Button variant="secondary" onClick={handleClear}>清除</Button>
              </div>
            )}

            {listLoading && <Loading />}

            {!listLoading && tab === 'short' && (
              <ShortTermList
                entries={shortTermEntries}
                expandedId={expandedId}
                onToggleExpand={(id) => setExpandedId((prev) => prev === id ? null : id)}
                onDelete={handleRequestDelete}
                deletingId={deletingId}
              />
            )}

            {!listLoading && tab === 'long' && (
              <LongTermList
                entries={longTermEntries}
                detailLevels={longTermDetailLevels}
                onToggleDetail={handleToggleLongTermDetail}
                onShowL2={handleShowL2}
                l2Loading={l2Loading}
                onDelete={handleRequestDelete}
                deletingId={deletingId}
                relatedSceneProfiles={relatedSceneProfiles}
              />
            )}
          </Card>
        </>
      )}

      <ConfirmModal
        open={Boolean(confirmDeleteId)}
        title="删除记忆条目"
        message="此操作不可撤销。该记忆条目将被永久删除。"
        confirmText="删除"
        confirmVariant="danger"
        loading={deletingId !== null}
        onConfirm={() => confirmDeleteId && handleDeleteConfirmed(confirmDeleteId)}
        onCancel={() => setConfirmDeleteId(null)}
      />
    </MainLayout>
  )
}

interface ShortTermListProps {
  entries: ShortTermMemoryEntry[]
  expandedId: string | null
  onToggleExpand: (id: string) => void
  onDelete: (id: string) => void
  deletingId: string | null
}

const ShortTermList: React.FC<ShortTermListProps> = ({
  entries, expandedId, onToggleExpand, onDelete, deletingId,
}) => {
  if (entries.length === 0) {
    return <div style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem' }}>暂无短期记忆</div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {entries.map((entry) => (
        <div key={entry.id} style={{
          border: '1px solid var(--border)',
          borderRadius: '8px',
          overflow: 'hidden',
        }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: '1rem',
              padding: '0.75rem 1rem',
              cursor: 'pointer',
              background: expandedId === entry.id ? 'rgba(59, 130, 246, 0.05)' : 'transparent',
            }}
            onClick={() => onToggleExpand(entry.id)}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: '0.75rem',
                color: 'var(--text-secondary)',
                marginBottom: '0.25rem',
                display: 'flex',
                gap: '0.75rem',
              }}>
                <span style={{ fontFamily: 'monospace', opacity: 0.6 }}>{entry.id}</span>
                <span>{new Date(entry.event_time).toLocaleString('zh-CN')}</span>
                {entry.topic && <span style={{ color: 'var(--primary)' }}>{entry.topic}</span>}
              </div>
              <div style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: expandedId === entry.id ? 'normal' : 'nowrap',
                fontSize: '0.95rem',
              }}>
                {entry.content}
              </div>
            </div>
            <Button
              variant="danger"
              onClick={(event) => { event.stopPropagation(); onDelete(entry.id) }}
              disabled={deletingId === entry.id}
              style={{ flexShrink: 0, padding: '0.25rem 0.75rem', fontSize: '0.8rem' }}
            >
              {deletingId === entry.id ? '删除中...' : '删除'}
            </Button>
          </div>

          {expandedId === entry.id && (
            <div style={{
              borderTop: '1px solid var(--border)',
              padding: '0.75rem 1rem',
              background: 'var(--bg-secondary)',
              fontSize: '0.85rem',
            }}>
              {entry.keywords.length > 0 && (
                <div style={{ marginBottom: '0.5rem' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>关键词：</span>
                  {entry.keywords.map((keyword) => (
                    <span key={keyword} style={{
                      display: 'inline-block',
                      margin: '0 0.25rem',
                      padding: '0.1rem 0.4rem',
                      background: 'rgba(59, 130, 246, 0.1)',
                      borderRadius: '4px',
                      fontSize: '0.8rem',
                      color: 'var(--primary)',
                    }}>{keyword}</span>
                  ))}
                </div>
              )}
              {entry.persons.length > 0 && (
                <div style={{ marginBottom: '0.5rem' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>人物：</span>
                  {entry.persons.join('、')}
                </div>
              )}
              {entry.entities.length > 0 && (
                <div style={{ marginBottom: '0.5rem' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>实体：</span>
                  {entry.entities.join('、')}
                </div>
              )}
              <div style={{ color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
                来源：{entry.source.type}
                {entry.source.channel_id && ` · ${entry.source.channel_id}`}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

interface LongTermListProps {
  entries: LongTermMemoryEntry[]
  detailLevels: Map<string, DetailLevel>
  onToggleDetail: (id: string) => void
  onShowL2: (id: string) => void
  l2Loading: string | null
  onDelete: (id: string) => void
  deletingId: string | null
  relatedSceneProfiles: Record<string, SceneProfile[]>
}

const LongTermList: React.FC<LongTermListProps> = ({
  entries, detailLevels, onToggleDetail, onShowL2, l2Loading, onDelete, deletingId, relatedSceneProfiles,
}) => {
  if (entries.length === 0) {
    return <div style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem' }}>暂无长期记忆</div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {entries.map((entry) => {
        const level = detailLevels.get(entry.id) ?? 'L0'
        const isExpanded = level !== 'L0'

        return (
          <div key={entry.id} style={{
            border: '1px solid var(--border)',
            borderRadius: '8px',
            overflow: 'hidden',
          }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '1rem',
                padding: '0.75rem 1rem',
                cursor: 'pointer',
                background: isExpanded ? 'rgba(139, 92, 246, 0.05)' : 'transparent',
              }}
              onClick={() => onToggleDetail(entry.id)}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', marginBottom: '0.375rem', flexWrap: 'wrap' }}>
                  {entry.tags.map((tag) => (
                    <span key={tag} style={{
                      padding: '0.1rem 0.4rem',
                      background: 'rgba(139, 92, 246, 0.1)',
                      borderRadius: '4px',
                      color: '#8b5cf6',
                      fontSize: '0.75rem',
                    }}>{tag}</span>
                  ))}
                  <span style={{ marginLeft: 'auto', fontSize: '0.8rem', color: 'var(--text-secondary)', flexShrink: 0 }}>
                    ⭐ {entry.importance}
                  </span>
                </div>
                <div style={{ fontWeight: 500, marginBottom: '0.25rem' }}>{entry.abstract}</div>
                <div style={{ display: 'flex', gap: '0.75rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  <span style={{ fontFamily: 'monospace', opacity: 0.6 }}>{entry.id.slice(0, 14)}</span>
                  <span>{new Date(entry.created_at).toLocaleString('zh-CN')}</span>
                  <span style={{ color: '#4ade80' }}>L0 摘要</span>
                </div>
              </div>
              <Button
                variant="danger"
                onClick={(event) => { event.stopPropagation(); onDelete(entry.id) }}
                disabled={deletingId === entry.id}
                style={{ flexShrink: 0, padding: '0.25rem 0.75rem', fontSize: '0.8rem' }}
              >
                {deletingId === entry.id ? '删除中...' : '删除'}
              </Button>
            </div>

            {isExpanded && (
              <div style={{
                borderTop: '1px solid var(--border)',
                padding: '0.75rem 1rem',
                background: 'var(--bg-secondary)',
                fontSize: '0.85rem',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                  <span style={{ color: '#4ade80', fontSize: '0.75rem', fontWeight: 600 }}>L1 概览</span>
                  {level === 'L1' && (
                    <button
                      onClick={(event) => { event.stopPropagation(); onShowL2(entry.id) }}
                      disabled={l2Loading === entry.id}
                      style={{
                        marginLeft: 'auto',
                        padding: '0.15rem 0.6rem',
                        background: 'rgba(139, 92, 246, 0.15)',
                        border: '1px solid rgba(139, 92, 246, 0.3)',
                        borderRadius: '4px',
                        color: '#8b5cf6',
                        fontSize: '0.75rem',
                        cursor: l2Loading === entry.id ? 'wait' : 'pointer',
                        opacity: l2Loading === entry.id ? 0.6 : 1,
                      }}
                    >
                      {l2Loading === entry.id ? '加载中...' : '展开全文 (L2)'}
                    </button>
                  )}
                </div>
                <div className="memory-markdown" style={{ marginBottom: '0.75rem', lineHeight: 1.7 }}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.overview}</ReactMarkdown>
                </div>
                {entry.keywords.length > 0 && (
                  <div style={{ marginBottom: '0.5rem', fontSize: '0.8rem' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>关键词：</span>
                    {entry.keywords.map((keyword, index) => (
                      <span key={keyword}>
                        <span style={{ color: '#60a5fa' }}>{keyword}</span>
                        {index < entry.keywords.length - 1 && <span style={{ color: 'var(--text-secondary)' }}> · </span>}
                      </span>
                    ))}
                  </div>
                )}
                {entry.entities.length > 0 && (
                  <div style={{ marginBottom: '0.5rem', fontSize: '0.8rem' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>实体：</span>
                    {entry.entities.map((entity) => `${entity.name}(${entity.type})`).join('、')}
                  </div>
                )}
                {relatedSceneProfiles[entry.id]?.length ? (
                  <div style={{ marginTop: '0.5rem', fontSize: '0.8rem' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>被引用于：</span>
                    {relatedSceneProfiles[entry.id].map((profile, index) => {
                      const sceneKey = sceneToKey(profile.scene)
                      return (
                        <React.Fragment key={sceneKey}>
                          {index > 0 && <span style={{ color: 'var(--text-secondary)' }}> · </span>}
                          <a
                            href={`/memory/scenes/${encodeURIComponent(sceneKey)}`}
                            onClick={(event) => event.stopPropagation()}
                            style={{ color: 'var(--primary)' }}
                          >
                            {profile.label || sceneKey}
                          </a>
                        </React.Fragment>
                      )
                    })}
                  </div>
                ) : null}
                <div style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
                  {entry.version !== undefined && `v${entry.version} · `}
                  {entry.source.type}
                  {entry.source.channel_id && ` · ${entry.source.channel_id}`}
                  {' · '}
                  {new Date(entry.updated_at ?? entry.created_at).toLocaleString('zh-CN')}
                </div>
              </div>
            )}

            {level === 'L2' && (
              <div style={{
                borderTop: '1px solid var(--border)',
                padding: '0.75rem 1rem',
                background: 'var(--bg-secondary)',
                fontSize: '0.85rem',
                opacity: 0.9,
              }}>
                <div style={{ color: '#4ade80', fontSize: '0.75rem', fontWeight: 600, marginBottom: '0.5rem' }}>L2 全文</div>
                <div className="memory-markdown" style={{ lineHeight: 1.7 }}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.content}</ReactMarkdown>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
