import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { WorkspaceError } from './workspace-catalog.js'
import { workspaceMountBoundary } from './workspace-mounts.js'

type BindingIssue = 'absolute_link' | 'external_link' | 'git_worktree' | 'python_environment' | 'external_hardlink' | 'mount_point' | 'special_file' | 'unreadable'
interface RelocationInspection {
  root: string
  fingerprint: string
  files: number
  links: number
  issues: Array<{ path: string; reason: BindingIssue }>
}
const within = (root: string, item: string) => { const relative = path.relative(root, item); return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) }
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
const stale = () => new WorkspaceError('WORKSPACE_SCAN_STALE', '工作区目录在检查期间变化，请重新预检；未搬动文件。')

/** Known relocation blockers only. This observation never authorizes a move or proves execution stopped. */
export async function inspectWorkspaceRelocationTree(root: string, mode: 'rename' | 'copy', options: { signal?: AbortSignal } = {}): Promise<RelocationInspection> {
  const check = () => { if (options.signal?.aborted) throw new WorkspaceError('WORKSPACE_SCAN_CANCELLED', '工作区迁移检查已取消，原文件保留。') }
  check()
  const original = await fs.lstat(root, { bigint: true })
  if (!original.isDirectory() || original.isSymbolicLink() || !original.ino || await fs.realpath(root) !== root) throw stale()
  const mounts = await workspaceMountBoundary([root]), hash = createHash('sha256')
  const result: RelocationInspection = { root, fingerprint: '', files: 0, links: 0, issues: [] }
  const hardlinks = new Map<string, { path: string; expected: bigint; count: bigint }>()
  const issue = (relative: string, reason: BindingIssue) => result.issues.push({ path: relative, reason })
  const metadata = (relative: string, stat: BigIntStats, link?: string) => hash.update(JSON.stringify([relative, stat.dev.toString(), stat.ino.toString(),
    stat.mode.toString(), stat.uid.toString(), stat.gid.toString(), stat.nlink.toString(), stat.size.toString(), stat.mtimeNs.toString(), stat.ctimeNs.toString(), link ?? null]) + '\n')
  async function inspect(directory: string, relative: string, before: BigIntStats): Promise<void> {
    check()
    if (await fs.realpath(directory) !== directory) throw stale()
    metadata(relative, before)
    let entries
    try { entries = await fs.readdir(directory, { withFileTypes: true }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EACCES' && (error as NodeJS.ErrnoException).code !== 'EPERM') throw error
      issue(relative, 'unreadable'); return
    }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    for (const entry of entries) {
      check()
      const file = path.join(directory, entry.name), rel = relative ? relative + '/' + entry.name : entry.name
      if (mounts.points.has(file)) { issue(rel, 'mount_point'); continue }
      const stat = await fs.lstat(file, { bigint: true })
      if (stat.isSymbolicLink()) {
        const link = await fs.readlink(file)
        metadata(rel, stat, link); result.links++
        if (path.isAbsolute(link)) issue(rel, 'absolute_link')
        else if (!within(root, path.resolve(directory, link))) issue(rel, 'external_link')
        if (!same(stat, await fs.lstat(file, { bigint: true }))) throw stale()
        continue
      }
      if (stat.dev !== original.dev) { issue(rel, 'mount_point'); continue }
      if (!stat.ino) throw new WorkspaceError('WORKSPACE_IDENTITY_UNAVAILABLE', '无法核实工作区文件身份，未搬动文件。')
      if (stat.isDirectory()) {
        if (entry.name === 'worktrees' && path.basename(directory) === '.git' && (await fs.readdir(file)).length) issue(rel, 'git_worktree')
        await inspect(file, rel, stat)
      } else {
        metadata(rel, stat)
        if (!stat.isFile()) { issue(rel, 'special_file'); continue }
        result.files++
        if (entry.name === 'pyvenv.cfg') issue(rel, 'python_environment')
        if (entry.name === '.git' || (entry.name === 'commondir' && path.basename(directory) === '.git')) issue(rel, 'git_worktree')
        if (mode === 'copy' && stat.nlink > 1n) {
          const key = stat.dev + ':' + stat.ino, group = hardlinks.get(key)
          if (group) { if (group.expected !== stat.nlink) throw stale(); group.count++ }
          else hardlinks.set(key, { path: rel, expected: stat.nlink, count: 1n })
        }
      }
    }
    if (!same(before, await fs.lstat(directory, { bigint: true })) || await fs.realpath(directory) !== directory) throw stale()
  }
  await inspect(root, '', original)
  check()
  if (!same(original, await fs.lstat(root, { bigint: true })) || await fs.realpath(root) !== root) throw stale()
  if ((await workspaceMountBoundary([root])).signature !== mounts.signature) throw stale()
  for (const group of hardlinks.values()) if (group.count !== group.expected) issue(group.path, 'external_hardlink')
  result.fingerprint = hash.update(mounts.signature).digest('hex')
  return result
}
