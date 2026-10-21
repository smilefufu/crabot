import fs, { type BigIntStats } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const native = require('../../../scripts/lib/process-identity.cjs')
export const version = (stat: BigIntStats) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.gid, stat.nlink].join(':')
export const sameIdentity = (a: string, b: string, directory = false) => {
  const left = a.split(':'), right = b.split(':')
  return (directory ? [0, 1, 5, 6, 7] : [0, 1, 5, 6, 7, 8]).every(index => left[index] === right[index])
}
export const digest = (body: string | Buffer) => createHash('sha256').update(body).digest('hex')

/** Neutral private file I/O only. Callers own their fixed namespace, authorization and business semantics. */
export function createWorkspaceMaintenanceFileAccess(failure: () => Error) {
  function owned(file: string, directory = false, privatePath = false) {
    const stat = fs.lstatSync(file, { bigint: true })
    if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()) || !stat.ino || !directory && stat.nlink !== 1n) throw failure()
    let allowed: boolean
    if (process.platform === 'win32') {
      if (directory) allowed = privatePath ? native.isPrivateDirectory(file) : native.isOwnedDirectory(file)
      else allowed = privatePath ? native.isPrivateFile(file) : native.isOwnedFile(file)
    } else {
      allowed = stat.uid === BigInt(process.getuid!()) && (privatePath
        ? (stat.mode & 0o777n) === (directory ? 0o700n : 0o600n) : (stat.mode & 0o022n) === 0n)
    }
    if (!allowed) throw failure()
    return stat
  }
  function syncDirectory(directory: string) {
    if (process.platform === 'win32') return
    const fd = fs.openSync(directory, 'r')
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  }
  function readJson(file: string, limit = 65536): any {
    let before: BigIntStats
    try { before = owned(file, false, true) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    if (before.size > BigInt(limit)) throw failure()
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    try {
      if (version(fs.fstatSync(fd, { bigint: true })) !== version(before)) throw failure()
      const body = fs.readFileSync(fd, 'utf8')
      if (version(owned(file, false, true)) !== version(before) || version(fs.fstatSync(fd, { bigint: true })) !== version(before)) throw failure()
      return JSON.parse(body)
    } finally { fs.closeSync(fd) }
  }
  function publish(directory: string, name: string, value: unknown, verify: (temporary: string) => void, limit = 65536) {
    const text = JSON.stringify(value) + '\n', temporary = path.join(directory, '.publish-' + randomUUID())
    if (Buffer.byteLength(text) > limit) throw failure()
    if (process.platform === 'win32') native.writePrivateFile(temporary, '')
    else fs.writeFileSync(temporary, '', { flag: 'wx', mode: 0o600 })
    try {
      const fd = fs.openSync(temporary, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0))
      try { fs.writeFileSync(fd, text); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      verify(temporary)
      fs.linkSync(temporary, path.join(directory, name))
    } finally { fs.unlinkSync(temporary) }
    syncDirectory(directory)
  }
  return { owned, syncDirectory, readJson, publish }
}
