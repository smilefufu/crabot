import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Loading } from '../../components/Common/Loading'
import { MainLayout } from '../../components/Layout/MainLayout'
import { useToast } from '../../contexts/ToastContext'
import {
  agentObservabilityService,
  type ArchivedWorkboardItem,
  type ArchivedWorkboardObjective,
  type ChangeWorkboardMutation,
  type ChangeWorkboardResult,
  type ManagerAdminSummary,
  type ManagerWorkboardResult,
  type WorkboardArchiveOutcome,
  type WorkboardItem,
  type WorkboardItemDraft,
  type WorkboardItemStatus,
  type WorkboardObjective,
  type WorkboardObjectiveDraft,
} from '../../services/agent-observability'
import './ManagerWorkboard.css'

type WorkboardView = 'active' | 'archive'

type ObjectiveEditor =
  | { kind: 'objective'; mode: 'create'; draft: WorkboardObjectiveDraft }
  | { kind: 'objective'; mode: 'revise'; currentObjectiveTitle: string; draft: WorkboardObjectiveDraft }

type WorkItemEditor =
  | { kind: 'work_item'; mode: 'create'; objectiveTitle: string; draft: WorkboardItemDraft }
  | {
      kind: 'work_item'
      mode: 'revise'
      currentObjectiveTitle: string
      currentWorkItemTitle: string
      targetObjectiveTitle: string
      draft: WorkboardItemDraft
    }

type ArchiveEditor =
  | { kind: 'objective'; mode: 'archive'; currentObjectiveTitle: string }
  | { kind: 'work_item'; mode: 'archive'; currentObjectiveTitle: string; currentWorkItemTitle: string }

type Editor = ObjectiveEditor | WorkItemEditor | ArchiveEditor

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

function emptyObjectiveDraft(): WorkboardObjectiveDraft {
  return { title: '', completion_criteria: [''] }
}

function emptyWorkItemDraft(): WorkboardItemDraft {
  return { title: '', status: 'ready', next_action: '' }
}

function workItemDraftOf(item: WorkboardItem): WorkboardItemDraft {
  return {
    title: item.title,
    status: item.status,
    ...(item.project_root ? { project_root: item.project_root } : {}),
    ...(item.current_judgement ? { current_judgement: item.current_judgement } : {}),
    next_action: item.next_action,
    ...(item.blocker ? { blocker: item.blocker } : {}),
  }
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function sortWorkItems(items: WorkboardItem[]): WorkboardItem[] {
  return [...items].sort((left, right) => (
    STATUS_ORDER[left.status] - STATUS_ORDER[right.status] || compareText(left.title, right.title)
  ))
}

function sortObjectives(objectives: WorkboardObjective[]): WorkboardObjective[] {
  return [...objectives]
    .sort((left, right) => compareText(left.title, right.title))
    .map((objective) => ({ ...objective, work_items: sortWorkItems(objective.work_items) }))
}

function projectLabels(objectives: WorkboardObjective[]): Map<string, string> {
  const roots = [...new Set(objectives.flatMap((objective) => (
    objective.work_items.flatMap((item) => item.project_root ? [item.project_root] : [])
  )))]
  const parts = new Map(roots.map((root) => [root, root.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)]))
  const leafCounts = new Map<string, number>()
  for (const [root, segments] of parts) {
    const leaf = segments.at(-1) || root
    leafCounts.set(leaf, (leafCounts.get(leaf) ?? 0) + 1)
  }
  return new Map(roots.map((root) => {
    const segments = parts.get(root) ?? []
    const leaf = segments.at(-1) || root
    return [root, leafCounts.get(leaf) === 1 ? leaf : segments.slice(-2).join('/') || root]
  }))
}

function isArchivedWorkItem(
  entry: ArchivedWorkboardItem | ArchivedWorkboardObjective,
): entry is ArchivedWorkboardItem {
  return 'objective' in entry
}

