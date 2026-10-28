// Same-UID old-directory evidence. It never creates missing data, follows a
// directory alias or changes any child/parent permission during conversion.
import fs from 'node:fs'
import path from 'node:path'
import { systemError } from './system-registry.mjs'
const fail = () => { throw systemError('旧实例目录身份、权限或原凭据无法核验，未转换；原目录保留。', 'CRABOT_LEGACY_SYSTEM_DIRECTORY') }
const identityOf = stat => ({ device: stat.dev.toString(), inode: stat.ino.toString() })
export function validLegacySystemDirectoryIdentity(value) {
  return Boolean(value && Object.keys(value).length === 2 && typeof value.device === 'string' && typeof value.inode === 'string'
    && /^(?:0|[1-9][0-9]{0,29})$/.test(value.device) && /^[1-9][0-9]{0,29}$/.test(value.inode))
}
function owned(stat) {
  const uid = process.getuid?.()
  if (!uid || stat.uid !== BigInt(uid) || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.mode & 0o7022n || (stat.mode & 0o700n) !== 0o700n) fail()
}
export function inspectLegacySystemDataDirectory(directory, expected) {
  if (!process.getuid?.()) fail()
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory === '/' || path.resolve(directory) !== directory) fail()
  let stat
  try { stat = fs.lstatSync(directory, { bigint: true }) }
  catch (error) {
    if (error.code === 'ENOENT') throw systemError('原数据目录不存在，未创建空实例；请检查原目录及备份。', 'CRABOT_DATA_MISSING')
    throw error
  }
  owned(stat)
  if (fs.realpathSync(directory) !== directory) fail()
  const identity = identityOf(stat)
  if (expected !== undefined && (!validLegacySystemDirectoryIdentity(expected) || identity.device !== expected.device || identity.inode !== expected.inode)) fail()
  return { directory, identity }
}

// Caller has proved the original source is stopped under the lifecycle lock.
// fchmod targets the checked inode; only this DataRoot's top level is narrowed.
export function privatizeLegacySystemDataDirectory(directory, expected) {
  inspectLegacySystemDataDirectory(directory, expected)
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  try {
    const stat = fs.fstatSync(fd, { bigint: true }), identity = identityOf(stat)
    owned(stat)
    if (!validLegacySystemDirectoryIdentity(expected) || identity.device !== expected.device || identity.inode !== expected.inode) fail()
    fs.fchmodSync(fd, 0o700); fs.fsyncSync(fd)
    inspectLegacySystemDataDirectory(directory, expected)
    if ((fs.fstatSync(fd).mode & 0o7777) !== 0o700) fail()
  } finally { fs.closeSync(fd) }
  return directory
}

// Read-only structure/credential preflight. readCredentials is deliberately not
// called: its historical .env fallback can write/rotate before our backup exists.
export function assertLegacySystemDataLayout(directory) {
  for (const name of ['admin', 'agent', 'memory']) inspectLegacySystemDataDirectory(path.join(directory, name))
  const fd = fs.openSync(path.join(directory, 'admin/credentials.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o7022 || stat.nlink !== 1 || stat.size > 16384) fail()
    const bytes = Buffer.alloc(16385), size = fs.readSync(fd, bytes, 0, bytes.length, 0)
    if (size > 16384) fail()
    const value = JSON.parse(bytes.subarray(0, size)), params = value?.params
    if (value?.algo !== 'scrypt' || !/^[a-f0-9]{32}$/.test(value.salt) || typeof value.hash !== 'string'
      || !params || Object.keys(params).length !== 4 || !Number.isSafeInteger(params.N) || params.N < 2 || !Number.isInteger(Math.log2(params.N))
      || !Number.isSafeInteger(params.r) || params.r < 1 || !Number.isSafeInteger(params.p) || params.p < 1
      || !Number.isSafeInteger(params.keylen) || params.keylen < 1
      || value.hash.length !== params.keylen * 2 || !/^[a-f0-9]+$/.test(value.hash) || typeof value.is_temp !== 'boolean'
      || !Number.isSafeInteger(value.token_epoch) || value.token_epoch < 0 || !['start', 'cli', 'ui'].includes(value.changed_via)
      || typeof value.created_at !== 'string' || !Number.isFinite(Date.parse(value.created_at))
      || typeof value.last_changed_at !== 'string' || !Number.isFinite(Date.parse(value.last_changed_at))) fail()
  } catch { fail() }
  finally { fs.closeSync(fd) }
}
