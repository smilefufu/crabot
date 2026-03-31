import React, { useState, useEffect, useCallback } from 'react'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { Loading } from '../../components/Common/Loading'
import { useToast } from '../../contexts/ToastContext'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  memoryService,
  type MemoryModule,
  type MemoryStats,
  type ShortTermMemoryEntry,
  type LongTermMemoryEntry,
} from '../../services/memory'

type TabType = 'short' | 'long'
type DetailLevel = 'L0' | 'L1' | 'L2'

export const MemoryBrowser: React.FC = () => {
  const toast = useToast()

  const [modules, setModules] = useState<MemoryModule[]>([])
  const [selectedModuleId, setSelectedModuleId] = useState<string | undefined>(undefined)
  const [stats, setStats] = useState<MemoryStats | null>(null)
  const [tab, setTab] = useState<TabType>('short')
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

  const loadModules = useCallback(async () => {
    try {
      const result = await memoryService.listModules()
      setModules(result.items)
      if (result.items.length > 0 && !selectedModuleId) {
        setSelectedModuleId(result.items[0].module_id)
      }
      setServiceError('')
    } catch (err) {
      setServiceError('Memory 服务未运行，请确认 Memory 模块已启动')
    }
  }, [selectedModuleId])

  const loadStats = useCallback(async () => {
    try {
      const result = await memoryService.getStats(selectedModuleId)
      setStats(result)
    } catch {
      setStats(null)
    }
  }, [selectedModuleId])

  const loadShortTerm = useCallback(async (q?: string) => {
    setListLoading(true)
    try {
      const result = await memoryService.searchShortTerm({
        q: q || undefined,
        limit: 50,
        moduleId: selectedModuleId,
      })
      setShortTermEntries(result.results)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加载短期记忆失败')
    } finally {
      setListLoading(false)
    }
  }, [selectedModuleId, toast])

  const loadLongTerm = useCallback(async (q?: string) => {
    setListLoading(true)
    try {
      const result = await memoryService.searchLongTerm({
        q: q || 'memory',
        limit: 50,
        moduleId: selectedModuleId,
      })
      setLongTermEntries(result.results.map(r => r.memory))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加载长期记忆失败')
    } finally {
      setListLoading(false)
    }
  }, [selectedModuleId, toast])

  useEffect(() => {
    const init = async () => {
      setLoading(true)
      await loadModules()
      setLoading(false)
    }
    init()
  }, [])

  useEffect(() => {
    if (!serviceError && modules.length > 0) {
      loadStats()
      if (tab === 'short') {
        loadShortTerm()
      } else {
        loadLongTerm()
      }
    }
  }, [selectedModuleId, modules, serviceError])

  const handleTabChange = (newTab: TabType) => {
    setTab(newTab)
    setQuery('')
    setExpandedId(null)
    setLongTermDetailLevels(new Map())
    if (newTab === 'short') {
      loadShortTerm()
    } else {
      loadLongTerm()
    }
  }

  const handleSearch = () => {
    if (tab === 'short') {
      loadShortTerm(query)
    } else {
      loadLongTerm(query || 'memory')
    }
  }

  const handleDelete = async (id: string) => {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id)
      toast.info('再次点击删除按钮以确认删除')
      return
    }
    setConfirmDeleteId(null)
    setDeletingId(id)
    try {
      await memoryService.deleteMemory(id, selectedModuleId)
      toast.success('记忆已删除')
      if (tab === 'short') {
        setShortTermEntries(prev => prev.filter(e => e.id !== id))
      } else {
        setLongTermEntries(prev => prev.filter(e => e.id !== id))
      }
      loadStats()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    } finally {
      setDeletingId(null)
    }
  }

  const handleToggleLongTermDetail = (id: string) => {
    setLongTermDetailLevels(prev => {
      const next = new Map(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.set(id, 'L1')
      }
      return next
    })
  }

  const handleShowL2 = (id: string) => {
    setLongTermDetailLevels(prev => {
      const next = new Map(prev)
      next.set(id, 'L2')
      return next
    })
  }

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

  if (loading) return <MainLayout><Loading /></MainLayout>

  return (
    <MainLayout>
      <div style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 700, marginBottom: '0.5rem' }}>记忆管理</h1>
        <p style={{ color: 'var(--text-secondary)' }}>查看和管理 Memory 模块中的短期与长期记忆</p>
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
                onChange={e => setSelectedModuleId(e.target.value)}
                style={{
                  padding: '0.4rem 0.8rem',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border)',
                  borderRadius: '6px',
                  color: 'var(--text-primary)',
                }}
              >
                {modules.map(m => (
                  <option key={m.module_id} value={m.module_id}>{m.module_id}</option>
                ))}
              </select>
            </div>
          )}

          {stats && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1.5rem' }}>
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
          )}

          <Card>
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem' }}>
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

            <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.5rem' }}>
              <input
                type="text"
                placeholder={tab === 'short' ? '搜索短期记忆内容...' : '搜索长期记忆...'}
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSearch()}
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
              <Button
                variant="secondary"
                onClick={() => {
                  setQuery('')
                  if (tab === 'short') loadShortTerm()
                  else loadLongTerm()
                }}
              >
                清除
              </Button>
            </div>

            {listLoading && <Loading />}

            {!listLoading && tab === 'short' && (
              <ShortTermList
                entries={shortTermEntries}
                expandedId={expandedId}
                onToggleExpand={id => setExpandedId(prev => prev === id ? null : id)}
                onDelete={handleDelete}
                deletingId={deletingId}
                confirmDeleteId={confirmDeleteId}
              />
            )}

            {!listLoading && tab === 'long' && (
              <LongTermList
                entries={longTermEntries}
                detailLevels={longTermDetailLevels}
                onToggleDetail={handleToggleLongTermDetail}
                onShowL2={handleShowL2}
                onDelete={handleDelete}
                deletingId={deletingId}
                confirmDeleteId={confirmDeleteId}
              />
            )}
          </Card>
        </>
      )}
    </MainLayout>
  )
}

