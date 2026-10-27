import fs from 'node:fs/promises'
import path from 'node:path'
import type { BigIntStats } from 'node:fs'
import type { WorkspaceUsage } from './workspace-types.js'
import { WorkspaceError } from './workspace-catalog.js'
import { workspaceMountBoundary } from './workspace-mounts.js'

const same = (left: BigIntStats, right: BigIntStats) => left.dev === right.dev && left.ino === right.ino
const within = (root: string, item: string) => { const relative = path.relative(root, item); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) }

export function scanWorkspaceUsage(directory: string, options: { signal?: AbortSignal } = {}): Promise<WorkspaceUsage> {
  return scanWorkspaceSetUsage([directory], options)
}

/** Metadata-only union: overlapping directories and cross-project hard links are counted once. */
export async function scanWorkspaceSetUsage(directories: readonly string[], options: { signal?: AbortSignal } = {}): Promise<WorkspaceUsage> {
  const checkCancelled = () => { if (options.signal?.aborted) throw new WorkspaceError('WORKSPACE_SCAN_CANCELLED', '工作区统计已取消。') }
  const roots = new Map<string, BigIntStats>()
  let logical = 0n, allocated = 0n, files = 0, skipped = 0, firstError: unknown
  checkCancelled()
  for (const directory of directories) {
    checkCancelled()
    try {
      const selected = await fs.lstat(directory, { bigint: true }), root = await fs.realpath(directory)
      if (selected.isSymbolicLink() || root !== path.resolve(directory)) throw new WorkspaceError('WORKSPACE_SCAN_STALE', '工作区目录已变化，请重新统计。')
      if (!selected.isDirectory()) throw new WorkspaceError('WORKSPACE_INVALID_REQUEST', '工作区不是普通目录。')
      if (selected.ino === 0n) throw new WorkspaceError('WORKSPACE_IDENTITY_UNAVAILABLE', '无法核实工作区目录身份，未发布成功统计。')
      roots.set(root, selected)
    } catch (error) {
      if (error instanceof WorkspaceError) throw error
      firstError ??= error; skipped++
    }
  }
  if (directories.length && !roots.size) {
    if ((firstError as NodeJS.ErrnoException)?.code === 'ENOENT') throw new WorkspaceError('WORKSPACE_DIRECTORY_MISSING', '工作区目录不存在。')
    throw firstError
  }
  const mounts = await workspaceMountBoundary([...roots.keys()])
  const allocationKnown = process.platform !== 'win32', visited = new Set<string>()
  const add = (stat: BigIntStats) => {
    // Ordinary files have one link and cannot alias another traversed directory entry.
    // Retain identities only for directories and actual hard links, rather than every file.
    if (stat.isDirectory() || stat.nlink > 1n) {
      const key = stat.dev + ':' + stat.ino
      if (visited.has(key)) return false
      visited.add(key)
    }
    if (allocationKnown) allocated += stat.blocks * 512n
    return true
  }
  for (const [root, original] of roots) {
    const pending = [root]
    while (pending.length) {
      checkCancelled()
      const current = pending.pop()!
      let before: BigIntStats
      try {
        if (current !== root && mounts.points.has(current)) { skipped++; continue }
        before = await fs.lstat(current, { bigint: true })
        if (!before.isDirectory() || before.isSymbolicLink() || before.dev !== original.dev || !within(root, await fs.realpath(current))) { skipped++; continue }
        if (!add(before)) continue
        const handle = await fs.opendir(current)
        for await (const entry of handle) {
          checkCancelled()
          const item = path.join(current, entry.name)
          try {
            if (mounts.points.has(item)) { skipped++; continue }
            const stat = await fs.lstat(item, { bigint: true })
            if (stat.isSymbolicLink()) { add(stat); continue }
            if (stat.dev !== original.dev) { skipped++; continue }
            if (stat.isDirectory()) pending.push(item)
            else if (stat.isFile() && add(stat)) { logical += stat.size; files++ }
            else if (!stat.isFile()) skipped++
          } catch (error) {
            if (error instanceof WorkspaceError) throw error
            skipped++
          }
        }
        const after = await fs.lstat(current, { bigint: true })
        if (!same(before, after) || after.isSymbolicLink() || !within(root, await fs.realpath(current))) throw new WorkspaceError('WORKSPACE_SCAN_STALE', '工作区目录已变化，请重新统计。')
      } catch (error) {
        if (error instanceof WorkspaceError) throw error
        skipped++
      }
    }
  }
  checkCancelled()
  for (const [root, original] of roots) {
    const final = await fs.lstat(root, { bigint: true })
    if (!same(original, final) || final.isSymbolicLink() || await fs.realpath(root) !== root) throw new WorkspaceError('WORKSPACE_SCAN_STALE', '工作区目录已变化，请重新统计。')
  }
  if ((await workspaceMountBoundary([...roots.keys()])).signature !== mounts.signature) throw new WorkspaceError('WORKSPACE_SCAN_STALE', '工作区挂载范围已变化，请重新统计。')
  if (logical > BigInt(Number.MAX_SAFE_INTEGER) || allocated > BigInt(Number.MAX_SAFE_INTEGER)) throw new WorkspaceError('WORKSPACE_USAGE_OVERFLOW', '工作区大小超出可准确显示的范围。')
  return { status: skipped ? 'partial' : 'complete', measured_at: new Date().toISOString(), logical_bytes: Number(logical),
    ...(allocationKnown ? { allocated_bytes: Number(allocated) } : {}), file_count: files, skipped_entries: skipped }
}