function applyMutation(
  board: ManagerWorkboardResult,
  mutation: ChangeWorkboardMutation,
  result: ChangeWorkboardResult,
): ManagerWorkboardResult {
  if (board.view !== 'active') return { ...board, revision: result.revision, counts: result.counts }

  let objectives = board.objectives
  if (mutation.action === 'create_objective' && result.action === 'objective_created') {
    objectives = [...objectives, { ...result.objective, work_items: [] }]
  } else if (mutation.action === 'revise_objective' && result.action === 'objective_revised') {
    objectives = objectives.map((objective) => objective.title === mutation.current_objective_title
      ? { ...result.objective, work_items: objective.work_items }
      : objective)
  } else if (mutation.action === 'archive_objective' && result.action === 'objective_archived') {
    objectives = objectives.filter((objective) => objective.title !== mutation.current_objective_title)
  } else if (mutation.action === 'create_work_item' && result.action === 'work_item_created') {
    objectives = objectives.map((objective) => objective.title === result.objective_title
      ? {
          ...objective,
          updated_at: result.work_item.updated_at,
          work_items: [...objective.work_items, result.work_item],
        }
      : objective)
  } else if (mutation.action === 'revise_work_item' && result.action === 'work_item_revised') {
    objectives = objectives.map((objective) => {
      const withoutCurrent = objective.title === mutation.current_objective_title
        ? objective.work_items.filter((item) => item.title !== mutation.current_work_item_title)
        : objective.work_items
      const workItems = objective.title === result.objective_title
        ? [...withoutCurrent, result.work_item]
        : withoutCurrent
      return workItems !== objective.work_items
        ? { ...objective, updated_at: result.work_item.updated_at, work_items: workItems }
        : objective
    })
  } else if (mutation.action === 'archive_work_item' && result.action === 'work_item_archived') {
    objectives = objectives.map((objective) => objective.title === mutation.current_objective_title
      ? {
          ...objective,
          updated_at: result.work_item.archived_at,
          work_items: objective.work_items.filter((item) => item.title !== mutation.current_work_item_title),
        }
      : objective)
  }

  return {
    ...board,
    revision: result.revision,
    objectives: sortObjectives(objectives),
    counts: result.counts,
    pagination: {
      ...board.pagination,
      total_items: result.counts.current_objectives,
      total_pages: Math.ceil(result.counts.current_objectives / board.pagination.page_size),
    },
  }
}

