import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { MainLayout } from '../../../components/Layout/MainLayout'
import { useToast } from '../../../contexts/ToastContext'
import {
  memoryV2Service,
  type MemoryType, type MemoryStatus, type MemoryEntryV2,
  type EvolutionMode, type CreateEntryParams,
} from '../../../services/memoryV2'
import { TypeChips } from './components/TypeChips'
import { StatusChips } from './components/StatusChips'
import { EvolutionModeBadge } from './components/EvolutionModeBadge'
import { EvolutionModeModal } from './components/EvolutionModeModal'
import { EntryListTable, type SortState } from './components/EntryListTable'
import { EntryDetailPanel } from './components/EntryDetailPanel'
import { MemoryDrawer } from './components/MemoryDrawer'
import { MemoryEntryForm } from './components/MemoryEntryForm'
import { ObservationPendingPanel } from './components/ObservationPendingPanel'
import { BatchActionBar } from './components/BatchActionBar'
import { MaintenanceDropdown, type MaintenanceScope } from './components/MaintenanceDropdown'
import { SearchBox, type SearchMode } from './components/SearchBox'
import { DiffReviewModal } from './components/DiffReviewModal'

type TopTab = 'all' | 'observation'
type DrawerState =
  | { kind: 'closed' }
  | { kind: 'view'; entry: MemoryEntryV2 }
  | { kind: 'edit'; entry: MemoryEntryV2 }
  | { kind: 'create' }

function readQuery(search: string) {
  const p = new URLSearchParams(search)
  return {
    tab: (p.get('tab') as TopTab) ?? 'all',
    type: (p.get('type') as MemoryType | null) ?? null,
    status: (p.get('status') as MemoryStatus) ?? 'confirmed',
    q: p.get('q') ?? '',
    mode: (p.get('mode') as SearchMode) ?? 'keyword',
  }
}

