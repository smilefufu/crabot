import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { Loading } from '../../components/Common/Loading'
import { ConfirmModal } from '../../components/Common/ConfirmModal'
import { useToast } from '../../contexts/ToastContext'
import {
  memoryService,
  type MemoryModule,
  type MemoryStats,
  type ShortTermMemoryEntry,
} from '../../services/memory'
import type { MemoryContextQuery } from './memoryContextQuery'

type TaskMode = 'browse' | 'search' | 'context'

interface ShortTermBrowserProps {
  initialMode?: TaskMode
  initialContext?: MemoryContextQuery
}

const MODE_LABELS: Record<TaskMode, string> = {
  browse: '浏览最近',
  search: '语义搜索',
  context: '按上下文查看',
}

export const ShortTermBrowser: React.FC<ShortTermBrowserProps> = ({
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
    }),
    [initialContext],
  )
  const hasContextFilter = Boolean(
    contextFilters.friendId || contextFilters.accessibleScopes.length > 0,
  )

  const [modules, setModules] = useState<MemoryModule[]>([])
  const [selectedModuleId, setSelectedModuleId] = useState<string | undefined>(undefined)
  const [stats, setStats] = useState<MemoryStats | null>(null)
  const [mode, setMode] = useState<TaskMode>(initialMode)
  const [query, setQuery] = useState('')
  const [shortTermEntries, setShortTermEntries] = useState<ShortTermMemoryEntry[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [listLoading, setListLoading] = useState(false)
  const [serviceError, setServiceError] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

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
      setShortTermEntries([])
      return
    }

    loadShortTerm()
  }, [loadShortTerm, loadStats, mode, modules.length, serviceError, contextFilters.friendId, contextFilters.accessibleScopes])

  useEffect(() => {
    setExpandedId(null)
  }, [mode, contextFilters.friendId, contextFilters.accessibleScopes])

  const handleModeChange = (nextMode: TaskMode) => {
    setMode(nextMode)
    setQuery('')
  }

  const handleSearch = () => {
    if (mode !== 'search') {
      loadShortTerm()
      return
    }
    loadShortTerm(query)
  }

  const handleClear = () => {
    setQuery('')
    if (mode === 'search') {
      setShortTermEntries([])
      return
    }
    loadShortTerm()
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
      setShortTermEntries((prev) => prev.filter((entry) => entry.id !== id))
      loadStats()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    } finally {
      setDeletingId(null)
    }
  }

  if (loading) {
    return <MainLayout><Loading /></MainLayout>
  }

  return (
    <MainLayout>
      <div style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 700, marginBottom: '0.5rem' }}>短期记忆</h1>
        <p style={{ color: 'var(--text-secondary)' }}>
          按浏览、搜索或上下文模式查看 Memory 模块中的短期记忆。
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
            </>
          )}

          <Card>
            <div style={{ display: 'grid', gap: '0.75rem' }}>
              <div style={{ fontWeight: 600 }}>当前视图</div>
              <div>模式：{MODE_LABELS[mode]}</div>
              <div>结果数：{shortTermEntries.length}</div>
              <div>类型：短期记忆</div>
              {contextFilters.contextLabel && <div>上下文：{contextFilters.contextLabel}</div>}
              {contextFilters.friendId && <div>friend_id：{contextFilters.friendId}</div>}
              {contextFilters.accessibleScopes.length > 0 && (
                <div>scopes：{contextFilters.accessibleScopes.join('、')}</div>
              )}
              {hasContextFilter && (
                <div>
                  <Button variant="secondary" onClick={() => navigate('/memory/short-term')}>
                    清除上下文过滤
                  </Button>
                </div>
              )}
            </div>
          </Card>

          <Card>
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
                  placeholder="搜索短期记忆内容..."
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

            {!listLoading && (
              <ShortTermList
                entries={shortTermEntries}
                expandedId={expandedId}
                onToggleExpand={(id) => setExpandedId((prev) => prev === id ? null : id)}
                onDelete={handleRequestDelete}
                deletingId={deletingId}
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
