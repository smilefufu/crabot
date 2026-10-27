import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import native from './process-identity.cjs'
import { workspaceMetadataWithoutSecurity } from './workspace-windows-metadata.mjs'

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
    && Array.isArray(value.copy_blockers) && value.copy_blockers.every(item => ['immutable_or_append', 'system_file_flags', 'linux_file_flags', 'windows_access_policy', 'windows_file_flags'].includes(item))
    && typeof value.owner === 'string' && value.owner.length > 0 && typeof value.group === 'string' && value.group.length > 0
    && new Set(value.streams).size === value.streams.length
    && (process.platform === 'win32' || value.streams.length === 0)
  if (!valid(first)) throw unverified()
  const hash = createHash('sha256').update(first.metadata).update('\n' + before.mtimeNs + '\n')
  const nonSecurity = process.platform === 'win32'
    ? createHash('sha256').update(workspaceMetadataWithoutSecurity(first.metadata)).update('\n' + before.mtimeNs + '\n') : null
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
      const evidence = JSON.stringify([stream, bytes.toString(), digest.digest('hex')]) + '\n'
      hash.update(evidence); nonSecurity?.update(evidence)
    } finally { await handle.close() }
  }
  check()
  const last = native.inspectFileMetadata(file), after = await fs.lstat(file, { bigint: true })
  if (!valid(last) || !same(before, after) || first.owner !== last.owner || first.group !== last.group || !first.metadata.equals(last.metadata)
    || JSON.stringify(first.streams) !== JSON.stringify(last.streams) || JSON.stringify(first.copy_blockers) !== JSON.stringify(last.copy_blockers)) throw unverified()
  return { fingerprint: hash.digest('hex'), named_streams: first.streams.length, copy_blockers: first.copy_blockers, owner: first.owner, group: first.group,
    ...(nonSecurity ? { non_security_fingerprint: nonSecurity.digest('hex') } : {}) }
}
