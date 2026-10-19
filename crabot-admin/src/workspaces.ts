import fs from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { WorkspaceCatalog, WorkspaceError } from 'crabot-shared/dist/workspace-catalog.js'
import { scanWorkspaceUsage, scanWorkspaceSetUsage } from 'crabot-shared/dist/workspace-usage.js'
import type { WorkspaceCreateRequest, WorkspaceExecution, WorkspaceExecutionInventory, WorkspaceRecord, WorkspaceScanResult, WorkspaceSummary,
  WorkspaceUpdateRequest, WorkspaceUsage } from 'crabot-shared'
import { WorkspaceCreateRequestSchema, WorkspaceIdSchema, WorkspaceUpdateRequestSchema, z } from 'crabot-client'

const pending = (): WorkspaceUsage => ({ status: 'pending', file_count: 0, skipped_entries: 0 })
type Scan = typeof scanWorkspaceUsage
const totalKey = '@total'
const scopeKey = (roots: string[]) => JSON.stringify([...new Set(roots)].sort())
interface ScanJob { id: string; root: string; roots?: string[]; controller: AbortController }
interface Observation { root: string; usage: WorkspaceUsage }

/** Human management projection; never invokes an Agent, shell or task runner to scan. */
export class WorkspaceService {
  private readonly catalog: WorkspaceCatalog
  private readonly scanSet: typeof scanWorkspaceSetUsage
  private readonly scan: Scan
  private readonly execution?: () => Promise<WorkspaceExecutionInventory>
  private readonly observations = new Map<string, Observation>()
  private readonly jobs = new Map<string, ScanJob>()
  private draining?: Promise<void>
  private closed = false
  private paused = false

  constructor(options: { dataRoot: string; storageRoot?: string; scan?: Scan; scanSet?: typeof scanWorkspaceSetUsage;
    execution?: () => Promise<WorkspaceExecutionInventory> }) {
    this.catalog = new WorkspaceCatalog({ ...options, files: require('../../scripts/lib/process-identity.cjs') })
    this.scan = options.scan ?? scanWorkspaceUsage
    this.scanSet = options.scanSet ?? scanWorkspaceSetUsage
    this.execution = options.execution
  }
  initialize() { return this.catalog.initialize() }
  private async snapshot() {
    const snapshot = await this.catalog.snapshot()
    if (!snapshot.workspaces.some(record => record.workspace_id === 'default')) {
      throw new WorkspaceError('WORKSPACE_UNAVAILABLE', '工作区登记尚未就绪，请查看诊断；未创建替代工作区。')
    }
    return snapshot
  }
  create(input: WorkspaceCreateRequest) { return this.catalog.createProject(input) }
  update(id: string, input: WorkspaceUpdateRequest) { return this.catalog.update(id, input) }
  async list() {
    const snapshot = await this.snapshot(), items: WorkspaceSummary[] = []
    const execution = await this.executionSnapshot()
    for (const record of snapshot.workspaces) items.push(await this.summary(record, execution))
    return { revision: snapshot.revision, storage_root: snapshot.storage_root, items }
  }
  async get(id: string) {
    const snapshot = await this.snapshot(), record = snapshot.workspaces.find(item => item.workspace_id === id)
    if (!record) throw new WorkspaceError('WORKSPACE_NOT_FOUND', '工作区不存在。')
    return { revision: snapshot.revision, item: await this.summary(record, await this.executionSnapshot()) }
  }
  async usage(id: string): Promise<WorkspaceScanResult> {
    const record = await this.catalog.get(id)
    return { workspace_id: id, usage: this.observed(record) }
  }
  async refresh(id: string): Promise<WorkspaceScanResult> {
    this.checkScanning()
    const record = await this.catalog.get(id)
    return { workspace_id: id, usage: this.enqueue(id, record.root) }
  }
  async totalUsage(): Promise<WorkspaceUsage> {
    return this.observedScope(totalKey, scopeKey(await this.totalRoots()))
  }
  async refreshTotalUsage(): Promise<WorkspaceUsage> {
    this.checkScanning()
    const roots = await this.totalRoots()
    return this.enqueue(totalKey, scopeKey(roots), roots)
  }
  private async totalRoots(): Promise<string[]> { return (await this.snapshot()).workspaces.map(record => record.root) }
  private checkScanning(): void {
    if (this.closed || this.paused) throw new WorkspaceError('WORKSPACE_UNAVAILABLE', this.paused ? '工作区维护期间空间统计已暂停。' : '工作区统计正在停止，请稍候重试。')
  }
  private enqueue(id: string, root: string, roots?: string[]): WorkspaceUsage {
    this.checkScanning()
    if (!this.jobs.has(id)) {
      this.observations.set(id, { root, usage: { ...this.observedScope(id, root), status: 'measuring' } })
      this.jobs.set(id, { id, root, roots, controller: new AbortController() })
      this.startDrain()
    }
    return this.observedScope(id, root)
  }
  /** Host coordination only: drain file access while Admin and read-only snapshots stay online. */
  async pauseScanning(): Promise<void> {
    this.paused = true
    await this.drainScans()
  }
  resumeScanning(): void {
    if (this.closed) throw new WorkspaceError('WORKSPACE_UNAVAILABLE', '工作区统计已经停止。')
    if (this.draining) throw new WorkspaceError('WORKSPACE_BUSY', '工作区扫描句柄尚未全部关闭。')
    this.paused = false
  }
  async close(): Promise<void> {
    this.closed = true
    await this.drainScans()
  }
  private async drainScans(): Promise<void> {
    for (const job of this.jobs.values()) job.controller.abort()
    await this.draining
  }
  private observed(record: WorkspaceRecord): WorkspaceUsage {
    return this.observedScope(record.workspace_id, record.root)
  }
  private observedScope(id: string, root: string): WorkspaceUsage {
    const previous = this.observations.get(id)
    return previous && previous.root === root ? { ...previous.usage } : pending()
  }
  private async executionSnapshot(): Promise<WorkspaceExecutionInventory> {
    try { if (this.execution) return await this.execution() } catch { /* Runtime is unavailable; registration and usage stay readable. */ }
    return { ready: false, items: {} }
  }
  private async summary(workspace: WorkspaceRecord, inventory: WorkspaceExecutionInventory): Promise<WorkspaceSummary> {
    let directory_status: WorkspaceSummary['directory_status'] = 'ready'
    try {
      const stat = await fs.lstat(workspace.root)
      if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(workspace.root) !== workspace.root) directory_status = 'unavailable'
    } catch (error) { directory_status = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable' }
    let execution: WorkspaceExecution = { status: 'unknown' }
    if (inventory.ready) execution = inventory.items[workspace.workspace_id] ?? { status: 'idle', observed_at: new Date().toISOString(), worker_count: 0, running_worker_count: 0 }
    return { workspace, directory_status, usage: this.observed(workspace), execution }
  }
  private startDrain(): void {
    this.draining ??= this.drain().finally(() => {
      this.draining = undefined
      if (this.jobs.size) this.startDrain()
    })
  }
  private async drain(): Promise<void> {
    while (this.jobs.size) {
      const job = this.jobs.values().next().value as ScanJob
      const before = this.observations.get(job.id)!
      try {
        if (this.closed || this.paused) throw new Error('scan stopped')
        const options = { signal: job.controller.signal }
        const usage = await (job.roots ? this.scanSet(job.roots, options) : this.scan(job.root, options))
        const current = job.roots ? scopeKey(await this.totalRoots()) : (await this.catalog.get(job.id)).root
        if (current !== job.root || job.controller.signal.aborted) throw new Error('scan superseded')
        this.observations.set(job.id, { root: job.root, usage })
      } catch {
        this.observations.set(job.id, { root: job.root, usage: { ...before.usage,
          status: before.usage.measured_at || before.usage.logical_bytes !== undefined ? 'stale' : 'failed' } })
      } finally { this.jobs.delete(job.id) }
    }
  }

