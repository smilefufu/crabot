import path from 'node:path'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { WorkspaceCatalog } from 'crabot-shared/dist/workspace-catalog.js'
import { getDataRootDir, getWorkspacesRootDir } from '../../core/data-paths.js'
import type { Workspace } from '../types.js'
import { isWithin, type ManagedWorkspaceScope } from '../../permissions/tool-authorization.js'

export class InvalidWorkspaceError extends Error {
  constructor(readonly reason: string) { super(`invalid workspace: ${reason}`); this.name = 'InvalidWorkspaceError' }
}

export class WorkspaceManager {
  private readonly root: string
  private readonly dataRoot: string
  private catalog?: WorkspaceCatalog

  constructor(root?: string, dataRoot?: string) {
    this.root = root ?? getWorkspacesRootDir()
    this.dataRoot = dataRoot ?? (root ? path.resolve(root, '..') : getDataRootDir())
  }
  private records(): WorkspaceCatalog {
    // Bootstrap constructs this manager without filesystem probes or allocation.
    const explicit = Boolean(process.env.WORKER_WORKSPACES_DIR) || path.resolve(this.root) !== path.resolve(this.dataRoot, 'workspaces')
    return this.catalog ??= new WorkspaceCatalog({ dataRoot: this.dataRoot, storageRoot: explicit ? this.root : undefined,
      files: require('../../../../scripts/lib/process-identity.cjs') })
  }
  private async storageRoot(): Promise<string> { return (await this.records().snapshot()).storage_root }

  /** New dispatch: identify one project, or a task directory inside the single default workspace. */
  async resolve(taskId: string, requested?: string): Promise<Workspace> {
    this.validateTaskId(taskId)
    if (requested === undefined) {
      const workspace = await this.records().resolveDefaultTask(taskId)
      await this.fileScope(taskId, workspace.root)()
      return { ...workspace, runtime_root: await this.runtimeRoot(taskId, true) }
    }
    const workspace = await this.validateRequested(taskId, requested)
    const ownDefault = await this.fileScope(taskId, workspace.root)()
    if (ownDefault) {
      await this.records().initialize()
      return { ...workspace, workspace_id: 'default', runtime_root: await this.runtimeRoot(taskId, true) }
    }
    const { workspace: project } = await this.records().createProject({ workspace_id: randomUUID(),
      name: path.basename(workspace.root) || '项目', root: workspace.root })
    return { root: project.root, workspace_id: project.workspace_id, runtime_root: await this.runtimeRoot(taskId, true) }
  }

  /** Existing ledgers keep their cwd. An established binding never creates a replacement project/profile. */
  async resolveExisting(taskId: string, requested: string, workspaceId?: string): Promise<Workspace> {
    this.validateTaskId(taskId)
    const workspace = await this.validateRequested(taskId, requested)
    if (workspaceId === undefined) { await this.fileScope(taskId, workspace.root)(); return workspace }
    if (workspaceId === 'default') {
      await this.records().get('default')
      if (!await this.fileScope(taskId, workspace.root)()) throw new InvalidWorkspaceError('default binding is not this task directory')
    } else {
      const project = await this.records().resolveProject(workspaceId)
      if (project.root !== workspace.root) throw new InvalidWorkspaceError('project binding does not match the existing cwd')
    }
    return { ...workspace, workspace_id: workspaceId, runtime_root: await this.runtimeRoot(taskId, false) }
  }

  private validateTaskId(taskId: string): void {
    if (!taskId || ['.', '..', 'default', 'projects'].includes(taskId) || taskId.includes('\0') || taskId.includes('\\') || path.basename(taskId) !== taskId) {
      throw new InvalidWorkspaceError('invalid task identity')
    }
  }

  /** Caller must establish trusted ledger/context ownership; project registration grants no file permission. */
  fileScope(taskId: string, workspaceRoot: string): ManagedWorkspaceScope {
    return async () => {
      this.validateTaskId(taskId)
      const storage = await this.storageRoot()
      const root = await fs.realpath(storage).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        return undefined
      })
      if (!root) return undefined
      const requested = path.resolve(workspaceRoot), actual = await fs.realpath(workspaceRoot)
      for (const expected of [path.join(root, 'default', 'tasks', taskId), path.join(root, taskId)]) {
        if (!isWithin(expected, requested) && !isWithin(expected, actual)) continue
        const stat = await fs.lstat(expected)
        if (!stat.isDirectory() || stat.isSymbolicLink() || !isWithin(expected, actual)) throw new InvalidWorkspaceError('default task root cannot be replaced or redirected')
        return expected
      }
      return undefined
    }
  }

  private async validateRequested(taskId: string, requested: string): Promise<Workspace> {
    if (requested.includes('\0')) throw new InvalidWorkspaceError('path contains null byte')
    if (!path.isAbsolute(requested)) throw new InvalidWorkspaceError(`path must be absolute, got: ${requested}`)
    let real: string
    try { real = await fs.realpath(requested) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new InvalidWorkspaceError(`path does not exist: ${requested}`)
      throw error
    }
    if (!(await fs.stat(real)).isDirectory()) throw new InvalidWorkspaceError(`path is not a directory: ${requested}`)
    const storage = await this.storageRoot()
    const root = await fs.realpath(storage).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return path.resolve(storage)
    })
    if (!isWithin(root, real)) return { root: real }
    const parts = path.relative(root, real).split(path.sep).filter(Boolean)
    if (!parts.length || (parts[0] === 'projects' && parts.length === 1)) throw new InvalidWorkspaceError(`path must not be the workspaces root: ${requested}`)
    if (parts[0] === 'projects' || parts[0] === taskId || (parts[0] === 'default' && parts[1] === 'tasks' && parts[2] === taskId)) return { root: real }
    throw new InvalidWorkspaceError(`path must not reference other task workspace (expected under ${taskId}, got ${parts[0]}): ${requested}`)
  }

  private async runtimeRoot(taskId: string, create: boolean): Promise<string> {
    const files = require('../../../../scripts/lib/process-identity.cjs')
    let directory = await fs.realpath(this.dataRoot)
    for (const [index, segment] of ['agent', 'worker-runtime', taskId].entries()) {
      directory = path.join(directory, segment)
      let stat = await fs.lstat(directory).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        return undefined
      })
      if (!stat) {
        if (!create) throw new InvalidWorkspaceError('private native runtime is missing; not recreated for an existing session')
        try {
          if (process.platform === 'win32') files.createPrivateDirectory(directory)
          else await fs.mkdir(directory, { mode: 0o700 })
        } catch (error) { if (!await fs.lstat(directory).catch(() => undefined)) throw error }
        stat = await fs.lstat(directory)
      }
      if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory
        || (index > 0 && (process.platform === 'win32' ? !files.isPrivateDirectory(directory)
          : stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o700))) throw new InvalidWorkspaceError('private native runtime cannot be verified')
    }
    return directory
  }
}
