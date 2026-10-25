import fs from 'node:fs/promises'
import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { sha256CanonicalJson } from './canonical-json.js'
import type { WorkspaceCreateRequest, WorkspaceRecord, WorkspaceRecordResult, WorkspaceUpdateRequest } from './workspace-types.js'

// The OS lock has no CLI/startup/upgrade semantics; a crash releases its handle.
export interface WorkspaceFileControl {
  tryFileLock(file: string, metadata: string): unknown
  releaseFileLock(handle: unknown): void
  createPrivateDirectory(directory: string): void
  isPrivateDirectory(directory: string): boolean
  writePrivateFile(file: string, content: string): void
  isPrivateFile(file: string): boolean
}
const held = new Set<string>()
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const within = (parent: string, child: string) => {
  const relative = path.relative(parent, child)
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
}
export class WorkspaceError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'WorkspaceError' }
}
const invalid = () => new WorkspaceError('WORKSPACE_STATE_INVALID', '工作区记录无法核验，已保留原文件；请查看诊断。')
const badRequest = () => new WorkspaceError('WORKSPACE_INVALID_REQUEST', '工作区名称、标识或目录不符合要求。')

function canonicalLocation(directory: string): string {
  const resolved = path.resolve(directory)
  try { return realpathSync.native(resolved) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = path.dirname(resolved)
    if (parent === resolved) throw error
    return path.join(canonicalLocation(parent), path.basename(resolved))
  }
}
function text(value: unknown, limit: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.includes('\0')) throw badRequest()
  const result = value.trim()
  if ((!allowEmpty && !result) || result.length > limit) throw badRequest()
  return result
}
function directoryPath(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0') || !path.isAbsolute(value)) throw badRequest()
  return canonicalLocation(value)
}

export interface WorkspaceCatalogSnapshot {
  revision: number
  storage_root: string
  workspaces: WorkspaceRecord[]
}
interface CatalogFile extends WorkspaceCatalogSnapshot { version: 1 }

/** Fixed technical projection only; the original relocation coordinator owns physical verification and authority. */
export function projectWorkspaceCatalogRelocation(before: WorkspaceCatalogSnapshot, target: string): WorkspaceCatalogSnapshot {
  const source = before.storage_root
  if (!Number.isSafeInteger(before.revision) || before.revision < 1 || before.revision >= Number.MAX_SAFE_INTEGER
    || typeof source !== 'string' || !path.isAbsolute(source) || source.includes('\0') || path.normalize(source) !== source
    || typeof target !== 'string' || !path.isAbsolute(target) || target.includes('\0') || path.normalize(target) !== target
    || within(source, target) || within(target, source) || !Array.isArray(before.workspaces)) throw badRequest()
  const after = structuredClone(before)
  after.storage_root = target; after.revision++
  const roots = new Set<string>()
  after.workspaces = after.workspaces.map(record => {
    if (!record || typeof record.root !== 'string' || !path.isAbsolute(record.root) || record.root.includes('\0')) throw badRequest()
    const root = within(source, record.root) ? path.join(target, path.relative(source, record.root)) : record.root
    const identity = process.platform === 'win32' ? root.toLowerCase() : root
    if (roots.has(identity)) throw new WorkspaceError('WORKSPACE_DIRECTORY_CONFLICT', '迁移后的项目目录冲突，未更改原登记。')
    roots.add(identity)
    return { ...record, root }
  })
  return after
}

export class WorkspaceCatalog {
  private readonly dataRoot: string
  private readonly initialRoot: string
  private readonly explicitRoot: string | undefined
  private readonly control: string
  private readonly file: string

  constructor(private readonly options: { dataRoot: string; storageRoot?: string; files: WorkspaceFileControl }) {
    this.dataRoot = canonicalLocation(options.dataRoot)
    this.explicitRoot = options.storageRoot === undefined ? undefined : directoryPath(options.storageRoot)
    this.initialRoot = this.explicitRoot ?? path.join(this.dataRoot, 'workspaces')
    this.control = path.join(this.dataRoot, 'workspace-control')
    this.file = path.join(this.control, 'catalog.json')
  }

  async snapshot(): Promise<WorkspaceCatalogSnapshot> {
    const file = await this.read()
    return file ?? { revision: 0, storage_root: this.initialRoot, workspaces: [] }
  }

