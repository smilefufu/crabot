import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import native from './process-identity.cjs'

const same = (a, b) => ['dev', 'ino', 'mode', 'uid', 'gid', 'size', 'nlink', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key])
const unverified = () => Object.assign(new Error('无法完整核实工作区文件权限、扩展属性或附加数据流；未授权移动或清理。'), { code: 'CRABOT_FILE_METADATA' })

/** Read-only, per-entry proof. Default file content, execution exit and whole-tree consistency are separate checks. */
export async function inspectWorkspaceFileMetadata(file, { signal } = {}) {
  const check = () => {
    if (signal?.aborted) throw Object.assign(new Error('工作区元数据核验已取消，原文件保留。'), { code: 'CRABOT_FILE_METADATA_CANCELLED' })
  }
  check()
  const before = await fs.lstat(file, { bigint: true }), first = native.inspectFileMetadata(file)
  const valid = value => value && Buffer.isBuffer(value.metadata) && Array.isArray(value.streams)
    && value.streams.every(name => typeof name === 'string' && /^:[^/\\:\0]+$/u.test(name))
    && Array.isArray(value.copy_blockers) && value.copy_blockers.every(item => ['immutable_or_append', 'system_file_flags', 'linux_file_flags', 'windows_access_policy'].includes(item))
    && new Set(value.streams).size === value.streams.length
    && (process.platform === 'win32' || value.streams.length === 0)
  if (!valid(first)) throw unverified()
  const hash = createHash('sha256').update(first.metadata).update('\n' + before.mtimeNs + '\n')
  for (const stream of first.streams) {
    check()
    const handle = await fs.open(file + stream, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const opened = await handle.stat({ bigint: true }), digest = createHash('sha256')
      if (!opened.isFile()) throw unverified()
      let bytes = 0n
      for await (const chunk of handle.createReadStream({ autoClose: false })) { check(); bytes += BigInt(chunk.length); digest.update(chunk) }
      check()
      if (bytes !== opened.size || !same(opened, await handle.stat({ bigint: true }))) throw unverified()
      hash.update(JSON.stringify([stream, bytes.toString(), digest.digest('hex')]) + '\n')
    } finally { await handle.close() }
  }
  check()
  const last = native.inspectFileMetadata(file), after = await fs.lstat(file, { bigint: true })
  if (!valid(last) || !same(before, after) || !first.metadata.equals(last.metadata)
    || JSON.stringify(first.streams) !== JSON.stringify(last.streams) || JSON.stringify(first.copy_blockers) !== JSON.stringify(last.copy_blockers)) throw unverified()
  return { fingerprint: hash.digest('hex'), named_streams: first.streams.length, copy_blockers: first.copy_blockers }
}

/** Content plus owner, access ACL, attributes and named-stream checks; it does not create files or permit closing Workers, selecting a root or deleting a source. */
export async function verifyWorkspaceRelocationCopy(source, target, { signal } = {}) {
  const { verifyWorkspaceRelocationContent } = await import('../../crabot-shared/dist/workspace-relocation-content.js')
  const { inspectWorkspaceRelocationTree } = await import('../../crabot-shared/dist/workspace-relocation-files.js')
  const path = await import('node:path')
  const content = await verifyWorkspaceRelocationContent(source, target, { signal })
  const hash = createHash('sha256'); let entries = 0
  async function visit(relative) {
    const left = path.join(source, relative), right = path.join(target, relative)
    const a = await inspectWorkspaceFileMetadata(left, { signal }), b = await inspectWorkspaceFileMetadata(right, { signal })
    if (a.fingerprint !== b.fingerprint) throw unverified()
    hash.update(JSON.stringify([relative, a.fingerprint]) + '\n'); entries++
    if ((await fs.lstat(left)).isDirectory()) {
      const leftNames = (await fs.readdir(left)).sort(), rightNames = (await fs.readdir(right)).sort()
      if (JSON.stringify(leftNames) !== JSON.stringify(rightNames)) throw unverified()
      for (const name of leftNames) await visit(path.join(relative, name))
    }
  }
  await visit('')
  const a = await inspectWorkspaceRelocationTree(source, 'copy', { signal }), b = await inspectWorkspaceRelocationTree(target, 'copy', { signal })
  if (a.issues.length || b.issues.length || a.fingerprint !== content.source_fingerprint || b.fingerprint !== content.target_fingerprint) throw unverified()
  return { ...content, metadata_entries: entries, metadata_fingerprint: hash.digest('hex') }
}
