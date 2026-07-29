import path from 'node:path'
import { promises as fs } from 'node:fs'
import { getWorkspacesRootDir } from '../../core/data-paths.js'
import type { Workspace } from '../types.js'

/** Raised when workspace validation fails. */
export class InvalidWorkspaceError extends Error {
  constructor(
    readonly reason: string,
  ) {
    super(`invalid workspace: ${reason}`)
    this.name = 'InvalidWorkspaceError'
  }
}

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

    // 检查路径是否存在，并解析出真实路径（消解符号链接，防止软链绕过边界校验）
    let realRequested: string
    try {
      realRequested = await fs.realpath(requested)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new InvalidWorkspaceError(`path does not exist: ${requested}`)
      }
      throw new InvalidWorkspaceError(`failed to stat path: ${(err as Error).message}`)
    }

    // 检查是否是目录（基于真实路径，与边界判断保持一致）
    let stat
    try {
      stat = await fs.stat(realRequested)
    } catch (err) {
      throw new InvalidWorkspaceError(`failed to stat path: ${(err as Error).message}`)
    }

    if (!stat.isDirectory()) {
      throw new InvalidWorkspaceError(`path is not a directory: ${requested}`)
    }

    // 防串台检查：确保不落在其他 taskId 的目录内（基于真实路径，防止软链绕过）
    await this._checkTaskIdBoundary(taskId, realRequested, requested)

    return { root: realRequested }
  }

  /**
   * 检查 requested 路径是否违反 task 边界。
   * 允许：<root>/<taskId> 及其子目录
   * 拒绝：<root>/<其他 taskId> 及其子目录
   *
   * @param realRequestedPath 已经过 fs.realpath 解析的真实路径
   * @param originalRequested 原始请求路径（仅用于错误信息展示）
   */
  private async _checkTaskIdBoundary(
    taskId: string,
    realRequestedPath: string,
    originalRequested: string,
  ): Promise<void> {
    // root 本身也可能是符号链接（如 macOS /tmp），两侧都需 realpath 后再比较，
    // 否则会产生假阳性（合法路径被误拒）。root 尚不存在时退化为字符串规范化。
    let realRoot: string
    try {
      realRoot = await fs.realpath(this.root)
    } catch {
      realRoot = path.resolve(this.root)
    }

    // 检查是否在 <root> 内
    const relative = path.relative(realRoot, realRequestedPath)
    if (relative.startsWith('..')) {
      // 在 root 外面，允许
      return
    }

    // 在 root 内，检查是否属于当前 taskId
    const pathParts = relative.split(path.sep).filter((p) => p.length > 0)
    if (pathParts.length === 0) {
      // 路径指向 root 本身，拒绝
      throw new InvalidWorkspaceError(`path must not be the workspaces root: ${originalRequested}`)
    }

    const topLevelTaskId = pathParts[0]
    if (topLevelTaskId !== taskId) {
      // 指向其他 taskId 的目录
      throw new InvalidWorkspaceError(
        `path must not reference other task workspace (expected under ${taskId}, got ${topLevelTaskId}): ${originalRequested}`
      )
    }
  }
}