function WorkboardItemCard({ item, projectLabel, onEdit, onArchive }: {
  item: WorkboardItem
  projectLabel?: string
  onEdit: () => void
  onArchive: () => void
}) {
  return (
    <article className={`manager-workboard__item manager-workboard__item--${item.status}`}>
      <header>
        <h4 title={item.title}>{item.title}</h4>
        <span className={`manager-workboard__status manager-workboard__status--${item.status}`}>{STATUS_LABEL[item.status]}</span>
      </header>
      {item.project_root && <span className="manager-workboard__project" title={item.project_root}>{projectLabel}</span>}
      <dl>
        {item.current_judgement && <div><dt>当前判断</dt><dd title={item.current_judgement}>{item.current_judgement}</dd></div>}
        <div><dt>下一步</dt><dd title={item.next_action}>{item.next_action}</dd></div>
        {item.blocker && <div className="manager-workboard__blocker"><dt>主要阻塞</dt><dd title={item.blocker}>{item.blocker}</dd></div>}
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

function ObjectiveSection({ objective, labels, onEdit, onArchive, onCreateItem, onEditItem, onArchiveItem }: {
  objective: WorkboardObjective
  labels: ReadonlyMap<string, string>
  onEdit: () => void
  onArchive: () => void
  onCreateItem: () => void
  onEditItem: (item: WorkboardItem) => void
  onArchiveItem: (item: WorkboardItem) => void
}) {
  const blocked = objective.work_items.filter((item) => item.status === 'blocked').length
  return (
    <section className="manager-workboard__objective">
      <header className="manager-workboard__objective-heading">
        <div>
          <h2>{objective.title}</h2>
          <div className="manager-workboard__objective-meta">
            {objective.work_items.length} 项{blocked > 0 ? ` · ${blocked} 项阻塞` : ''}
          </div>
        </div>
        <div className="manager-workboard__objective-actions">
          <button type="button" onClick={onCreateItem}>新建事项</button>
          <button type="button" onClick={onEdit}>编辑目标</button>
          <button type="button" onClick={onArchive}>归档目标</button>
        </div>
      </header>
      <div className="manager-workboard__criteria">
        <h3>完成条件</h3>
        <ul>{objective.completion_criteria.map((criterion, index) => <li key={`${index}-${criterion}`}>{criterion}</li>)}</ul>
      </div>
      {objective.work_items.length === 0 ? (
        <div className="manager-workboard__objective-empty">这个目标还没有当前事项。</div>
      ) : (
        <div className="manager-workboard__columns">
          {(['ready', 'in_progress', 'blocked'] as const).map((status) => {
            const items = objective.work_items.filter((item) => item.status === status)
            return (
              <section key={status} className={`manager-workboard__column manager-workboard__column--${status}`}>
                <h3>{STATUS_LABEL[status]}<span>{items.length}</span></h3>
                <div>{items.map((item) => (
                  <WorkboardItemCard
                    key={item.title}
                    item={item}
                    projectLabel={item.project_root ? labels.get(item.project_root) : undefined}
                    onEdit={() => onEditItem(item)}
                    onArchive={() => onArchiveItem(item)}
                  />
                ))}</div>
              </section>
            )
          })}
        </div>
      )}
    </section>
  )
}

function DialogShell({ title, busy, onClose, children }: {
  title: string
  busy: boolean
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div className="manager-workboard__overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
      <section className="manager-workboard__dialog" role="dialog" aria-modal="true" aria-label={title}>
        <header><h2>{title}</h2><button type="button" aria-label="关闭" onClick={onClose} disabled={busy}>关闭</button></header>
        {children}
      </section>
    </div>
  )
}

function ObjectiveEditorDialog({ editor, busy, onClose, onSubmit }: {
  editor: ObjectiveEditor
  busy: boolean
  onClose: () => void
  onSubmit: (mutation: ChangeWorkboardMutation) => void
}) {
  const [draft, setDraft] = useState(editor.draft)
  const title = editor.mode === 'create' ? '新建目标' : '编辑目标'
  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    const objective = {
      title: draft.title.trim(),
      completion_criteria: draft.completion_criteria.map((line) => line.trim()).filter(Boolean),
    }
    onSubmit(editor.mode === 'create'
      ? { action: 'create_objective', objective }
      : { action: 'revise_objective', current_objective_title: editor.currentObjectiveTitle, objective })
  }
  return (
    <DialogShell title={title} busy={busy} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="manager-workboard__form-grid">
          <label className="manager-workboard__form-wide">目标<input required maxLength={200} placeholder="例如：让棉花糖会话能准确回顾已发生事件" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
          <label className="manager-workboard__form-wide">完成条件（每行一项，最多五项）<textarea required placeholder="例如：连续三轮追问时，事件回顾前后一致" value={draft.completion_criteria.join('\n')} onChange={(event) => setDraft({ ...draft, completion_criteria: event.target.value.split('\n') })} /></label>
        </div>
        <DialogActions busy={busy} onClose={onClose} />
      </form>
    </DialogShell>
  )
}

function optionalValue(value: string): string | undefined {
  const normalized = value.trim()
  return normalized || undefined
}

function WorkItemEditorDialog({ editor, objectives, busy, onClose, onSubmit }: {
  editor: WorkItemEditor
  objectives: WorkboardObjective[]
  busy: boolean
  onClose: () => void
  onSubmit: (mutation: ChangeWorkboardMutation) => void
}) {
  const [draft, setDraft] = useState(editor.draft)
  const [targetObjectiveTitle, setTargetObjectiveTitle] = useState(
    editor.mode === 'create' ? editor.objectiveTitle : editor.targetObjectiveTitle,
  )
  const title = editor.mode === 'create' ? '新建事项' : '编辑事项'
  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    const projectRoot = optionalValue(draft.project_root ?? '')
    const currentJudgement = optionalValue(draft.current_judgement ?? '')
    const blocker = draft.status === 'blocked' ? optionalValue(draft.blocker ?? '') : undefined
    const workItem: WorkboardItemDraft = {
      title: draft.title.trim(),
      status: draft.status,
      ...(projectRoot ? { project_root: projectRoot } : {}),
      ...(currentJudgement ? { current_judgement: currentJudgement } : {}),
      next_action: draft.next_action.trim(),
      ...(blocker ? { blocker } : {}),
    }
    onSubmit(editor.mode === 'create'
      ? { action: 'create_work_item', objective_title: editor.objectiveTitle, work_item: workItem }
      : {
          action: 'revise_work_item',
          current_objective_title: editor.currentObjectiveTitle,
          current_work_item_title: editor.currentWorkItemTitle,
          target_objective_title: targetObjectiveTitle,
          work_item: workItem,
        })
  }
  return (
    <DialogShell title={title} busy={busy} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="manager-workboard__form-grid">
          <label>标题<input required maxLength={200} placeholder="例如：核查消息进入模型前的上下文" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
          <label>状态<select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as WorkboardItemStatus })}>
            <option value="ready">待开始</option><option value="in_progress">进行中</option><option value="blocked">已阻塞</option>
          </select></label>
          {editor.mode === 'revise' && <label className="manager-workboard__form-wide">所属目标<select value={targetObjectiveTitle} onChange={(event) => setTargetObjectiveTitle(event.target.value)}>
            {objectives.map((objective) => <option key={objective.title} value={objective.title}>{objective.title}</option>)}
          </select></label>}
          <label className="manager-workboard__form-wide">项目根目录（可选）<input placeholder="例如：/workspace/crabot" value={draft.project_root ?? ''} onChange={(event) => setDraft({ ...draft, project_root: event.target.value })} /></label>
          <label className="manager-workboard__form-wide">当前判断{draft.status === 'ready' ? '（可选）' : ''}<textarea required={draft.status !== 'ready'} placeholder="例如：已确认历史输入存在缺口" value={draft.current_judgement ?? ''} onChange={(event) => setDraft({ ...draft, current_judgement: event.target.value })} /></label>
          <label className="manager-workboard__form-wide">下一步<textarea required placeholder="例如：核对缺口是否影响用户可见结论" value={draft.next_action} onChange={(event) => setDraft({ ...draft, next_action: event.target.value })} /></label>
          {draft.status === 'blocked' && <label className="manager-workboard__form-wide">主要阻塞<textarea required placeholder="例如：需要人类确认是否保留旧行为" value={draft.blocker ?? ''} onChange={(event) => setDraft({ ...draft, blocker: event.target.value })} /></label>}
        </div>
        <DialogActions busy={busy} onClose={onClose} />
      </form>
    </DialogShell>
  )
}