  async initialize(): Promise<void> {
    await this.lock(async () => {
      if (await this.read()) return
      const file: CatalogFile = { version: 1, revision: 1, storage_root: this.initialRoot, workspaces: [{
        workspace_id: 'default', kind: 'default', name: '默认工作区', description: '',
        root: path.join(this.initialRoot, 'default'), source: 'managed', created_at: new Date().toISOString(),
      }] }
      await this.ensureDirectory(file.workspaces[0].root)
      await this.write(file)
    })
  }

  async get(id: string): Promise<WorkspaceRecord> {
    const record = (await this.snapshot()).workspaces.find(workspace => workspace.workspace_id === id)
    if (!record) throw new WorkspaceError('WORKSPACE_NOT_FOUND', '工作区不存在。')
    return record
  }

  async createProject(input: WorkspaceCreateRequest): Promise<WorkspaceRecordResult> {
    if (!uuid.test(input.workspace_id)) throw badRequest()
    const name = text(input.name, 120), description = text(input.description ?? '', 2000, true)
    const requested = input.root === undefined ? undefined : directoryPath(input.root)
    await this.initialize()
    return this.lock(async () => {
      const file = await this.required()
      const previous = file.workspaces.find(workspace => workspace.workspace_id === input.workspace_id)
      if (previous) {
        if (requested && requested !== previous.root) throw new WorkspaceError('WORKSPACE_DIRECTORY_CONFLICT', '工作区标识已绑定其他目录。')
        return { revision: file.revision, workspace: previous }
      }
      const slug = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '').slice(0, 60) || 'project'
      const root = requested ?? path.join(file.storage_root, 'projects', slug + '-' + input.workspace_id)
      if (within(root, this.dataRoot) || root === file.storage_root || within(path.join(file.storage_root, 'default'), root)
        || (within(this.dataRoot, root) && !within(file.storage_root, root))) throw badRequest()
      if (requested) await this.verifyDirectory(root)
      const same = file.workspaces.find(workspace => workspace.root === root)
      if (same) return { revision: file.revision, workspace: same }
      if (!requested) {
        await this.ensureDirectory(path.dirname(root))
        try { await fs.lstat(root); throw new WorkspaceError('WORKSPACE_DIRECTORY_CONFLICT', '目标目录已经存在，未覆盖内容。') }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        await this.makeDirectory(root)
      }
      const workspace: WorkspaceRecord = { workspace_id: input.workspace_id, kind: 'project', name, description,
        root, source: requested ? 'existing' : 'managed', created_at: new Date().toISOString() }
      file.workspaces.push(workspace); file.revision++
      // On an uncertain write, preserve the new directory rather than deleting possible user work.
      await this.write(file)
      return { revision: file.revision, workspace }
    })
  }

  async update(id: string, input: WorkspaceUpdateRequest): Promise<WorkspaceRecordResult> {
    if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1) throw badRequest()
    const name = text(input.name, 120), description = text(input.description, 2000, true)
    return this.lock(async () => {
      const file = await this.required()
      if (file.revision !== input.expected_revision) throw new WorkspaceError('WORKSPACE_REVISION_CONFLICT', '工作区已更新，请保留草稿并重新读取。')
      const previous = file.workspaces.find(workspace => workspace.workspace_id === id)
      if (!previous) throw new WorkspaceError('WORKSPACE_NOT_FOUND', '工作区不存在。')
      const workspace = { ...previous, name, description }
      file.workspaces = file.workspaces.map(item => item.workspace_id === id ? workspace : item)
      file.revision++; await this.write(file)
      return { revision: file.revision, workspace }
    })
  }

  /** Catalog CAS only. The fixed caller must verify its original job, published files and closures at every callback. */
  async commitRelocation(expected: WorkspaceCatalogSnapshot, target: string, verify: () => Promise<unknown>): Promise<{ dispatch: 'dispatch' | 'observe'; snapshot: WorkspaceCatalogSnapshot }> {
    // Storage version is internal; a typed catalog snapshot need not expose it.
    const original = { version: 1, ...structuredClone(expected) }
    if (typeof verify !== 'function') throw badRequest()
    if (directoryPath(target) !== target) throw badRequest()
    if (this.explicitRoot && this.explicitRoot !== target) throw new WorkspaceError('WORKSPACE_DIRECTORY_CONFLICT', '显式工作区环境与新位置冲突，未更改环境或目录选择。')
    const projected = projectWorkspaceCatalogRelocation(original, target), beforeHash = sha256CanonicalJson(original), afterHash = sha256CanonicalJson(projected)
    return this.lock(async () => {
      await verify()
      const current = await this.required(), currentHash = sha256CanonicalJson(current)
      if (currentHash !== beforeHash && currentHash !== afterHash) throw new WorkspaceError('WORKSPACE_REVISION_CONFLICT', '原工作区登记发生变化，未覆盖更新。')
      const directories = [...new Set([target, ...projected.workspaces.filter(record => within(target, record.root)).map(record => record.root)])]
      const frames = directories.map(directory => ({ directory, stat: lstatSync(directory, { bigint: true }) }))
      const verifyDirectories = () => {
        for (const frame of frames) {
          const stat = lstatSync(frame.directory, { bigint: true })
          if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== frame.stat.dev || stat.ino !== frame.stat.ino
            || realpathSync.native(frame.directory) !== frame.directory) throw invalid()
        }
      }
      verifyDirectories()
      await verify(); verifyDirectories()
      const dispatch = currentHash === afterHash ? 'observe' as const : 'dispatch' as const
      if (dispatch === 'dispatch') await this.write({ ...projected, version: 1 }, async () => { await verify(); verifyDirectories() })
      await verify(); verifyDirectories()
      const accepted = await this.required()
      if (sha256CanonicalJson(accepted) !== afterHash) throw invalid()
      await verify(); verifyDirectories()
      return { dispatch, snapshot: accepted }
    })
  }

  async markUsed(id: string, at: string): Promise<void> {
    if (!Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at) throw badRequest()
    await this.lock(async () => {
      const file = await this.required(), record = file.workspaces.find(item => item.workspace_id === id)
      if (!record) throw new WorkspaceError('WORKSPACE_NOT_FOUND', '工作区不存在。')
      if (record.last_used_at && Date.parse(record.last_used_at) >= Date.parse(at)) return
      record.last_used_at = at
      file.revision++; await this.write(file)
    })
  }

  async resolveProject(id: string): Promise<WorkspaceRecord> {
    const record = await this.get(id)
    if (record.kind !== 'project') throw badRequest()
    await this.verifyDirectory(record.root)
    return record
  }

  async resolveDefaultTask(taskId: string): Promise<{ workspace_id: string; root: string }> {
    if (!taskId || taskId === '.' || taskId === '..' || /[\\/\0]/.test(taskId)) throw badRequest()
    await this.initialize()
    const workspace = await this.get('default'), root = path.join(workspace.root, 'tasks', taskId)
    await this.verifyDirectory(workspace.root)
    await this.ensureDirectory(root)
    return { workspace_id: workspace.workspace_id, root }
  }

  private async verifyDirectory(directory: string): Promise<void> {
    try {
      const stat = await fs.lstat(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory) throw invalid()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new WorkspaceError('WORKSPACE_DIRECTORY_MISSING', '项目目录不存在，未创建空目录或改用默认工作区。')
      throw error
    }
  }

  private async makeDirectory(directory: string): Promise<void> {
    if (process.platform === 'win32') this.options.files.createPrivateDirectory(directory)
    else await fs.mkdir(directory, { mode: 0o700 })
  }
  private async ensureDirectory(directory: string): Promise<void> {
    try { await this.verifyDirectory(directory) }
    catch (error) {
      if (!(error instanceof WorkspaceError) || error.code !== 'WORKSPACE_DIRECTORY_MISSING') throw error
      await this.ensureDirectory(path.dirname(directory))
      try { await this.makeDirectory(directory) }
      catch (race) {
        try { await this.verifyDirectory(directory) } catch { throw race }
      }
      await this.verifyDirectory(directory)
    }
  }
  private async privateDirectory(): Promise<boolean> {
    let stat
    try { stat = await fs.lstat(this.control) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform === 'win32' ? !this.options.files.isPrivateDirectory(this.control)
      : stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o700)) throw invalid()
    return true
  }
  private async readPrivate(file: string): Promise<string | undefined> {
    let stat
    try { stat = await fs.lstat(file) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (process.platform === 'win32' ? !this.options.files.isPrivateFile(file)
      : stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o600) || stat.size > 16 * 1024 * 1024) throw invalid()
    return fs.readFile(file, 'utf8')
  }
  private async read(): Promise<CatalogFile | undefined> {
    if (!await this.privateDirectory()) return undefined
    try { await this.verifyDirectory(this.dataRoot) } catch { throw invalid() }
    const raw = await this.readPrivate(this.file)
    if (raw === undefined) {
      if (await this.readPrivate(path.join(this.control, 'catalog.ready')) !== undefined) throw invalid()
      return undefined
    }
    try {
      const file = JSON.parse(raw) as CatalogFile
      if (file.version !== 1 || !Number.isSafeInteger(file.revision) || file.revision < 1 || !Array.isArray(file.workspaces)
        || !path.isAbsolute(file.storage_root) || (this.explicitRoot && this.explicitRoot !== file.storage_root)) throw invalid()
      const ids = new Set<string>(), roots = new Set<string>()
      for (const record of file.workspaces) {
        if (!record || (record.workspace_id !== 'default' && !uuid.test(record.workspace_id)) || ids.has(record.workspace_id) || roots.has(record.root)
          || !['project', 'default'].includes(record.kind) || !['managed', 'existing'].includes(record.source)
          || !path.isAbsolute(record.root) || text(record.name, 120) !== record.name || text(record.description, 2000, true) !== record.description
          || (record.last_used_at !== undefined && (typeof record.last_used_at !== 'string' || !Number.isFinite(Date.parse(record.last_used_at))))
          || !Number.isFinite(Date.parse(record.created_at)) || ((record.kind === 'default') !== (record.workspace_id === 'default'))
          || (record.kind === 'default' && record.root !== path.join(file.storage_root, 'default'))) throw invalid()
        ids.add(record.workspace_id); roots.add(record.root)
      }
      if (!ids.has('default')) throw invalid()
      return file
    } catch { throw invalid() }
  }
  private async required(): Promise<CatalogFile> {
    const file = await this.read()
    if (!file) throw invalid()
    return file
  }
  private async writePrivate(file: string, content: string): Promise<void> {
    if (process.platform === 'win32') {
      this.options.files.writePrivateFile(file, '')
      await fs.writeFile(file, content, { flag: 'r+' })
    } else await fs.writeFile(file, content, { flag: 'wx', mode: 0o600 })
  }
  private async write(file: CatalogFile, beforeCommit?: () => Promise<unknown>): Promise<void> {
    const content = JSON.stringify(file) + '\n'
    if (Buffer.byteLength(content) > 16 * 1024 * 1024) throw new WorkspaceError('WORKSPACE_LIMIT', '工作区记录已达到安全大小上限，未覆盖原记录。')
    const temporary = path.join(this.control, '.catalog-' + randomUUID())
    try {
      await this.writePrivate(temporary, content)
      const handle = await fs.open(temporary, 'r+')
      try { await handle.sync() } finally { await handle.close() }
      if (beforeCommit) await beforeCommit()
      await fs.rename(temporary, this.file)
      if (await this.readPrivate(path.join(this.control, 'catalog.ready')) === undefined) {
        const marker = path.join(this.control, 'catalog.ready')
        await this.writePrivate(marker, 'workspace-catalog-v1\n')
        const handle = await fs.open(marker, 'r+')
        try { await handle.sync() } finally { await handle.close() }
      }
      if (process.platform !== 'win32') {
        const handle = await fs.open(this.control, 'r')
        try { await handle.sync() } finally { await handle.close() }
      }
    } finally { await fs.rm(temporary, { force: true }) }
  }
  private async lock<T>(action: () => Promise<T>): Promise<T> {
    await this.verifyDirectory(this.dataRoot)
    if (!await this.privateDirectory()) {
      try { await this.makeDirectory(this.control) }
      catch (error) { if (!await this.privateDirectory()) throw error }
    }
    await this.privateDirectory()
    const file = path.join(this.control, 'catalog.lock'), deadline = Date.now() + 5000
    let handle: unknown
    while (!handle) {
      if (!held.has(file)) handle = this.options.files.tryFileLock(file, JSON.stringify({ pid: process.pid, purpose: 'workspace-catalog' }))
      if (handle) { held.add(file); break }
      if (Date.now() >= deadline) throw new WorkspaceError('WORKSPACE_BUSY', '工作区正在更新，请稍候重试。')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    try { return await action() }
    finally { this.options.files.releaseFileLock(handle); held.delete(file) }
  }
}
