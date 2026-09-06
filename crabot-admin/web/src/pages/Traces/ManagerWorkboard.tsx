import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Loading } from '../../components/Common/Loading'
import { MainLayout } from '../../components/Layout/MainLayout'
import { useToast } from '../../contexts/ToastContext'
import {
  agentObservabilityService,
  type ArchivedWorkboardItem,
  type ChangeWorkboardMutation,
  type ChangeWorkboardResult,
  type ManagerAdminSummary,
  type ManagerWorkboardResult,
  type WorkboardArchiveOutcome,
  type WorkboardItem,
  type WorkboardItemDraft,
  type WorkboardItemStatus,
} from '../../services/agent-observability'
import './ManagerWorkboard.css'

type WorkboardView = 'active' | 'archive'

type Editor =
  | { mode: 'create'; draft: WorkboardItemDraft }
  | { mode: 'revise'; currentTitle: string; draft: WorkboardItemDraft }
  | { mode: 'archive'; currentTitle: string }

const STATUS_LABEL: Record<WorkboardItemStatus, string> = {
  ready: '待开始',
  in_progress: '进行中',
  blocked: '已阻塞',
}

const ARCHIVE_LABEL: Record<WorkboardArchiveOutcome, string> = {
  completed: '已完成',
  abandoned: '已废弃',
}

const STATUS_ORDER: Record<WorkboardItemStatus, number> = {
  ready: 0,
  in_progress: 1,
  blocked: 2,
}

function emptyDraft(): WorkboardItemDraft {
  return {
    title: '', status: 'ready', objective: '', acceptance: [], current_state: '', next_action: '', blockers: [],
  }
}

function draftOf(item: WorkboardItem): WorkboardItemDraft {
  return {
    title: item.title,
    status: item.status,
    ...(item.project_root ? { project_root: item.project_root } : {}),
    objective: item.objective,
    acceptance: item.acceptance,
    current_state: item.current_state,
    next_action: item.next_action,
    blockers: item.blockers,
  }
}

function splitLines(value: string): string[] {
  return value.split('\n').map((line) => line.trim()).filter(Boolean)
}