function DialogActions({ busy, onClose }: { busy: boolean; onClose: () => void }) {
  return (
    <div className="manager-workboard__dialog-actions">
      <button type="button" onClick={onClose} disabled={busy}>取消</button>
      <button type="submit" className="is-primary" disabled={busy}>{busy ? '保存中…' : '保存'}</button>
    </div>
  )
}

function ArchiveDialog({ editor, busy, onClose, onSubmit }: {
  editor: ArchiveEditor
  busy: boolean
  onClose: () => void
  onSubmit: (mutation: ChangeWorkboardMutation) => void
}) {
  const isObjective = editor.kind === 'objective'
  const title = isObjective ? '归档目标' : '归档事项'
  const target = isObjective ? editor.currentObjectiveTitle : editor.currentWorkItemTitle
  const archive = (archivedAs: WorkboardArchiveOutcome): void => {
    onSubmit(isObjective
      ? { action: 'archive_objective', current_objective_title: editor.currentObjectiveTitle, archived_as: archivedAs }
      : {
          action: 'archive_work_item',
          current_objective_title: editor.currentObjectiveTitle,
          current_work_item_title: editor.currentWorkItemTitle,
          archived_as: archivedAs,
        })
  }
  return (
    <DialogShell title={title} busy={busy} onClose={onClose}>
      <p>“{target}”将从当前任务板移入归档。</p>
      <div className="manager-workboard__dialog-actions">
        <button type="button" onClick={onClose} disabled={busy}>取消</button>
        <button type="button" onClick={() => archive('abandoned')} disabled={busy}>标为已废弃</button>
        <button type="button" className="is-primary" onClick={() => archive('completed')} disabled={busy}>标为已完成</button>
      </div>
    </DialogShell>
  )
}