interface ShortTermListProps {
  entries: ShortTermMemoryEntry[]
  expandedId: string | null
  onToggleExpand: (id: string) => void
  onDelete: (id: string) => void
  deletingId: string | null
  confirmDeleteId: string | null
}

const ShortTermList: React.FC<ShortTermListProps> = ({
  entries, expandedId, onToggleExpand, onDelete, deletingId, confirmDeleteId
}) => {
  if (entries.length === 0) {
    return <div style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem' }}>暂无短期记忆</div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {entries.map(entry => (
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
              onClick={e => { e.stopPropagation(); onDelete(entry.id) }}
              disabled={deletingId === entry.id}
              style={{ flexShrink: 0, padding: '0.25rem 0.75rem', fontSize: '0.8rem' }}
            >
              {confirmDeleteId === entry.id ? '确认删除' : deletingId === entry.id ? '删除中...' : '删除'}
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
                  {entry.keywords.map(k => (
                    <span key={k} style={{
                      display: 'inline-block',
                      margin: '0 0.25rem',
                      padding: '0.1rem 0.4rem',
                      background: 'rgba(59, 130, 246, 0.1)',
                      borderRadius: '4px',
                      fontSize: '0.8rem',
                      color: 'var(--primary)',
                    }}>{k}</span>
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
  onDelete: (id: string) => void
  deletingId: string | null
  confirmDeleteId: string | null
}

const LongTermList: React.FC<LongTermListProps> = ({
  entries, detailLevels, onToggleDetail, onShowL2, onDelete, deletingId, confirmDeleteId
}) => {
  if (entries.length === 0) {
    return <div style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem' }}>暂无长期记忆</div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {entries.map(entry => {
        const level = detailLevels.get(entry.id) ?? 'L0'
        const isExpanded = level !== 'L0'

        return (
          <div key={entry.id} style={{
            border: '1px solid var(--border)',
            borderRadius: '8px',
            overflow: 'hidden',
          }}>
            {/* L0: always visible */}
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
                  {entry.tags.map(t => (
                    <span key={t} style={{
                      padding: '0.1rem 0.4rem',
                      background: 'rgba(139, 92, 246, 0.1)',
                      borderRadius: '4px',
                      color: '#8b5cf6',
                      fontSize: '0.75rem',
                    }}>{t}</span>
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
                onClick={e => { e.stopPropagation(); onDelete(entry.id) }}
                disabled={deletingId === entry.id}
                style={{ flexShrink: 0, padding: '0.25rem 0.75rem', fontSize: '0.8rem' }}
              >
                {confirmDeleteId === entry.id ? '确认删除' : deletingId === entry.id ? '删除中...' : '删除'}
              </Button>
            </div>

            {/* L1: overview section */}
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
                      onClick={e => { e.stopPropagation(); onShowL2(entry.id) }}
                      style={{
                        marginLeft: 'auto',
                        padding: '0.15rem 0.6rem',
                        background: 'rgba(139, 92, 246, 0.15)',
                        border: '1px solid rgba(139, 92, 246, 0.3)',
                        borderRadius: '4px',
                        color: '#8b5cf6',
                        fontSize: '0.75rem',
                        cursor: 'pointer',
                      }}
                    >
                      展开全文 (L2)
                    </button>
                  )}
                </div>
                <div className="memory-markdown" style={{ marginBottom: '0.75rem', lineHeight: 1.7 }}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.overview}</ReactMarkdown>
                </div>
                {entry.keywords.length > 0 && (
                  <div style={{ marginBottom: '0.5rem', fontSize: '0.8rem' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>关键词：</span>
                    {entry.keywords.map((k, i) => (
                      <span key={k}>
                        <span style={{ color: '#60a5fa' }}>{k}</span>
                        {i < entry.keywords.length - 1 && <span style={{ color: 'var(--text-secondary)' }}> · </span>}
                      </span>
                    ))}
                  </div>
                )}
                {entry.entities.length > 0 && (
                  <div style={{ marginBottom: '0.5rem', fontSize: '0.8rem' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>实体：</span>
                    {entry.entities.map(e => `${e.name}(${e.type})`).join('、')}
                  </div>
                )}
                <div style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
                  v{entry.version} · {entry.source.type}
                  {entry.source.channel_id && ` · ${entry.source.channel_id}`}
                  · {new Date(entry.updated_at).toLocaleString('zh-CN')}
                </div>
              </div>
            )}

            {/* L2: full content */}
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
