import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ClientError, WorkspaceClient, type WorkspaceRecord, type WorkspaceSummary, type WorkspaceUsage, type WorkspaceRelocationPreviewResult, type WorkspaceRelocationIssue, type WorkspaceRelocationJobStage, type WorkspaceRelocationJobStatus } from 'crabot-client'
import { MainLayout } from '../components/Layout/MainLayout'
import { Button } from '../components/Common/Button'
import { Card } from '../components/Common/Card'
import { getWebClient } from '../services/api'
import { desktopBridge } from '../services/desktop-host'
import { serverQueries, useServerScope } from '../services/server-state'
import './Workspaces.css'

const statuses: Record<WorkspaceUsage['status'], string> = { pending: '尚未统计', measuring: '统计中', complete: '已统计', partial: '部分可读', failed: '统计失败', stale: '结果已过期' }
function bytes(value?: number) {
  if (value === undefined) return '未知'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'], level = Math.min(Math.floor(Math.log2(Math.max(1, value)) / 10), units.length - 1)
  return (value / 1024 ** level).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' ' + units[level]
}
function projectId() {
  const data = crypto.getRandomValues(new Uint8Array(16)); data[6] = (data[6] & 15) | 64; data[8] = (data[8] & 63) | 128
  const hex = Array.from(data, byte => byte.toString(16).padStart(2, '0')).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}
const message = (error: unknown) => error instanceof ClientError ? error.message : '操作未完成，请重新核对工作区状态。'

