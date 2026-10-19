import fs from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { WorkspaceCatalog, WorkspaceError } from 'crabot-shared/dist/workspace-catalog.js'
import { scanWorkspaceUsage } from 'crabot-shared/dist/workspace-usage.js'
import type { WorkspaceCreateRequest, WorkspaceExecution, WorkspaceRecord, WorkspaceScanResult, WorkspaceSummary,
  WorkspaceUpdateRequest, WorkspaceUsage } from 'crabot-shared'
import { WorkspaceCreateRequestSchema, WorkspaceIdSchema, WorkspaceUpdateRequestSchema, z } from 'crabot-client'

const pending = (): WorkspaceUsage => ({ status: 'pending', file_count: 0, skipped_entries: 0 })
type Scan = typeof scanWorkspaceUsage
interface ScanJob { id: string; root: string; controller: AbortController }
interface Observation { root: string; usage: WorkspaceUsage }

/** Human management projection; never invokes an Agent, shell or task runner to scan. */
export class WorkspaceService {
  private readonly catalog: WorkspaceCatalog
  private readonly scan: Scan
  private readonly execution?: (workspace: WorkspaceRecord) => Promise<WorkspaceExecution>
  private readonly observations = new Map<string, Observation>()
  private readonly jobs = new Map<string, ScanJob>()
  private draining?: Promise<void>
  private closed = false

  constructor(options: { dataRoot: string; storageRoot?: string; scan?: Scan;
    execution?: (workspace: WorkspaceRecord) => Promise<WorkspaceExecution> }) {
    this.catalog = new WorkspaceCatalog({ ...options, files: require('../../scripts/lib/process-identity.cjs') })
    this.scan = options.scan ?? scanWorkspaceUsage
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
    for (const record of snapshot.workspaces) items.push(await this.summary(record))
    return { revision: snapshot.revision, storage_root: snapshot.storage_root, items }
  }
  async get(id: string) {
    const snapshot = await this.snapshot(), record = snapshot.workspaces.find(item => item.workspace_id === id)
    if (!record) throw new WorkspaceError('WORKSPACE_NOT_FOUND', '工作区不存在。')
    return { revision: snapshot.revision, item: await this.summary(record) }
  }
  async usage(id: string): Promise<WorkspaceScanResult> {
    const record = await this.catalog.get(id)
    return { workspace_id: id, usage: this.observed(record) }
  }
  async refresh(id: string): Promise<WorkspaceScanResult> {
    if (this.closed) throw new WorkspaceError('WORKSPACE_UNAVAILABLE', '工作区统计正在停止，请稍候重试。')
    const record = await this.catalog.get(id)
    if (this.closed) throw new WorkspaceError('WORKSPACE_UNAVAILABLE', '工作区统计正在停止，请稍候重试。')
    if (!this.jobs.has(id)) {
      this.observations.set(id, { root: record.root, usage: { ...this.observed(record), status: 'measuring' } })
      this.jobs.set(id, { id, root: record.root, controller: new AbortController() })
      this.startDrain()
    }
    return { workspace_id: id, usage: this.observed(record) }
  }
  async close(): Promise<void> {
    this.closed = true
    for (const job of this.jobs.values()) job.controller.abort()
    await this.draining
  }
  private observed(record: WorkspaceRecord): WorkspaceUsage {
    const previous = this.observations.get(record.workspace_id)
    return previous && previous.root === record.root ? { ...previous.usage } : pending()
  }
  private async summary(workspace: WorkspaceRecord): Promise<WorkspaceSummary> {
    let directory_status: WorkspaceSummary['directory_status'] = 'ready'
    try {
      const stat = await fs.lstat(workspace.root)
      if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(workspace.root) !== workspace.root) directory_status = 'unavailable'
    } catch (error) { directory_status = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable' }
    let execution: WorkspaceExecution = { status: 'unknown' }
    try { if (this.execution) execution = await this.execution(workspace) } catch { /* Keep unavailable runtime evidence explicit. */ }
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
        if (this.closed) throw new Error('scan stopped')
        const usage = await this.scan(job.root, { signal: job.controller.signal })
        const current = await this.catalog.get(job.id)
        if (current.root !== job.root || job.controller.signal.aborted) throw new Error('scan superseded')
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