function EditorDialog({ editor, objectives, busy, onClose, onSubmit }: {
  editor: Editor
  objectives: WorkboardObjective[]
  busy: boolean
  onClose: () => void
  onSubmit: (mutation: ChangeWorkboardMutation) => void
}) {
  if (editor.mode === 'archive') {
    return <ArchiveDialog editor={editor} busy={busy} onClose={onClose} onSubmit={onSubmit} />
  }
  if (editor.kind === 'objective') {
    return <ObjectiveEditorDialog editor={editor} busy={busy} onClose={onClose} onSubmit={onSubmit} />
  }
  return <WorkItemEditorDialog editor={editor} objectives={objectives} busy={busy} onClose={onClose} onSubmit={onSubmit} />
}

function ArchiveOutcome({ outcome }: { outcome: WorkboardArchiveOutcome }) {
  return <span className={`manager-workboard__archive-outcome manager-workboard__archive-outcome--${outcome}`}>{ARCHIVE_LABEL[outcome]}</span>
}

function ArchivedObjectiveView({ objective }: { objective: ArchivedWorkboardObjective }) {
  return (
    <article>
      <header><h3>{objective.title}</h3><ArchiveOutcome outcome={objective.archived_as} /></header>
      <div className="manager-workboard__archive-criteria"><strong>完成条件</strong><ul>{objective.completion_criteria.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}</ul></div>
      <time>归档于 {formatTime(objective.archived_at)}</time>
    </article>
  )
}

function ArchivedWorkItemView({ item }: { item: ArchivedWorkboardItem }) {
  return (
    <article>
      <header><h3>{item.title}</h3><ArchiveOutcome outcome={item.archived_as} /></header>
      <p><strong>原目标</strong>{item.objective.title}</p>
      <div className="manager-workboard__archive-criteria"><strong>原目标完成条件</strong><ul>{item.objective.completion_criteria.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}</ul></div>
      {item.current_judgement && <p><strong>归档时判断</strong>{item.current_judgement}</p>}
      <p><strong>归档时下一步</strong>{item.next_action}</p>
      <time>归档于 {formatTime(item.archived_at)}</time>
    </article>
  )
}