const relocationIssues: Record<WorkspaceRelocationIssue['reason'], string> = {
  absolute_link: '链接绑定绝对位置', external_link: '链接指向迁移范围之外', git_worktree: 'Git 工作树绑定外部位置',
  python_environment: 'Python 环境绑定原位置', external_hardlink: '与范围外文件共享硬链接', mount_point: '包含独立挂载目录', special_file: '包含不支持迁移的特殊文件', unreadable: '无法读取或核验',
}
function RelocationPreviewPanel({ client, source, revision, locked, canStart, rememberJob, refreshStatus }: { client: WorkspaceClient; source: string; revision: number; locked: boolean; canStart: boolean; rememberJob(id: string | null): void; refreshStatus(): void }) {
  const [target, setTarget] = useState(''), [result, setResult] = useState<WorkspaceRelocationPreviewResult>(), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const request = useRef<AbortController | undefined>(undefined), submitted = useRef(false), mounted = useRef(true)
  const [submitting, setSubmitting] = useState(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    request.current?.abort(); setResult(undefined); setBusy(false)
    return () => request.current?.abort()
  }, [client, revision, locked])
  function edit(value: string) { request.current?.abort(); setBusy(false); setResult(undefined); setError(''); setTarget(value) }
  async function preview(event: React.FormEvent) {
    event.preventDefault(); if (locked || busy || submitting || !target.trim()) return
    const controller = new AbortController(); request.current?.abort(); request.current = controller
    setBusy(true); setResult(undefined); setError('')
    try {
      const next = await client.previewRelocation({ target: target.trim() }, { signal: controller.signal })
      if (!controller.signal.aborted) { submitted.current = false; setResult(next) }
    } catch (failure) { if (!controller.signal.aborted) setError(message(failure)) }
    finally { if (request.current === controller) setBusy(false) }
  }
  async function start() {
    if (!result || locked || !canStart || incomplete || !result.execution.ready || workerCount === undefined || result.mode === 'unchanged' || submitted.current) return
    submitted.current = true; setSubmitting(true); setError('')
    const intent_id = projectId()
    rememberJob(intent_id)
    try {
      const receipt = await client.startRelocation({ intent_id, target: result.target, expected_revision: result.revision, confirmed: true })
      if (!mounted.current) return
      if ('unchanged' in receipt) { rememberJob(null); setResult(undefined); setError('当前位置相同，无需迁移。') }
    } catch {
      if (mounted.current) setError('接纳回执未收到，请以上方实际进度为准。')
    } finally {
      if (mounted.current) { setSubmitting(false); refreshStatus() }
    }
  }
  const available = result?.available_bytes
  const insufficient = result?.mode === 'copy' && result.usage?.logical_bytes !== undefined && available !== undefined && BigInt(result.usage.logical_bytes) > BigInt(available)
  const incomplete = result && result.mode !== 'unchanged' && (result.usage?.status !== 'complete' || result.usage.logical_bytes === undefined || result.issues.length > 0 || insufficient || result.mode === 'copy' && available === undefined)
  let summary = '预检通过，尚未开始迁移。'
  if (result?.mode === 'unchanged') summary = '当前位置相同，无需迁移。'
  else if (incomplete) summary = '预检发现阻塞项，请处理后重新检查。'
  const counts = result?.execution.ready ? Object.values(result.execution.items) : undefined
  const workerCount = counts?.every(item => item.worker_count !== undefined) ? counts.reduce((sum, item) => sum + item.worker_count!, 0) : undefined
  return <Card title="迁移工作目录">
    <p className="workspace-path">当前位置：{source}</p>
    <form aria-label="工作目录迁移预检" onSubmit={preview} className="workspace-form">
      <label>目标工作目录<input disabled={submitting} value={target} onChange={event => edit(event.target.value)} placeholder="运行 Crabot 的电脑或服务器上的绝对路径" /></label>
      <p className="workspace-note">先检查迁移范围、空间和兼容问题。检查不会停止任务或搬动文件。</p>
      <div className="workspace-actions"><Button type="submit" disabled={locked || busy || submitting || !target.trim()}>{busy ? '正在检查…' : '检查迁移位置'}</Button>
        {busy && <Button type="button" variant="secondary" onClick={() => { request.current?.abort(); setBusy(false) }}>取消检查</Button>}</div>
    </form>
    {error && <p role="alert">{error}</p>}
    {result && <section aria-label="迁移预检结果">
      <p>{summary}</p>
      <p className="workspace-path">预检源位置：{result.source}</p>
      <p className="workspace-path">目标位置：{result.target}</p>
      <p>{result.workspaces.length} 个工作区随迁，{result.retained_workspaces.length} 个根外项目保留原位。</p>
      {result.workspaces.length > 0 && <ul>{result.workspaces.map(item => <li key={item.workspace_id}>{item.name}：<span className="workspace-path">{item.root}</span>（随迁）</li>)}</ul>}
      {result.retained_workspaces.map(item => <p key={item.workspace_id}>{item.name}：<span className="workspace-path">{item.root}</span>（保留原位）</p>)}
      <p>{workerCount === undefined ? '执行器数量待核实，不能据此判断任务已停止。' : `当前关联 ${workerCount} 个执行器；这不是停止完成证明。`}</p>
      {result.usage && <p>源文件总大小：{bytes(result.usage.logical_bytes)} · {statuses[result.usage.status]}；目标可用空间约 {bytes(available === undefined ? undefined : Number(available))}。</p>}
      {insufficient && <p role="alert">目标空间不足，不能开始迁移。</p>}
      {result.issues.length > 0 && <ul>{result.issues.map((issue, index) => <li key={index}>{issue.path || '工作目录'}：{relocationIssues[issue.reason]}</li>)}</ul>}
      <p className="workspace-note">迁移期间暂停任务，管理页面保持在线；现有执行器将永久关闭，历史和文件保留。迁移后请发起新任务继续工作。</p>
      {!incomplete && result.mode !== 'unchanged' && result.execution.ready && workerCount !== undefined && canStart && <Button disabled={locked || submitting} onClick={() => void start()}>停止执行并迁移</Button>}
    </section>}
  </Card>
}