  async handleWeb(req: IncomingMessage, res: ServerResponse, pathname: string, readBody: () => Promise<unknown>): Promise<boolean> {
    if (pathname !== '/api/workspaces' && !pathname.startsWith('/api/workspaces/')) return false
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    try {
      if (pathname === '/api/workspaces') {
        if (req.method === 'GET') send(200, await this.list())
        else if (req.method === 'POST') send(200, await this.create(WorkspaceCreateRequestSchema.parse(await readBody())))
        else send(405, { code: 'WORKSPACE_METHOD_NOT_ALLOWED', message: '工作区不支持此操作。' })
        return true
      }
      if (pathname === '/api/workspaces/usage' || pathname === '/api/workspaces/usage/refresh') {
        if (pathname.endsWith('/refresh') && req.method === 'POST') { z.strictObject({}).parse(await readBody()); send(202, await this.refreshTotalUsage()) }
        else if (!pathname.endsWith('/refresh') && req.method === 'GET') send(200, await this.totalUsage())
        else send(405, { code: 'WORKSPACE_METHOD_NOT_ALLOWED', message: '工作区不支持此操作。' })
        return true
      }
      const match = /^\/api\/workspaces\/([^/]+)(\/usage(?:\/refresh)?)?$/.exec(pathname)
      if (!match) { send(404, { code: 'WORKSPACE_NOT_FOUND', message: '工作区接口不存在。' }); return true }
      let id: string
      try { id = WorkspaceIdSchema.parse(decodeURIComponent(match[1])) }
      catch { throw new WorkspaceError('WORKSPACE_INVALID_REQUEST', '工作区标识无效。') }
      if (!match[2] && req.method === 'GET') send(200, await this.get(id))
      else if (!match[2] && req.method === 'PATCH') send(200, await this.update(id, WorkspaceUpdateRequestSchema.parse(await readBody())))
      else if (match[2] === '/usage' && req.method === 'GET') send(200, await this.usage(id))
      else if (match[2] === '/usage/refresh' && req.method === 'POST') { z.strictObject({}).parse(await readBody()); send(202, await this.refresh(id)) }
      else send(405, { code: 'WORKSPACE_METHOD_NOT_ALLOWED', message: '工作区不支持此操作。' })
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError || (error instanceof Error && error.message === 'Invalid JSON')) send(400, { code: 'WORKSPACE_INVALID_REQUEST', message: '工作区请求格式不符合要求。' })
      else if (error instanceof WorkspaceError) {
        let status = 503
        switch (error.code) {
          case 'WORKSPACE_NOT_FOUND': status = 404; break
          case 'WORKSPACE_INVALID_REQUEST': status = 400; break
          case 'WORKSPACE_DIRECTORY_CONFLICT':
          case 'WORKSPACE_REVISION_CONFLICT':
          case 'WORKSPACE_DIRECTORY_MISSING': status = 409; break
        }
        send(status, { code: error.code, message: error.message })
      } else send(500, { code: 'WORKSPACE_OPERATION_FAILED', message: '工作区操作未完成，请查看诊断并检查目录权限。' })
    }
    return true
  }
}
