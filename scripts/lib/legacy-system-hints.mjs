// Group-writable historical metadata is only a discovery hint. It cannot grant
// UID/data/stop authority, and no PID, data_dir, command or shell field is adopted.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { resolveLinuxAccount, systemError } from './system-registry.mjs'
const fail = () => { throw systemError('旧端口注册表缺失、重复或无法核验；未转换，请管理员先核对原表。', 'CRABOT_LEGACY_SYSTEM_HINTS') }
export function readLegacySystemHints({ file = '/etc/crabot/registry/ports.json', ownerUid = 0 } = {}) {
  file = path.resolve(file)
  let fd
  try {
    if (fs.realpathSync(path.dirname(file)) !== path.dirname(file)) fail()
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const stat = fs.fstatSync(fd), limit = 1024 * 1024
    if (!stat.isFile() || stat.uid !== ownerUid || stat.nlink !== 1 || stat.size > limit) fail()
    const buffer = Buffer.alloc(limit + 1)
    let size = 0
    while (size < buffer.length) {
      const read = fs.readSync(fd, buffer, size, buffer.length - size, size)
      if (!read) break
      size += read
    }
    if (size > limit) fail()
    const bytes = buffer.subarray(0, size), rows = JSON.parse(bytes.toString('utf8'))
    if (!Array.isArray(rows) || rows.length > 99) fail()
    const users = new Set(), offsets = new Set(), hints = []
    for (const row of rows) {
      if (!row || typeof row.user !== 'string' || row.user.length > 256 || !/^[^\s\x00-\x1f\x7f/:.-][^\s\x00-\x1f\x7f/:]*$/.test(row.user)
        || !Number.isInteger(row.offset) || row.offset < 100 || row.offset > 9900 || row.offset % 100 !== 0
        || users.has(row.user) || offsets.has(row.offset)) fail()
      users.add(row.user); offsets.add(row.offset); hints.push({ user: row.user, port_offset: row.offset })
    }
    return { hints, fingerprint: createHash('sha256').update(bytes).digest('hex') }
  } catch { fail() }
  finally { if (fd !== undefined) fs.closeSync(fd) }
}
export function resolveLegacySystemCandidates(snapshot, { lookup = resolveLinuxAccount } = {}) {
  const candidates = [], failures = [], counts = new Map()
  const failed = user => failures.push({ user, code: 'CRABOT_LEGACY_SYSTEM_ACCOUNT', message: 'Linux账号或UID绑定无法核验，未访问该用户的数据。' })
  for (const hint of snapshot.hints) {
    try {
      const account = lookup(hint.user)
      if (account.user !== hint.user || !Number.isInteger(account.uid) || account.uid <= 0 || account.uid > 0xfffffffe
        || !Number.isInteger(account.gid) || account.gid < 0 || account.gid > 0xfffffffe || typeof account.home !== 'string'
        || !path.posix.isAbsolute(account.home) || path.posix.normalize(account.home) !== account.home || account.home === '/' || /[\0\r\n]/.test(account.home)) fail()
      counts.set(account.uid, (counts.get(account.uid) ?? 0) + 1)
      candidates.push({ account, port_offset_hint: hint.port_offset })
    } catch { failed(hint.user) }
  }
  const unique = candidates.filter(candidate => {
    if (counts.get(candidate.account.uid) === 1) return true
    failed(candidate.account.user); return false
  })
  return { candidates: unique, failures, hints_fingerprint: snapshot.fingerprint }
}