function withProjectRoot(draft: WorkboardItemDraft, projectRoot: string): WorkboardItemDraft {
  if (projectRoot) return { ...draft, project_root: projectRoot }
  const { project_root: _projectRoot, ...withoutProjectRoot } = draft
  return withoutProjectRoot
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

function isArchived(item: WorkboardItem | ArchivedWorkboardItem): item is ArchivedWorkboardItem {
  return 'archived_as' in item
}

function applyMutation(
  board: ManagerWorkboardResult,
  mutation: ChangeWorkboardMutation,
  result: ChangeWorkboardResult,
): ManagerWorkboardResult {
  if (board.view !== 'active') return { ...board, revision: result.revision, active_count: result.active_count, archive_count: result.archive_count }
  const item = result.item
  const activeItems = (() => {
    if (mutation.action === 'archive') return board.items.filter((current) => current.title !== mutation.current_title)
    if (isArchived(item)) return board.items
    const without = mutation.action === 'revise'
      ? board.items.filter((current) => current.title !== mutation.current_title)
      : board.items
    return [...without, item].sort((left, right) => STATUS_ORDER[left.status] - STATUS_ORDER[right.status] || left.title.localeCompare(right.title))
  })()
  return {
    ...board,
    revision: result.revision,
    items: activeItems,
    active_count: result.active_count,
    archive_count: result.archive_count,
    pagination: {
      ...board.pagination,
      total_items: result.active_count,
      total_pages: Math.max(1, Math.ceil(result.active_count / board.pagination.page_size)),
    },
  }
}

function WorkboardItemCard({ item, onEdit, onArchive }: {
  item: WorkboardItem
  onEdit: () => void
  onArchive: () => void
}) {
  return (
    <article className={`manager-workboard__item manager-workboard__item--${item.status}`}>
      <header>
        <h3>{item.title}</h3>
        <span className={`manager-workboard__status manager-workboard__status--${item.status}`}>{STATUS_LABEL[item.status]}</span>
      </header>
      <dl>
        <div><dt>目标</dt><dd>{item.objective}</dd></div>
        <div><dt>验收</dt><dd>{item.acceptance.map((line) => <span key={line}>{line}</span>)}</dd></div>
        <div><dt>当前</dt><dd>{item.current_state}</dd></div>
        <div><dt>下一步</dt><dd>{item.next_action}</dd></div>
        {item.blockers.length > 0 && <div className="manager-workboard__blockers"><dt>阻塞</dt><dd>{item.blockers.map((line) => <span key={line}>{line}</span>)}</dd></div>}
      </dl>
      <footer>
        <time title={new Date(item.updated_at).toLocaleString('zh-CN')}>更新于 {formatTime(item.updated_at)}</time>
        <div>
          <button type="button" onClick={onEdit}>编辑</button>
          <button type="button" className="manager-workboard__archive-action" onClick={onArchive}>归档</button>
        </div>
      </footer>
    </article>
  )
}

function EditorDialog({ editor, busy, onClose, onSubmit }: {
  editor: Editor
  busy: boolean
  onClose: () => void
  onSubmit: (mutation: ChangeWorkboardMutation) => void
}) {
  const [draft, setDraft] = useState<WorkboardItemDraft>(() => editor.mode === 'archive' ? emptyDraft() : editor.draft)
  const isArchive = editor.mode === 'archive'

  const submitDraft = (event: React.FormEvent): void => {
    event.preventDefault()
    const normalized: WorkboardItemDraft = {
      ...draft,
      title: draft.title.trim(),
      objective: draft.objective.trim(),
      acceptance: draft.acceptance.map((line) => line.trim()).filter(Boolean),
      current_state: draft.current_state.trim(),
      next_action: draft.next_action.trim(),
      blockers: draft.blockers.map((line) => line.trim()).filter(Boolean),
      ...(draft.project_root?.trim() ? { project_root: draft.project_root.trim() } : {}),
    }
    onSubmit(editor.mode === 'create'
      ? { action: 'create', item: normalized }
      : { action: 'revise', current_title: editor.currentTitle, item: normalized })
  }

  return (
    <div className="manager-workboard__overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
      <section className="manager-workboard__dialog" role="dialog" aria-modal="true" aria-label={isArchive ? '归档事项' : editor.mode === 'create' ? '新建事项' : '编辑事项'}>
        {isArchive ? (
          <>
            <header><h2>归档事项</h2><button type="button" aria-label="关闭" onClick={onClose} disabled={busy}>关闭</button></header>
            <p>“{editor.currentTitle}”将从当前任务板移入 archive。</p>
            <div className="manager-workboard__dialog-actions">
              <button type="button" onClick={onClose} disabled={busy}>取消</button>
              <button type="button" onClick={() => onSubmit({ action: 'archive', current_title: editor.currentTitle, archived_as: 'abandoned' })} disabled={busy}>标为已废弃</button>
              <button type="button" className="is-primary" onClick={() => onSubmit({ action: 'archive', current_title: editor.currentTitle, archived_as: 'completed' })} disabled={busy}>标为已完成</button>
            </div>
          </>
        ) : (
          <form onSubmit={submitDraft}>
            <header><h2>{editor.mode === 'create' ? '新建事项' : '编辑事项'}</h2><button type="button" aria-label="关闭" onClick={onClose} disabled={busy}>关闭</button></header>
            <div className="manager-workboard__form-grid">
              <label>标题<input required value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
              <label>状态<select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as WorkboardItemStatus })}>
                <option value="ready">待开始</option><option value="in_progress">进行中</option><option value="blocked">已阻塞</option>
              </select></label>
              <label className="manager-workboard__form-wide">项目根目录（可选）<input value={draft.project_root ?? ''} onChange={(event) => setDraft(withProjectRoot(draft, event.target.value))} /></label>
              <label className="manager-workboard__form-wide">目标<textarea required value={draft.objective} onChange={(event) => setDraft({ ...draft, objective: event.target.value })} /></label>
              <label className="manager-workboard__form-wide">验收（每行一项）<textarea required value={draft.acceptance.join('\n')} onChange={(event) => setDraft({ ...draft, acceptance: splitLines(event.target.value) })} /></label>
              <label className="manager-workboard__form-wide">当前状态<textarea required value={draft.current_state} onChange={(event) => setDraft({ ...draft, current_state: event.target.value })} /></label>
              <label className="manager-workboard__form-wide">下一步<textarea required value={draft.next_action} onChange={(event) => setDraft({ ...draft, next_action: event.target.value })} /></label>
              <label className="manager-workboard__form-wide">阻塞（每行一项）<textarea value={draft.blockers.join('\n')} onChange={(event) => setDraft({ ...draft, blockers: splitLines(event.target.value) })} /></label>
            </div>
            <div className="manager-workboard__dialog-actions"><button type="button" onClick={onClose} disabled={busy}>取消</button><button type="submit" className="is-primary" disabled={busy}>{busy ? '保存中…' : '保存'}</button></div>
          </form>
        )}
      </section>
    </div>
  )
}