const relocationStages: Record<WorkspaceRelocationJobStage, string> = {
  preparing: '正在准备迁移', stopping: '正在停止并核验执行', moving: '正在迁移文件', closing_executors: '正在关闭旧执行器',
  switching: '正在切换目录', validating: '正在检查新目录与执行模块', finalizing: '正在保存迁移结果', restoring: '正在恢复业务',
  finished: '迁移步骤已结束', unknown: '阶段待核实',
}
function useRelocationStatus(client: WorkspaceClient, maintenance: boolean, knownId: string | null) {
  const scope = useServerScope(), previous = useRef<WorkspaceRelocationJobStatus | undefined>(undefined)
  if (knownId && previous.current?.intent_id !== knownId) previous.current = undefined
  const status = useQuery({ queryKey: ['server', scope, 'workspaces', 'relocation', 'current', knownId], queryFn: async ({ signal }) => {
    if (knownId && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(knownId)) throw new Error('Invalid relocation identity')
    let observed = knownId ? await client.relocationStatus(knownId, { signal }) : await client.currentRelocation({ signal }); signal.throwIfAborted()
    const id = knownId ?? previous.current?.intent_id
    if (!knownId && observed.available && !observed.job && id) observed = await client.relocationStatus(id, { signal })
    signal.throwIfAborted()
    if (observed.available && observed.job) previous.current = observed.job
    return observed
  }, refetchOnWindowFocus: true, refetchInterval: value => maintenance || ['preparing', 'running'].includes(value.state.data?.job?.state ?? previous.current?.state ?? '') ? 3000 : false }, serverQueries)
  const wasMaintaining = useRef(false)
  useEffect(() => {
    if (maintenance && !wasMaintaining.current && !status.isFetching) void status.refetch()
    wasMaintaining.current = maintenance
  }, [maintenance, status.refetch])
  const missing = !!knownId && status.data?.available === true && !status.data.job
  const uncertain = status.isError || status.data?.available === false || missing
  const job = uncertain ? previous.current : status.data?.job
  return { status, job, uncertain, missing }
}
function RelocationStatusPanel({ observation, knownId }: { observation: ReturnType<typeof useRelocationStatus>; knownId: string | null }) {
  const { status, job, uncertain, missing } = observation
  if (!job && !uncertain && !knownId) return null
  let title = '暂时无法核实迁移进度，保留上次信息；未重新提交迁移。'
  if (missing || knownId && !job && !status.isError) title = '提交结果待核实，请刷新迁移进度；不要重复提交。'
  let detail = '请稍后刷新，当前工作区列表与搜索仍可使用。'
  if (!uncertain && job) {
    if (job.state === 'completed') { title = '迁移已完成'; detail = '目录、执行模块和管理页面已恢复，旧执行器保持关闭。' }
    else if (job.state === 'committed') { title = '目录切换已提交'; detail = '这条历史记录确认了目录切换，完整业务恢复结果仍待核实。' }
    else if (job.state === 'needs_attention') { title = '迁移尚未确认完成'; detail = '请先核对当前状态；刷新页面不会重新执行迁移。' }
    else { title = relocationStages[job.stage]; detail = job.state === 'preparing' ? '正在准备并核对本次迁移，尚未确认接管。' : '迁移由后台继续执行，关闭页面不会取消已接纳的作业。' }
  }
  return <Card><section aria-label="工作目录迁移进度"><h2>迁移进度</h2>
    <p role={uncertain || job?.state === 'needs_attention' ? 'alert' : 'status'}>{title}</p><p className="workspace-note">{detail}</p>
    {(job || knownId) && <p className="workspace-path">作业编号：{job?.intent_id ?? knownId}</p>}
    {job && <><dl className="workspace-facts">
      <dt>原位置</dt><dd className="workspace-path">{job.source ?? '尚未核实'}</dd>
      <dt>目标位置</dt><dd className="workspace-path">{job.target ?? '尚未核实'}</dd>
      {uncertain && <><dt>上次确认阶段</dt><dd>{relocationStages[job.stage]}</dd></>}
    </dl></>}
    <div className="workspace-actions"><Button variant="secondary" disabled={status.isFetching} onClick={() => void status.refetch()}>刷新迁移进度</Button>
      {job && ['committed', 'needs_attention'].includes(job.state) && <Link to="/modules">查看当前模块状态</Link>}</div>
  </section></Card>
}