export const MemoryV2Page: React.FC = () => {
  const loc = useLocation()
  const nav = useNavigate()
  const toast = useToast()

  const initial = useMemo(() => readQuery(loc.search), [loc.search])
  const [tab, setTab] = useState<TopTab>(initial.tab)
  const [type, setType] = useState<MemoryType | null>(initial.type)
  const [status, setStatus] = useState<MemoryStatus>(initial.status)
  const [query, setQuery] = useState(initial.q)
  const [searchMode, setSearchMode] = useState<SearchMode>(initial.mode)
  const [sort, setSort] = useState<SortState>({ column: 'ingestion_time', direction: 'desc' })

  const [entries, setEntries] = useState<MemoryEntryV2[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [drawer, setDrawer] = useState<DrawerState>({ kind: 'closed' })
  const [loading, setLoading] = useState(false)

  const [mode, setMode] = useState<EvolutionMode>('balanced')
  const [modeModalOpen, setModeModalOpen] = useState(false)

  const [observationCount, setObservationCount] = useState(0)

  const [compareOld, setCompareOld] = useState<{ version: number; body: string } | null>(null)

  useEffect(() => {
    const p = new URLSearchParams(loc.search)
    p.set('tab', tab)
    if (type) p.set('type', type); else p.delete('type')
    p.set('status', status)
    if (query) p.set('q', query); else p.delete('q')
    p.set('mode', searchMode)
    nav({ search: p.toString() }, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, type, status, query, searchMode])

  const refreshEntries = useCallback(async () => {
    if (tab !== 'all') return
    setLoading(true)
    try {
      let r: { items: MemoryEntryV2[] }
      if (query.trim() && searchMode === 'keyword') {
        r = await memoryV2Service.keywordSearch({ query: query.trim(), type: type ?? undefined, status, limit: 100 })
      } else {
        r = await memoryV2Service.listEntries({ type: type ?? undefined, status, limit: 100 })
      }
      const sorted = sortEntries(r.items, sort)
      setEntries(sorted)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [tab, type, status, query, searchMode, sort, toast])

  const refreshMode = useCallback(async () => {
    try { const r = await memoryV2Service.getEvolutionMode(); setMode(r.mode) } catch { /* ignore */ }
  }, [])

  const refreshObservation = useCallback(async () => {
    try { const r = await memoryV2Service.getObservationPending(); setObservationCount(r.items.length) } catch { /* ignore */ }
  }, [])

  useEffect(() => { refreshEntries() }, [refreshEntries])
  useEffect(() => { refreshMode(); refreshObservation() }, [refreshMode, refreshObservation])

  function toggleSelect(id: string) {
    setSelectedIds(prev => {
      if (id === '__all__') return prev.size === entries.length ? new Set() : new Set(entries.map(e => e.id))
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function openDetail(id: string) {
    try {
      const full = await memoryV2Service.getEntry(id, { include: 'full' })
      setDrawer({ kind: 'view', entry: full })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载详情失败')
    }
  }

  async function handleDelete(e: MemoryEntryV2) {
    if (!confirm(`确认删除「${e.brief}」？将进入回收站，30 天内可恢复。`)) return
    await memoryV2Service.deleteEntry(e.id)
    setDrawer({ kind: 'closed' })
    await refreshEntries()
  }

  async function handleRestore(e: MemoryEntryV2) {
    await memoryV2Service.restoreEntry(e.id)
    setDrawer({ kind: 'closed' })
    await refreshEntries()
  }

  async function handleBatchDelete() {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    if (!confirm(`确认批量删除 ${ids.length} 条？`)) return
    for (const id of ids) await memoryV2Service.deleteEntry(id)
    setSelectedIds(new Set())
    await refreshEntries()
    toast.success?.(`已删除 ${ids.length} 条`)
  }

  async function handleMaintenance(scope: MaintenanceScope) {
    try {
      const { ran } = await memoryV2Service.runMaintenance(scope)
      toast.success?.(`维护执行完成：${ran.length > 0 ? ran.join('、') : '无任务执行'}`)
      await Promise.all([refreshEntries(), refreshObservation()])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '维护执行失败')
    }
  }

  async function handleCreate(payload: CreateEntryParams) {
    await memoryV2Service.createEntry(payload)
    await refreshEntries()
    toast.success?.('已创建新记忆')
  }

  async function handleEdit(id: string, patch: { brief?: string; body?: string; tags?: string[] }) {
    await memoryV2Service.patchEntry(id, patch)
    await refreshEntries()
    const full = await memoryV2Service.getEntry(id, { include: 'full' })
    setDrawer({ kind: 'view', entry: full })
    toast.success?.('已保存修改')
  }

  async function handleModeChange(m: EvolutionMode, reason: string) {
    await memoryV2Service.setEvolutionMode(m, reason)
    await refreshMode()
  }

  async function handleCompareVersion(prevVersionRef: string) {
    if (drawer.kind !== 'view') return
    const m = prevVersionRef.match(/^(.+)#v(\d+)$/)
    if (!m) {
      toast.error?.(`无效的版本引用：${prevVersionRef}`)
      return
    }
    const id = m[1]
    const version = parseInt(m[2], 10)
    try {
      const old = await memoryV2Service.getEntryVersion(id, version)
      if ('error' in old) {
        toast.error?.(`旧版本取回失败：${old.error}`)
        return
      }
      setCompareOld({ version, body: old.body ?? '' })
    } catch (e) {
      toast.error?.(e instanceof Error ? e.message : '取回旧版本失败')
    }
  }

  const drawerMeta = (() => {
    switch (drawer.kind) {
      case 'view':   return { title: drawer.entry.brief, eyebrow: '记忆详情' }
      case 'edit':   return { title: drawer.entry.brief || '编辑记忆', eyebrow: '编辑中' }
      case 'create': return { title: '新建记忆', eyebrow: '创建' }
      default:       return { title: '', eyebrow: '' }
    }
  })()

  return (
    <MainLayout>
      <div className="mem-page">
        <header className="mem-page__header">
          <div>
            <div className="mem-page__eyebrow">
              <span>Long-term memory</span>
              <span>·</span>
              <span>{entries.length} entries</span>
            </div>
            <h1 className="mem-page__title">长期记忆</h1>
          </div>
          <div className="mem-page__actions">
            <EvolutionModeBadge mode={mode} onClick={() => setModeModalOpen(true)} />
            <MaintenanceDropdown onRun={handleMaintenance} />
            <button
              type="button"
              className="mem-page__btn-primary"
              onClick={() => setDrawer({ kind: 'create' })}
            >
              + 新建记忆
            </button>
          </div>
        </header>

        <nav className="mem-tabs" aria-label="memory tabs">
          <button
            type="button"
            className={'mem-tab ' + (tab === 'all' ? 'mem-tab--active' : '')}
            onClick={() => setTab('all')}
          >
            <span>全部记忆</span>
            <span className="mem-tab__count">({entries.length})</span>
          </button>
          <button
            type="button"
            className={'mem-tab ' + (tab === 'observation' ? 'mem-tab--active' : '')}
            onClick={() => setTab('observation')}
          >
            <span>观察期</span>
            <span className={'mem-tab__count' + (observationCount > 0 ? ' mem-tab__count--warn' : '')}>({observationCount})</span>
          </button>
        </nav>

        {tab === 'all' ? (
          <>
            <SearchBox value={query} mode={searchMode} onChange={setQuery} onModeChange={setSearchMode} />
            <div className="mem-filters">
              <TypeChips value={type} onChange={setType} />
              <StatusChips value={status} onChange={setStatus} />
            </div>
            <BatchActionBar
              count={selectedIds.size}
              onBatchDelete={handleBatchDelete}
              onBatchEditTags={() => toast.error?.('暂未实现：批量编辑标签')}
              onClear={() => setSelectedIds(new Set())}
            />
            <div className="mem-list-panel">
              {loading
                ? <div className="mem-list-panel__loading">· · · loading · · ·</div>
                : entries.length === 0
                  ? <div className="mem-list-panel__empty">暂无记忆，点右上角「新建记忆」开始录入</div>
                  : <EntryListTable
                      entries={entries}
                      selectedIds={selectedIds}
                      onToggleSelect={toggleSelect}
                      onRowClick={openDetail}
                      sort={sort}
                      onSortChange={setSort}
                      trashMode={status === 'trash'}
                      onTrashRestore={async (id) => {
                        await memoryV2Service.restoreEntry(id)
                        await refreshEntries()
                      }}
                    />}
            </div>
          </>
        ) : (
          <ObservationPendingPanel />
        )}

        <MemoryDrawer
          open={drawer.kind !== 'closed'}
          title={drawerMeta.title}
          eyebrow={drawerMeta.eyebrow}
          onClose={() => setDrawer({ kind: 'closed' })}
          widthPx={drawer.kind === 'view' ? 720 : 760}
        >
          {drawer.kind === 'view' && (
            <EntryDetailPanel
              entry={drawer.entry}
              onEdit={(e) => setDrawer({ kind: 'edit', entry: e })}
              onDelete={handleDelete}
              onRestore={handleRestore}
              onPurge={handleDelete}
              onCompareVersion={handleCompareVersion}
            />
          )}
          {drawer.kind === 'edit' && (
            <MemoryEntryForm
              mode={{ kind: 'edit', entry: drawer.entry }}
              onCancel={() => setDrawer({ kind: 'view', entry: drawer.entry })}
              onSubmitEdit={handleEdit}
            />
          )}
          {drawer.kind === 'create' && (
            <MemoryEntryForm
              mode={{ kind: 'create', defaultType: type ?? 'fact' }}
              onCancel={() => setDrawer({ kind: 'closed' })}
              onSubmitCreate={handleCreate}
            />
          )}
        </MemoryDrawer>

        {modeModalOpen && (
          <EvolutionModeModal open current={mode} onClose={() => setModeModalOpen(false)} onSubmit={handleModeChange} />
        )}

        {compareOld && drawer.kind === 'view' && (() => {
          const currentVersion = drawer.entry.frontmatter?.version
          return (
            <DiffReviewModal
              open
              title={`版本对比：v${compareOld.version} → v${currentVersion ?? '?'}`}
              oldLabel={`v${compareOld.version}`}
              newLabel={`v${currentVersion ?? '?'}（当前）`}
              oldText={compareOld.body}
              newText={drawer.entry.body ?? ''}
              onClose={() => setCompareOld(null)}
            />
          )
        })()}
      </div>
    </MainLayout>
  )
}

function sortEntries(entries: MemoryEntryV2[], sort: SortState): MemoryEntryV2[] {
  const asc = sort.direction === 'asc' ? 1 : -1
  return [...entries].sort((a, b) => {
    if (sort.column === 'ingestion_time') {
      return asc * (a.frontmatter!.ingestion_time.localeCompare(b.frontmatter!.ingestion_time))
    }
    const ca = a.frontmatter!.source_trust * a.frontmatter!.content_confidence
    const cb = b.frontmatter!.source_trust * b.frontmatter!.content_confidence
    return asc * (ca - cb)
  })
}
