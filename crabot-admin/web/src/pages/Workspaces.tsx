import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ClientError, WorkspaceClient, type WorkspaceRecord, type WorkspaceSummary, type WorkspaceUsage } from 'crabot-client'
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

function WorkspaceEditor({ client, record, initialRevision, onSaved }: {
  client: WorkspaceClient; record: WorkspaceRecord; initialRevision: number; onSaved(): void
}) {
  const [name, setName] = useState(record.name), [description, setDescription] = useState(record.description)
  const [revision, setRevision] = useState(initialRevision), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState(false), [latest, setLatest] = useState<WorkspaceRecord>()
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
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
    <div className="workspace-actions"><Button type="submit" disabled={busy || conflict}>保存名称与用途</Button>
      {conflict && <Button type="button" variant="secondary" disabled={busy} onClick={() => void recheck()}>读取最新信息，保留草稿</Button>}</div>
  </form>
}
function WorkspaceDetails({ item, revision, client, refresh, onSaved }: {
  item: WorkspaceSummary; revision: number; client: WorkspaceClient; refresh(id: string): void; onSaved(): void
}) {
  const { workspace, usage, execution } = item
  const [opening, setOpening] = useState(false), [openError, setOpenError] = useState('')
  async function openFolder() {
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
    {desktopBridge?.revealWorkspaceFolder && <Button variant="secondary" disabled={opening || item.directory_status !== 'ready'} onClick={() => void openFolder()}>在文件管理器打开</Button>}
    {openError && <p role="alert">{openError}</p>}
    <p><Link to={`/traces?tab=workers&workspace_id=${encodeURIComponent(workspace.workspace_id)}`}>查看关联执行器（含历史）</Link></p>
    <Button variant="secondary" disabled={usage.status === 'measuring' || item.directory_status !== 'ready'} onClick={() => refresh(workspace.workspace_id)}>刷新空间统计</Button>
    {workspace.kind === 'project' && <WorkspaceEditor key={workspace.workspace_id} client={client} record={workspace} initialRevision={revision} onSaved={onSaved} />}
  </Card>
}

export function Workspaces() {
  const scope = useServerScope()
  return <WorkspacePage key={scope} scope={scope} />
}
function WorkspacePage({ scope }: { scope: string }) {
  const client = useMemo(() => new WorkspaceClient(getWebClient()), [scope])
  const query = useQuery({ queryKey: ['server', scope, 'workspaces'], queryFn: ({ signal }) => client.list({ signal }),
    refetchOnWindowFocus: true, refetchInterval: value => value.state.data?.items.some(item => item.usage.status === 'measuring') ? 1000 : false }, serverQueries)
  const [searchParams] = useSearchParams()
  const [selected, setSelected] = useState(searchParams.get('workspace_id') ?? ''), [search, setSearch] = useState(''), [sort, setSort] = useState('name')
  const [error, setError] = useState(''), [creating, setCreating] = useState(false), [saving, setSaving] = useState(false)
  const [name, setName] = useState(''), [purpose, setPurpose] = useState(''), [root, setRoot] = useState('')
  const createId = useRef(''), requested = useRef(new Set<string>())
  useEffect(() => {
    const controller = new AbortController()
    const candidates = query.data?.items.filter(item => item.directory_status === 'ready' && item.usage.status === 'pending' && !requested.current.has(item.workspace.workspace_id)) ?? []
    for (const item of candidates) requested.current.add(item.workspace.workspace_id)
    if (candidates.length) void Promise.allSettled(candidates.map(item => client.refresh(item.workspace.workspace_id, { signal: controller.signal }))).then(() => {
      if (!controller.signal.aborted) void query.refetch()
    })
    return () => controller.abort()
  }, [client, query.data])
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
    try { await client.refresh(id); await query.refetch() } catch (failure) { setError(message(failure)) }
  }
  async function create(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setError('')
    try {
      const result = await client.create({ workspace_id: createId.current, name, description: purpose, ...(root.trim() ? { root: root.trim() } : {}) })
      setCreating(false); setSelected(result.workspace.workspace_id); await query.refetch()
    } catch (failure) { setError(message(failure)) } finally { setSaving(false) }
  }
  return <MainLayout><div className="workspaces-page">
    <div className="workspace-heading"><div><h1>工作区</h1><p>每个项目长期使用一个工作区；未识别项目的任务放入默认工作区。</p></div>
      <div className="workspace-actions"><Button variant="secondary" disabled={query.isFetching} onClick={() => void query.refetch()}>刷新列表与执行状态</Button>
        <Button onClick={() => { createId.current = projectId(); setName(''); setPurpose(''); setRoot(''); setCreating(true) }}>添加项目工作区</Button></div></div>
    {query.data && <p>{query.data.items.filter(item => item.workspace.kind === 'project').length} 个项目工作区 · 1 个默认工作区 · {query.data.items.filter(item => item.directory_status !== 'ready').length} 个目录待核实</p>}
    {(error || query.error) && <p role="alert">{error || message(query.error)} <Button variant="secondary" onClick={() => void query.refetch()}>重新读取</Button></p>}
    {creating && <Card title="添加项目工作区"><form onSubmit={create} className="workspace-form">
      <label>项目名称<input value={name} onChange={event => setName(event.target.value)} required maxLength={120} /></label>
      <label>用途说明<textarea value={purpose} onChange={event => setPurpose(event.target.value)} maxLength={2000} /></label>
      <label>已有项目目录（可选）<input value={root} onChange={event => setRoot(event.target.value)} placeholder="留空由 Crabot 创建项目目录" /></label>
      <p className="workspace-note">填写运行 Crabot 的电脑或服务器上的绝对路径。绑定原有目录会保留其中的文件。</p>
      <div className="workspace-actions"><Button type="submit" disabled={saving}>保存工作区</Button><Button type="button" variant="secondary" disabled={saving} onClick={() => setCreating(false)}>取消</Button></div>
    </form></Card>}
    <div className="workspace-actions"><label>搜索工作区<input value={search} onChange={event => setSearch(event.target.value)} placeholder="名称、用途或路径" /></label>
      <label>排序<select value={sort} onChange={event => setSort(event.target.value)}><option value="name">名称</option><option value="space">文件总大小从大到小</option></select></label></div>
    {query.isPending ? <p role="status">正在读取工作区…</p> : <div className="workspace-list">{items.map(item => <button key={item.workspace.workspace_id} className={`workspace-row${selected === item.workspace.workspace_id ? ' is-selected' : ''}`} onClick={() => setSelected(item.workspace.workspace_id)}>
      <strong>{item.workspace.kind === 'default' ? '默认工作区 · 未归属项目' : item.workspace.name}</strong>
      <span>{item.workspace.description || '用途未补充'}</span><span>{item.usage.allocated_bytes === undefined ? '文件总大小 ' + bytes(item.usage.logical_bytes) : '磁盘占用约 ' + bytes(item.usage.allocated_bytes)} · {statuses[item.usage.status]}</span>
      <span className="workspace-path">{item.workspace.root}</span></button>)}</div>}
    {!query.isPending && !query.error && !items.length && <p>没有匹配的工作区。</p>}
    {current && <WorkspaceDetails key={scope + ':' + current.workspace.workspace_id} item={current} revision={query.data!.revision} client={client} refresh={id => void refresh(id)} onSaved={() => void query.refetch()} />}
  </div></MainLayout>
}
