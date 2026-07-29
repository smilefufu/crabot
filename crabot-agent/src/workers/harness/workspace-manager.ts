import path from 'node:path'
import { promises as fs } from 'node:fs'
import { getWorkspacesRootDir } from '../../core/data-paths.js'
import { InvalidWorkspaceError } from '../errors.js'
import type { Workspace } from '../types.js'

export { InvalidWorkspaceError }

export class WorkspaceManager {
  private root: string

  constructor(root?: string) {
    this.root = root ?? getWorkspacesRootDir()
  }

  /**
   * 解析和验证 workspace。
   *
   * @param taskId 当前 task 的 ID（用于防串台检查）
   * @param requested workspace 路径。如果未指定，则自动创建 <root>/<taskId>
   * @returns 验证后的 Workspace
   * @throws InvalidWorkspaceError 验证失败时
   */
  async resolve(taskId: string, requested?: string): Promise<Workspace> {
    if (requested === undefined) {
      // 缺省：创建 <root>/<taskId> 并返回
      const defaultPath = path.resolve(this.root, taskId)
      await fs.mkdir(defaultPath, { recursive: true })
      return { root: defaultPath }
    }

    // 验证 requested 路径
    return this._validateAndResolve(taskId, requested)
  }

  private async _validateAndResolve(taskId: string, requested: string): Promise<Workspace> {
    // 检查 null byte
    if (requested.includes('\0')) {
      throw new InvalidWorkspaceError('path contains null byte')
    }

    // 检查是否为绝对路径
    if (!path.isAbsolute(requested)) {
      throw new InvalidWorkspaceError(`path must be absolute, got: ${requested}`)
    }

    // 检查路径是否存在且是目录
    let stat
    try {
      stat = await fs.stat(requested)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new InvalidWorkspaceError(`path does not exist: ${requested}`)
      }
      throw new InvalidWorkspaceError(`failed to stat path: ${(err as Error).message}`)
    }

    if (!stat.isDirectory()) {
      throw new InvalidWorkspaceError(`path is not a directory: ${requested}`)
    }

    // 防串台检查：确保不落在其他 taskId 的目录内
    this._checkTaskIdBoundary(taskId, requested)

    return { root: requested }
  }

  /**
   * 检查 requested 路径是否违反 task 边界。
   * 允许：<root>/<taskId> 及其子目录
   * 拒绝：<root>/<其他 taskId> 及其子目录
   */
  private _checkTaskIdBoundary(taskId: string, requestedPath: string): void {
    const resolved = path.resolve(requestedPath)
    const rootResolved = path.resolve(this.root)

    // 检查是否在 <root> 内
    const relative = path.relative(rootResolved, resolved)
    if (relative.startsWith('..')) {
      // 在 root 外面，允许
      return
    }

    // 在 root 内，检查是否属于当前 taskId
    const pathParts = relative.split(path.sep).filter((p) => p.length > 0)
    if (pathParts.length === 0) {
      // 路径指向 root 本身，拒绝
      throw new InvalidWorkspaceError(`path must not be the workspaces root: ${requestedPath}`)
    }

    const topLevelTaskId = pathParts[0]
    if (topLevelTaskId !== taskId) {
      // 指向其他 taskId 的目录
      throw new InvalidWorkspaceError(
        `path must not reference other task workspace (expected under ${taskId}, got ${topLevelTaskId}): ${requestedPath}`
      )
    }
  }
}
