import fs from 'node:fs/promises'
import { constants, type BigIntStats } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { WorkspaceError } from './workspace-catalog.js'
import { inspectWorkspaceRelocationTree } from './workspace-relocation-files.js'

const within = (root: string, item: string) => { const relative = path.relative(root, item); return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) }
const unchanged = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && a.mode === b.mode && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
const unverified = () => new WorkspaceError('WORKSPACE_COPY_UNVERIFIED', '工作区副本内容或目录关系未通过核验，原文件保留；未授权切换或清理。')

async function digest(file: string, expected: BigIntStats, check: () => void): Promise<string> {
  check()
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || !unchanged(expected, opened)) throw unverified()
    const hash = createHash('sha256')
    for await (const chunk of handle.createReadStream({ autoClose: false })) { check(); hash.update(chunk) }
    check()
    if (!unchanged(opened, await handle.stat({ bigint: true })) || !unchanged(opened, await fs.lstat(file, { bigint: true }))) throw unverified()
    return hash.digest('hex')
  } finally { await handle.close() }
}
function linkGroup(groups: Map<string, string>, stat: BigIntStats, relative: string): string {
  if (stat.nlink === 1n) return relative
  const identity = stat.dev + ':' + stat.ino
  const group = groups.get(identity) ?? relative
  groups.set(identity, group)
  return group
}

/** Read-only post-copy content proof. This neither proves execution stopped nor commits a location or verifies ACL/xattr preservation. */
export async function verifyWorkspaceRelocationContent(source: string, target: string, options: { signal?: AbortSignal } = {}) {
  const check = () => { if (options.signal?.aborted) throw new WorkspaceError('WORKSPACE_SCAN_CANCELLED', '工作区内容核验已取消，原文件保留。') }
  check()
  if (within(source, target) || within(target, source)) throw unverified()
  const beforeSource = await inspectWorkspaceRelocationTree(source, 'copy', options)
  const beforeTarget = await inspectWorkspaceRelocationTree(target, 'copy', options)
  if (beforeSource.issues.length || beforeTarget.issues.length) throw unverified()
  const sourceLinks = new Map<string, string>(), targetLinks = new Map<string, string>()
  let files = 0, bytes = 0n

  async function visit(relative: string): Promise<void> {
    check()
    const left = path.join(source, relative), right = path.join(target, relative)
    const a = await fs.lstat(left, { bigint: true }), b = await fs.lstat(right, { bigint: true })
    if (a.isSymbolicLink() || b.isSymbolicLink()) {
      if (!a.isSymbolicLink() || !b.isSymbolicLink() || path.normalize(await fs.readlink(left)) !== path.normalize(await fs.readlink(right))) throw unverified()
    } else if (a.isDirectory() && b.isDirectory()) {
      if (await fs.realpath(left) !== left || await fs.realpath(right) !== right) throw unverified()
      const leftNames = (await fs.readdir(left)).sort(), rightNames = (await fs.readdir(right)).sort()
      if (JSON.stringify(leftNames) !== JSON.stringify(rightNames)) throw unverified()
      for (const name of leftNames) await visit(path.join(relative, name))
    } else if (a.isFile() && b.isFile()) {
      if (a.size !== b.size || linkGroup(sourceLinks, a, relative) !== linkGroup(targetLinks, b, relative)) throw unverified()
      if (await digest(left, a, check) !== await digest(right, b, check)) throw unverified()
      files++; bytes += a.size
    } else throw unverified()
    if (!unchanged(a, await fs.lstat(left, { bigint: true })) || !unchanged(b, await fs.lstat(right, { bigint: true }))) throw unverified()
  }
  await visit('')
  check()
  const afterSource = await inspectWorkspaceRelocationTree(source, 'copy', options)
  const afterTarget = await inspectWorkspaceRelocationTree(target, 'copy', options)
  if (beforeSource.fingerprint !== afterSource.fingerprint || beforeTarget.fingerprint !== afterTarget.fingerprint) throw unverified()
  if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) throw new WorkspaceError('WORKSPACE_USAGE_OVERFLOW', '工作区内容大小超出可准确记录的范围。')
  return { files, verified_bytes: Number(bytes), source_fingerprint: afterSource.fingerprint, target_fingerprint: afterTarget.fingerprint }
}


/** Stable relative content only; directory identity and physical metadata remain independent proofs. */
export async function inspectWorkspaceRelocationContent(root: string, mode: 'rename' | 'copy', options: { signal?: AbortSignal } = {}) {
  const check = () => { if (options.signal?.aborted) throw new WorkspaceError('WORKSPACE_SCAN_CANCELLED', '工作区内容核验已取消，原文件保留。') }
  check()
  if (mode !== 'rename' && mode !== 'copy') throw unverified()
  const before = await inspectWorkspaceRelocationTree(root, mode, options)
  if (before.issues.length) throw unverified()
  const original = await fs.lstat(root, { bigint: true }), hash = createHash('sha256'), links = new Map<string, string>()
  let files = 0, bytes = 0n
  async function visit(relative: string): Promise<void> {
    check()
    const file = path.join(root, relative), stat = await fs.lstat(file, { bigint: true })
    if (stat.dev !== original.dev) throw unverified()
    if (stat.isSymbolicLink()) hash.update(JSON.stringify(['link', relative, await fs.readlink(file)]) + '\n')
    else if (stat.isDirectory()) {
      if (await fs.realpath(file) !== file) throw unverified()
      const names = (await fs.readdir(file)).sort()
      hash.update(JSON.stringify(['directory', relative, names]) + '\n')
      for (const name of names) await visit(path.join(relative, name))
    } else if (stat.isFile()) {
      hash.update(JSON.stringify(['file', relative, stat.size.toString(), linkGroup(links, stat, relative), await digest(file, stat, check)]) + '\n')
      files++; bytes += stat.size
    } else throw unverified()
    if (!unchanged(stat, await fs.lstat(file, { bigint: true }))) throw unverified()
  }
  await visit(''); check()
  const after = await inspectWorkspaceRelocationTree(root, mode, options)
  if (before.fingerprint !== after.fingerprint || !unchanged(original, await fs.lstat(root, { bigint: true }))) throw unverified()
  if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) throw new WorkspaceError('WORKSPACE_USAGE_OVERFLOW', '工作区内容大小超出可准确记录的范围。')
  return { fingerprint: hash.digest('hex'), files, verified_bytes: Number(bytes), tree_fingerprint: after.fingerprint }
}
