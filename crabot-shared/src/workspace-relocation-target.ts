import fs from 'node:fs/promises'
import path from 'node:path'
import { WorkspaceError } from './workspace-catalog.js'
import { inspectWorkspaceRelocationTree } from './workspace-relocation-files.js'
import { scanWorkspaceUsage } from './workspace-usage.js'

const within = (root: string, item: string) => { const relative = path.relative(root, item); return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) }
const invalid = () => new WorkspaceError('WORKSPACE_INVALID_REQUEST', '工作区迁移位置不符合要求：不能重叠、使用目录链接或进入程序及私有状态目录。')
const stale = () => new WorkspaceError('WORKSPACE_SCAN_STALE', '工作区或目标目录在预检期间变化，请重新预检；未停止执行或搬动文件。')

async function optionalStat(file: string) {
  try { return await fs.lstat(file, { bigint: true }) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
async function canonicalLocation(directory: string): Promise<string> {
  try { return await fs.realpath(directory) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = path.dirname(directory)
    if (parent === directory) throw error
    return path.join(await canonicalLocation(parent), path.basename(directory))
  }
}
async function assertEmpty(directory: string): Promise<void> {
  const handle = await fs.opendir(directory)
  try { if (await handle.read()) throw new WorkspaceError('WORKSPACE_DIRECTORY_CONFLICT', '迁移目标目录不是空目录，未覆盖或清理已有内容。') }
  finally { await handle.close() }
}

/** Host-supplied private roots are exclusions, never caller-granted permissions. A preview does not authorize stopping or moving. */
export async function inspectWorkspaceRelocationTarget(source: string, target: string, options: { protectedRoots: readonly string[]; signal?: AbortSignal }) {
  const check = () => { if (options.signal?.aborted) throw new WorkspaceError('WORKSPACE_SCAN_CANCELLED', '工作区预检已取消，原目录保留。') }
  const validPath = (value: string) => { if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw invalid(); return path.resolve(value) }
  check()
  source = validPath(source); target = validPath(target)
  const original = await fs.lstat(source, { bigint: true })
  if (!original.isDirectory() || original.isSymbolicLink() || !original.ino || await fs.realpath(source) !== source) throw invalid()
  const selected = await optionalStat(target)
  if (selected && (!selected.isDirectory() || selected.isSymbolicLink())) throw invalid()
  target = await canonicalLocation(target)
  if (source === target) return { mode: 'unchanged' as const, source, target }
  if (within(source, target) || within(target, source)) throw invalid()
  for (const root of options.protectedRoots) {
    const protectedRoot = await canonicalLocation(validPath(root))
    if (within(protectedRoot, source) || within(source, protectedRoot) || within(protectedRoot, target) || within(target, protectedRoot)) throw invalid()
  }
  if (selected) await assertEmpty(target)
  let parent = selected ? target : path.dirname(target), parentStat = await optionalStat(parent)
  while (!parentStat) {
    const next = path.dirname(parent)
    if (next === parent) throw invalid()
    parent = next; parentStat = await optionalStat(parent)
  }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || !parentStat.ino || await fs.realpath(parent) !== parent) throw invalid()
  const mode = original.dev === parentStat.dev ? 'rename' as const : 'copy' as const
  const inspection = await inspectWorkspaceRelocationTree(source, mode, options)
  const usage = await scanWorkspaceUsage(source, options)
  const space = await fs.statfs(parent, { bigint: true })
  if (space.bsize <= 0n || space.bavail < 0n) throw new WorkspaceError('WORKSPACE_UNAVAILABLE', '无法核实目标可用空间，未开始迁移。')
  check()
  const finalSource = await fs.lstat(source, { bigint: true })
  const finalParent = await fs.lstat(parent, { bigint: true }), finalTarget = await optionalStat(target)
  if (original.dev !== finalSource.dev || original.ino !== finalSource.ino || finalSource.isSymbolicLink() || await fs.realpath(source) !== source
    || parentStat.dev !== finalParent.dev || parentStat.ino !== finalParent.ino || finalParent.isSymbolicLink() || await fs.realpath(parent) !== parent
    || await canonicalLocation(target) !== target || !!selected !== !!finalTarget
    || selected && finalTarget && (selected.dev !== finalTarget.dev || selected.ino !== finalTarget.ino || finalTarget.isSymbolicLink())) throw stale()
  if (finalTarget) await assertEmpty(target)
  if ((await inspectWorkspaceRelocationTree(source, mode, options)).fingerprint !== inspection.fingerprint) throw stale()
  const identity = (directory: string, stat: typeof original) => ({ path: directory, dev: stat.dev.toString(), ino: stat.ino.toString() })
  return { mode, source, target, target_exists: !!selected, available_bytes: space.bsize * space.bavail, usage, inspection,
    source_identity: identity(source, finalSource), target_identity: finalTarget ? identity(target, finalTarget) : null,
    target_ancestor: identity(parent, finalParent) }
}