function WorkspaceEditor({ client, record, initialRevision, onSaved, locked }: {
  client: WorkspaceClient; record: WorkspaceRecord; initialRevision: number; onSaved(): void; locked: boolean
}) {
  const [name, setName] = useState(record.name), [description, setDescription] = useState(record.description)
  const [revision, setRevision] = useState(initialRevision), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState(false), [latest, setLatest] = useState<WorkspaceRecord>()
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (locked) return; setBusy(true); setError('')
    try {
      const result = await client.update(record.workspace_id, { expected_revision: revision, name, description })
      setRevision(result.revision); setName(result.workspace.name); setDescription(result.workspace.description); setLatest(undefined); onSaved()
    } catch (failure) { setError(message(failure)); setConflict(failure instanceof ClientError && failure.kind === 'conflict') }
    finally { setBusy(false) }
  }
  async function recheck() {
    setBusy(true)
    try { const result = await client.get(record.workspace_id); setLatest(result.item.workspace); setRevision(result.revision); setConflict(false); setError('已读取最新信息，当前草稿仍保留。请核对后再保存。') }
    catch (failure) { setError(message(failure)) } finally { setBusy(false) }
  }
  return <form onSubmit={save} className="workspace-form">
    <label>工作区名称<input value={name} onChange={event => setName(event.target.value)} required maxLength={120} /></label>
    <label>项目用途<textarea value={description} onChange={event => setDescription(event.target.value)} maxLength={2000} rows={3} /></label>
    {latest && <p>最新名称：{latest.name}；最新用途：{latest.description || '未补充'}</p>}
    {error && <p role="alert">{error}</p>}
    <div className="workspace-actions"><Button type="submit" disabled={busy || conflict || locked}>保存名称与用途</Button>
      {conflict && <Button type="button" variant="secondary" disabled={busy} onClick={() => void recheck()}>读取最新信息，保留草稿</Button>}</div>
  </form>
}
function WorkspaceDetails({ item, revision, client, refresh, onSaved, locked }: {
  item: WorkspaceSummary; revision: number; client: WorkspaceClient; refresh(id: string): void; onSaved(): void; locked: boolean
}) {
  const { workspace, usage, execution } = item
  const [opening, setOpening] = useState(false), [openError, setOpenError] = useState('')
  async function openFolder() {
    if (locked) return
    setOpening(true); setOpenError('')
    try { if (!await desktopBridge?.revealWorkspaceFolder(workspace.workspace_id)) setOpenError('目录暂时无法打开，请刷新状态并检查目录是否可用。') }
    catch { setOpenError('目录暂时无法打开，请刷新状态后重试。') }
    finally { setOpening(false) }
  }
  let executionLabel = '待核实'
  if (execution.status === 'running') executionLabel = '正在执行'
  else if (execution.status === 'idle') executionLabel = '当前空闲'
  let sourceLabel = '默认工作区'
  if (workspace.kind === 'project') sourceLabel = workspace.source === 'managed' ? 'Crabot 管理的项目目录' : '原有项目目录'
  return <Card title={workspace.kind === 'default' ? '默认工作区 · 未归属项目' : workspace.name}>
    <dl className="workspace-facts">
      <dt>目录</dt><dd className="workspace-path">{workspace.root}</dd>
      <dt>来源</dt><dd>{sourceLabel}</dd>
      <dt>目录状态</dt><dd>{item.directory_status === 'ready' ? '可访问' : item.directory_status === 'missing' ? '目录不存在' : '待核验或不可访问'}</dd>
      <dt>磁盘占用估算</dt><dd>{bytes(usage.allocated_bytes)}</dd><dt>文件总大小</dt><dd>{bytes(usage.logical_bytes)}</dd>
      <dt>统计状态</dt><dd>{statuses[usage.status]}{usage.measured_at && ' · ' + new Date(usage.measured_at).toLocaleString()}{usage.skipped_entries > 0 && ` · ${usage.skipped_entries} 项未计入`}</dd>
      <dt>执行占用</dt><dd>{executionLabel}{execution.worker_count !== undefined && ` · ${execution.worker_count} 个关联执行器`}</dd>
      <dt>观察时间</dt><dd>{execution.observed_at ? new Date(execution.observed_at).toLocaleString() : '未知'}</dd>
      <dt>最近使用</dt><dd>{workspace.last_used_at ? new Date(workspace.last_used_at).toLocaleString() : '未知'}</dd>
    </dl>
    <p className="workspace-note">路径位于运行 Crabot 的电脑或服务器。空间是带时间的估算，可能包含共享数据块；不等于删除后可释放的空间。</p>
    {desktopBridge?.revealWorkspaceFolder && <Button variant="secondary" disabled={locked || opening || item.directory_status !== 'ready'} onClick={() => void openFolder()}>在文件管理器打开</Button>}
    {openError && <p role="alert">{openError}</p>}
    <p><Link to={`/traces?tab=workers&workspace_id=${encodeURIComponent(workspace.workspace_id)}`}>查看关联执行器（含历史）</Link></p>
    <Button variant="secondary" disabled={locked || usage.status === 'measuring' || item.directory_status !== 'ready'} onClick={() => refresh(workspace.workspace_id)}>刷新空间统计</Button>
    {workspace.kind === 'project' && <WorkspaceEditor key={workspace.workspace_id} client={client} record={workspace} initialRevision={revision} onSaved={onSaved} locked={locked} />}
  </Card>
}