function editorKey(editor: Editor): string {
  if (editor.kind === 'objective') return `${editor.kind}-${editor.mode}-${editor.mode === 'create' ? 'new' : editor.currentObjectiveTitle}`
  return `${editor.kind}-${editor.mode}-${editor.mode === 'create' ? editor.objectiveTitle : `${editor.currentObjectiveTitle}-${editor.currentWorkItemTitle}`}`
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
  const loadSequenceRef = useRef(0)

  useEffect(() => { boardRef.current = board }, [board])
  useEffect(() => { editorRef.current = editor }, [editor])

  const loadBoard = useCallback(async (preserveDraft: boolean): Promise<void> => {
    const loadSequence = ++loadSequenceRef.current
    const next = await agentObservabilityService.getManagerWorkboard(managerKey, view)
    if (loadSequence !== loadSequenceRef.current) return
    const current = boardRef.current
    if (preserveDraft && editorRef.current && current && current.revision !== next.revision) {
      setRemoteUpdate(true)
      return
    }
    if (!current
      || current.manager_key !== next.manager_key
      || current.view !== next.view
      || current.revision !== next.revision) setBoard(next)
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
      loadSequenceRef.current += 1
      if (timer !== undefined) window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [loadBoard])

  const save = async (mutation: ChangeWorkboardMutation): Promise<void> => {
    const current = boardRef.current
    if (!current) return
    loadSequenceRef.current += 1
    setSaving(true)
    try {
      const result = await agentObservabilityService.changeManagerWorkboard(managerKey, current.revision, mutation)
      loadSequenceRef.current += 1
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

  const objectives = board?.view === 'active' ? board.objectives : []
  const labels = projectLabels(objectives)
  const archiveEntries = board?.view === 'archive' ? board.entries : []
  const archivedObjectives = archiveEntries.filter((entry): entry is ArchivedWorkboardObjective => !isArchivedWorkItem(entry))
  const archivedWorkItems = archiveEntries.filter(isArchivedWorkItem)
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
          <button type="button" role="tab" aria-selected={view === 'active'} className={view === 'active' ? 'is-active' : ''} onClick={() => { setView('active'); setRemoteUpdate(false) }}>当前任务{board ? `（${board.counts.current_objectives} 个目标）` : ''}</button>
          <button type="button" role="tab" aria-selected={view === 'archive'} className={view === 'archive' ? 'is-active' : ''} onClick={() => { setView('archive'); setRemoteUpdate(false) }}>归档{board ? `（${board.counts.archive_entries}）` : ''}</button>
        </div>
        {view === 'active' && <button type="button" className="manager-workboard__new" onClick={() => setEditor({ kind: 'objective', mode: 'create', draft: emptyObjectiveDraft() })}>新建目标</button>}
      </div>
      {remoteUpdate && <div className="manager-workboard__remote-update" role="status">任务板已更新，当前草稿未被覆盖。</div>}
      {!board && !loadError && <Loading />}
      {loadError && !board && <div className="manager-workboard__empty">任务板暂不可用：{loadError}</div>}
      {board && view === 'active' && (
        objectives.length === 0 ? <div className="manager-workboard__empty">当前没有目标。</div> :
          <div className="manager-workboard__objectives" role="tabpanel" aria-label="当前任务">
            {objectives.map((objective) => (
              <ObjectiveSection
                key={objective.title}
                objective={objective}
                labels={labels}
                onEdit={() => setEditor({ kind: 'objective', mode: 'revise', currentObjectiveTitle: objective.title, draft: { title: objective.title, completion_criteria: objective.completion_criteria } })}
                onArchive={() => setEditor({ kind: 'objective', mode: 'archive', currentObjectiveTitle: objective.title })}
                onCreateItem={() => setEditor({ kind: 'work_item', mode: 'create', objectiveTitle: objective.title, draft: emptyWorkItemDraft() })}
                onEditItem={(item) => setEditor({ kind: 'work_item', mode: 'revise', currentObjectiveTitle: objective.title, currentWorkItemTitle: item.title, targetObjectiveTitle: objective.title, draft: workItemDraftOf(item) })}
                onArchiveItem={(item) => setEditor({ kind: 'work_item', mode: 'archive', currentObjectiveTitle: objective.title, currentWorkItemTitle: item.title })}
              />
            ))}
          </div>
      )}
      {board && view === 'archive' && (
        archiveEntries.length === 0 ? <div className="manager-workboard__empty">归档中没有内容。</div> :
          <div className="manager-workboard__archive" role="tabpanel" aria-label="归档">
            {archivedObjectives.length > 0 && <section><h2>已归档目标 <span>{archivedObjectives.length}</span></h2>{archivedObjectives.map((objective) => <ArchivedObjectiveView key={`${objective.title}-${objective.archived_at}`} objective={objective} />)}</section>}
            {archivedWorkItems.length > 0 && <section><h2>已归档事项 <span>{archivedWorkItems.length}</span></h2>{archivedWorkItems.map((item) => <ArchivedWorkItemView key={`${item.objective.title}-${item.title}-${item.archived_at}`} item={item} />)}</section>}
          </div>
      )}
      {editor && <EditorDialog key={editorKey(editor)} editor={editor} objectives={objectives} busy={saving} onClose={() => setEditor(undefined)} onSubmit={(mutation) => { void save(mutation) }} />}
    </div>
  )
}

export const ManagerWorkboard: React.FC = () => <MainLayout><ManagerWorkboardContent /></MainLayout>