const ManagerWorkboardContent: React.FC = () => {
  const { managerKey = '' } = useParams()
  const toast = useToast()
  const [view, setView] = useState<WorkboardView>('active')
  const [board, setBoard] = useState<ManagerWorkboardResult>()
  const [manager, setManager] = useState<ManagerAdminSummary>()
  const [loadError, setLoadError] = useState<string | null>(null)
  const [editor, setEditor] = useState<Editor>()
  const [saving, setSaving] = useState(false)
  const [remoteUpdate, setRemoteUpdate] = useState(false)
  const boardRef = useRef<ManagerWorkboardResult | undefined>(undefined)
  const editorRef = useRef<Editor | undefined>(undefined)

  useEffect(() => { boardRef.current = board }, [board])
  useEffect(() => { editorRef.current = editor }, [editor])

  const loadBoard = useCallback(async (preserveDraft: boolean): Promise<void> => {
    const next = await agentObservabilityService.getManagerWorkboard(managerKey, view)
    const current = boardRef.current
    if (preserveDraft && editorRef.current && current && current.revision !== next.revision) {
      setRemoteUpdate(true)
      return
    }
    if (!current || current.view !== next.view || current.revision !== next.revision) setBoard(next)
    setLoadError(null)
  }, [managerKey, view])

  useEffect(() => {
    let cancelled = false
    agentObservabilityService.listManagers(1, 100)
      .then((result) => { if (!cancelled) setManager(result.items.find((item) => item.manager_key === managerKey)) })
      .catch(() => { if (!cancelled) setManager(undefined) })
    return () => { cancelled = true }
  }, [managerKey])

  useEffect(() => {
    let disposed = false
    let timer: number | undefined
    const poll = async (preserveDraft: boolean): Promise<void> => {
      if (disposed || document.visibilityState !== 'visible') return
      try {
        await loadBoard(preserveDraft)
      } catch (error) {
        if (!disposed) setLoadError(error instanceof Error ? error.message : String(error))
      } finally {
        if (!disposed && document.visibilityState === 'visible') timer = window.setTimeout(() => { void poll(true) }, 5_000)
      }
    }
    const onVisibilityChange = (): void => {
      if (document.visibilityState !== 'visible') return
      if (timer !== undefined) window.clearTimeout(timer)
      void poll(true)
    }
    void poll(false)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      disposed = true
      if (timer !== undefined) window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [loadBoard])

  const save = async (mutation: ChangeWorkboardMutation): Promise<void> => {
    const current = boardRef.current
    if (!current) return
    setSaving(true)
    try {
      const result = await agentObservabilityService.changeManagerWorkboard(managerKey, current.revision, mutation)
      setBoard(applyMutation(current, mutation, result))
      setEditor(undefined)
      setRemoteUpdate(false)
      toast.success('任务板已保存')
    } catch (error) {
      const detail = error as Error & { status?: number }
      if (detail.status === 409) {
        setRemoteUpdate(true)
        try { await loadBoard(false) } catch { /* 保留现有草稿，下一次可见轮询会继续尝试读取。 */ }
        toast.warning('任务板已更新，草稿仍保留，请核对后重新保存。')
      } else {
        toast.error(detail.message || '任务板保存失败')
      }
    } finally {
      setSaving(false)
    }
  }

  const activeItems = !board || board.view !== 'active' ? [] : board.items.filter((item): item is WorkboardItem => !isArchived(item))
  const archiveItems = !board || board.view !== 'archive' ? [] : board.items.filter(isArchived)
  const title = manager?.display_name && manager.display_name !== managerKey ? manager.display_name : '会话任务板'

  return (
    <div className="manager-workboard">
      <header className="manager-workboard__heading">
        <div>
          <Link to="/traces" className="manager-workboard__back">返回会话列表</Link>
          <h1>{title}</h1>
          <div className="manager-workboard__key">会话标识：{managerKey}</div>
        </div>
        <Link className="manager-workboard__detail-link" to={`/traces/managers/${encodeURIComponent(managerKey)}`}>前往会话详情</Link>
      </header>
      <div className="manager-workboard__toolbar">
        <div className="manager-workboard__tabs" role="tablist" aria-label="任务板视图">
          <button type="button" role="tab" aria-selected={view === 'active'} className={view === 'active' ? 'is-active' : ''} onClick={() => { setView('active'); setRemoteUpdate(false) }}>当前事项{board ? `（${board.active_count}）` : ''}</button>
          <button type="button" role="tab" aria-selected={view === 'archive'} className={view === 'archive' ? 'is-active' : ''} onClick={() => { setView('archive'); setRemoteUpdate(false) }}>Archive{board ? `（${board.archive_count}）` : ''}</button>
        </div>
        {view === 'active' && <button type="button" className="manager-workboard__new" onClick={() => setEditor({ mode: 'create', draft: emptyDraft() })}>新建事项</button>}
      </div>
      {remoteUpdate && <div className="manager-workboard__remote-update" role="status">任务板已更新，当前草稿未被覆盖。</div>}
      {!board && !loadError && <Loading />}
      {loadError && !board && <div className="manager-workboard__empty">任务板暂不可用：{loadError}</div>}
      {board && view === 'active' && (
        activeItems.length === 0 ? <div className="manager-workboard__empty">当前没有事项。</div> :
          <div className="manager-workboard__columns" role="tabpanel" aria-label="当前事项">
            {(['ready', 'in_progress', 'blocked'] as const).map((status) => {
              const items = activeItems.filter((item) => item.status === status)
              return <section key={status} className={`manager-workboard__column manager-workboard__column--${status}`}>
                <h2>{STATUS_LABEL[status]}<span>{items.length}</span></h2>
                <div>{items.map((item) => <WorkboardItemCard key={item.title} item={item} onEdit={() => setEditor({ mode: 'revise', currentTitle: item.title, draft: draftOf(item) })} onArchive={() => setEditor({ mode: 'archive', currentTitle: item.title })} />)}</div>
              </section>
            })}
          </div>
      )}
      {board && view === 'archive' && (
        archiveItems.length === 0 ? <div className="manager-workboard__empty">Archive 中没有事项。</div> :
          <div className="manager-workboard__archive" role="tabpanel" aria-label="Archive">
            {archiveItems.map((item) => <article key={`${item.title}-${item.archived_at}`}>
              <header><h2>{item.title}</h2><span className={`manager-workboard__archive-outcome manager-workboard__archive-outcome--${item.archived_as}`}>{ARCHIVE_LABEL[item.archived_as]}</span></header>
              <p>{item.objective}</p><p><strong>最终状态：</strong>{item.current_state}</p><time>归档于 {formatTime(item.archived_at)}</time>
            </article>)}
          </div>
      )}
      {editor && <EditorDialog key={`${editor.mode}-${editor.mode === 'create' ? 'new' : editor.currentTitle}`} editor={editor} busy={saving} onClose={() => setEditor(undefined)} onSubmit={(mutation) => { void save(mutation) }} />}
    </div>
  )
}

export const ManagerWorkboard: React.FC = () => <MainLayout><ManagerWorkboardContent /></MainLayout>