export function Workspaces() {
  const scope = useServerScope()
  return <WorkspacePage key={scope} scope={scope} />
}
function WorkspacePage({ scope }: { scope: string }) {
  const client = useMemo(() => new WorkspaceClient(getWebClient()), [scope])
  const maintenance = useQuery({ queryKey: ['server', scope, 'workspaces', 'maintenance'], queryFn: ({ signal }) => client.maintenance({ signal }),
    refetchOnWindowFocus: true, refetchInterval: 3000 }, serverQueries)
  const observedMaintenance = maintenance.isError ? true : maintenance.data?.maintenance
  const locked = observedMaintenance !== false

  const query = useQuery({ queryKey: ['server', scope, 'workspaces'], queryFn: ({ signal }) => client.list({ signal }),
    refetchOnWindowFocus: true, refetchInterval: value => value.state.data?.items.some(item => item.usage.status === 'measuring') ? 1000 : false }, serverQueries)
  const total = useQuery({ queryKey: ['server', scope, 'workspaces', 'usage'], queryFn: ({ signal }) => client.totalUsage({ signal }),
    refetchOnWindowFocus: true, refetchInterval: value => value.state.data?.status === 'measuring' ? 1000 : false }, serverQueries)
  const [totalRefreshing, setTotalRefreshing] = useState(false)
  const [searchParams, setSearchParams] = useSearchParams()
  const knownId = searchParams.get('relocation_id'), relocation = useRelocationStatus(client, observedMaintenance === true, knownId)
  const canStart = !relocation.status.isPending && !relocation.uncertain && relocation.status.data?.available === true && (!relocation.job || relocation.job.state === 'completed')
  const rememberJob = useCallback((id: string | null) => {
    setSearchParams(previous => { const next = new URLSearchParams(previous); if (id) next.set('relocation_id', id); else next.delete('relocation_id'); return next }, { replace: true })
  }, [setSearchParams])
  const refreshedJob = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (relocation.job?.state === 'completed' && !relocation.uncertain && refreshedJob.current !== relocation.job.intent_id) {
      refreshedJob.current = relocation.job.intent_id; void query.refetch(); void total.refetch()
    }
  }, [relocation.job, relocation.uncertain, query.refetch, total.refetch])
  const [selected, setSelected] = useState(searchParams.get('workspace_id') ?? ''), [search, setSearch] = useState(''), [sort, setSort] = useState('name')
  const [error, setError] = useState(''), [creating, setCreating] = useState(false), [saving, setSaving] = useState(false)
  const [name, setName] = useState(''), [purpose, setPurpose] = useState(''), [root, setRoot] = useState('')
  const createId = useRef(''), requested = useRef(new Set<string>())
  const previousMaintenance = useRef<boolean | undefined>(undefined)
  useEffect(() => {
    if (observedMaintenance === undefined) return
    if (previousMaintenance.current === true && !observedMaintenance) { void query.refetch(); void total.refetch() }
    previousMaintenance.current = observedMaintenance
  }, [observedMaintenance, query.refetch, total.refetch])

  useEffect(() => {
    if (locked) return
    const controller = new AbortController()
    const candidates = query.data?.items.filter(item => item.directory_status === 'ready' && item.usage.status === 'pending' && !requested.current.has(JSON.stringify([item.workspace.workspace_id, item.workspace.root]))) ?? []
    for (const item of candidates) requested.current.add(JSON.stringify([item.workspace.workspace_id, item.workspace.root]))
    if (candidates.length) void Promise.allSettled(candidates.map(item => client.refresh(item.workspace.workspace_id, { signal: controller.signal }))).then(() => {
      if (!controller.signal.aborted) void query.refetch()
    })
    return () => controller.abort()
  }, [client, query.data, locked])
  const items = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase()
    return [...(query.data?.items ?? [])].filter(item => [item.workspace.name, item.workspace.description, item.workspace.root].some(text => text.toLocaleLowerCase().includes(needle)))
      .sort((a, b) => {
        if (sort === 'space') return (b.usage.logical_bytes ?? -1) - (a.usage.logical_bytes ?? -1)
        return a.workspace.name.localeCompare(b.workspace.name)
      })
  }, [query.data, search, sort])
  const current = query.data?.items.find(item => item.workspace.workspace_id === selected)
  async function refresh(id: string) {
    if (locked) return
    try { await client.refresh(id); await query.refetch() } catch (failure) { setError(message(failure)) }
  }
  async function refreshTotal() {
    if (locked) return
    setTotalRefreshing(true)
    try { await client.refreshTotalUsage(); await total.refetch() } catch (failure) { setError(message(failure)) }
    finally { setTotalRefreshing(false) }
  }
  async function create(event: React.FormEvent) {
    event.preventDefault(); if (locked) return; setSaving(true); setError('')
    try {
      const result = await client.create({ workspace_id: createId.current, name, description: purpose, ...(root.trim() ? { root: root.trim() } : {}) })
      setCreating(false); setSelected(result.workspace.workspace_id); await query.refetch(); await total.refetch()
    } catch (failure) { setError(message(failure)) } finally { setSaving(false) }
  }
  return <MainLayout><div className="workspaces-page">
    <div className="workspace-heading"><div><h1>工作区</h1><p>每个项目长期使用一个工作区；未识别项目的任务放入默认工作区。</p></div>
      <div className="workspace-actions"><Button variant="secondary" disabled={query.isFetching} onClick={() => { void query.refetch(); void total.refetch(); void maintenance.refetch() }}>刷新列表与执行状态</Button>
        <Button disabled={locked} onClick={() => { createId.current = projectId(); setName(''); setPurpose(''); setRoot(''); setCreating(true) }}>添加项目工作区</Button></div></div>
    {maintenance.isError ? <p role="alert">暂时无法核实工作区维护状态，仍可查看和搜索；请重新核验后再操作。 <Button variant="secondary" onClick={() => void maintenance.refetch()}>重新核验维护状态</Button></p>
      : locked && <p role="status">{observedMaintenance ? '工作目录正在维护或等待恢复，新任务与相关文件操作暂不可用。仍可查看和搜索工作区。' : '正在核验工作区维护状态…'}</p>}
    <RelocationStatusPanel observation={relocation} knownId={knownId} />
    {query.data && <RelocationPreviewPanel client={client} source={query.data.storage_root} revision={query.data.revision} locked={locked} canStart={canStart} rememberJob={rememberJob} refreshStatus={() => void serverQueries.invalidateQueries({ queryKey: ['server', scope, 'workspaces', 'relocation'] })} />}
    {query.data && <p>{query.data.items.filter(item => item.workspace.kind === 'project').length} 个项目工作区 · 1 个默认工作区 · {query.data.items.filter(item => item.directory_status !== 'ready').length} 个目录待核实</p>}
    <section aria-label="全部工作区空间">
      <h2>全部工作区空间</h2>
      <p>磁盘占用估算 {bytes(total.data?.allocated_bytes)} · 文件总大小 {bytes(total.data?.logical_bytes)} · {total.data ? statuses[total.data.status] : '正在读取'}</p>
      {total.data?.status === 'partial' && <p>已统计下界 · {total.data.skipped_entries} 项未计入</p>}
      {total.data?.measured_at && <p>统计时间：{new Date(total.data.measured_at).toLocaleString()}</p>}
      <p className="workspace-note">按实际目录去重，包含隐藏文件和依赖；不等于删除后可释放的空间。</p>
      {total.error && <p role="alert">{message(total.error)}</p>}
      <Button variant="secondary" disabled={locked || totalRefreshing || total.data?.status === 'measuring'} onClick={() => void refreshTotal()}>刷新汇总空间</Button>
    </section>
    {(error || query.error) && <p role="alert">{error || message(query.error)} <Button variant="secondary" onClick={() => void query.refetch()}>重新读取</Button></p>}
    {creating && <Card title="添加项目工作区"><form onSubmit={create} className="workspace-form">
      <label>项目名称<input value={name} onChange={event => setName(event.target.value)} required maxLength={120} /></label>
      <label>用途说明<textarea value={purpose} onChange={event => setPurpose(event.target.value)} maxLength={2000} /></label>
      <label>已有项目目录（可选）<input value={root} onChange={event => setRoot(event.target.value)} placeholder="留空由 Crabot 创建项目目录" /></label>
      <p className="workspace-note">填写运行 Crabot 的电脑或服务器上的绝对路径。绑定原有目录会保留其中的文件。</p>
      <div className="workspace-actions"><Button type="submit" disabled={saving || locked}>保存工作区</Button><Button type="button" variant="secondary" disabled={saving} onClick={() => setCreating(false)}>取消</Button></div>
    </form></Card>}
    <div className="workspace-actions"><label>搜索工作区<input value={search} onChange={event => setSearch(event.target.value)} placeholder="名称、用途或路径" /></label>
      <label>排序<select value={sort} onChange={event => setSort(event.target.value)}><option value="name">名称</option><option value="space">文件总大小从大到小</option></select></label></div>
    {query.isPending ? <p role="status">正在读取工作区…</p> : <div className="workspace-list">{items.map(item => <button key={item.workspace.workspace_id} className={`workspace-row${selected === item.workspace.workspace_id ? ' is-selected' : ''}`} onClick={() => setSelected(item.workspace.workspace_id)}>
      <strong>{item.workspace.kind === 'default' ? '默认工作区 · 未归属项目' : item.workspace.name}</strong>
      <span>{item.workspace.description || '用途未补充'}</span><span>{item.usage.allocated_bytes === undefined ? '文件总大小 ' + bytes(item.usage.logical_bytes) : '磁盘占用约 ' + bytes(item.usage.allocated_bytes)} · {statuses[item.usage.status]}</span>
      <span className="workspace-path">{item.workspace.root}</span></button>)}</div>}
    {!query.isPending && !query.error && !items.length && <p>没有匹配的工作区。</p>}
    {current && <WorkspaceDetails key={scope + ':' + current.workspace.workspace_id} item={current} revision={query.data!.revision} client={client} locked={locked} refresh={id => void refresh(id)} onSaved={() => void query.refetch()} />}
  </div></MainLayout>
}
