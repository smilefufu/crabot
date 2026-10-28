// Account-only legacy observations. This deliberately returns no data binding or
// lifecycle token: an informational manifest is not proof of the actual DATA_DIR.
import fs from 'node:fs'
import path from 'node:path'
import { userInfo } from 'node:os'
import { createHash } from 'node:crypto'
import { discoverLegacySystemRelease } from './legacy-system-release.mjs'
import { validateLegacyAccountRequest } from './system-user.mjs'
import { systemError } from './system-registry.mjs'
const fail = () => { throw systemError('旧实例清单或账号来源无法核验，未转换、未读取业务配置。', 'CRABOT_LEGACY_SYSTEM_ACCOUNT') }
export async function discoverLegacySystemAccount(context, { actual = userInfo(), discoverRelease = discoverLegacySystemRelease } = {}) {
  validateLegacyAccountRequest(context)
  const { account, release, port_offset_hint: hint } = context
  // This check precedes even the shared-code lookup and all employee file I/O.
  if (actual.uid !== account.uid || actual.gid !== account.gid || actual.username !== account.user || actual.homedir !== account.home) fail()
  const code = await discoverRelease({ root: release.installRoot })
  if (code.version !== release.version || code.installRoot !== release.installRoot || code.code_fingerprint !== release.code_fingerprint) fail()
  try {
    const { bytes, value } = readLegacySystemManifest(account, actual)
    if (!value || value.mode !== 'system' || value.port_offset !== hint || typeof value.crabot_home !== 'string'
      || !path.isAbsolute(value.crabot_home) || fs.realpathSync(value.crabot_home) !== release.installRoot) fail()
    return { user: account.user, uid: account.uid, port_offset: hint, install_root: release.installRoot,
      code_fingerprint: code.code_fingerprint, manifest_fingerprint: createHash('sha256').update(bytes).digest('hex'), data_binding: 'unverified' }
  } catch { fail() }
}

// Same-UID bounded bytes only. This does not establish code/data binding or
// grant any lifecycle action; each caller applies its own role semantics.
export function readLegacySystemManifest(account, actual = userInfo()) {
  if (!account || actual.uid !== account.uid || actual.gid !== account.gid || actual.username !== account.user || actual.homedir !== account.home) fail()
  const directory = path.join(account.home, '.crabot'), manifest = path.join(directory, 'instance.json')
  let fd
  try {
    const parent = fs.lstatSync(directory)
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== account.uid || parent.mode & 0o022) fail()
    fd = fs.openSync(manifest, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const stat = fs.fstatSync(fd), limit = 65536
    if (!stat.isFile() || stat.uid !== account.uid || stat.mode & 0o022 || stat.nlink !== 1 || stat.size > limit) fail()
    const buffer = Buffer.alloc(limit + 1)
    let size = 0
    while (size < buffer.length) {
      const count = fs.readSync(fd, buffer, size, buffer.length - size, size)
      if (!count) break
      size += count
    }
    if (size > limit) fail()
    const bytes = buffer.subarray(0, size)
    return { bytes, value: JSON.parse(bytes.toString('utf8')) }
  } catch { fail() }
  finally { if (fd !== undefined) fs.closeSync(fd) }
}
