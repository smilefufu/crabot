// Same-UID operational diagnostics only; no employee file is opened by root.
import fs from 'node:fs'
import path from 'node:path'
import management from './desktop-management.cjs'
import { systemError } from './system-registry.mjs'
export function openSystemUserMaintenanceLog(entry) {
  if (!entry || entry.uid <= 0 || process.getuid?.() !== entry.uid) throw systemError('本人维护日志的OS身份不一致，未读取目录。')
  const dataDir = management.requirePrivateDataRoot(entry.data_dir)
  const logs = management.ensurePrivateDataRoot(path.join(dataDir, 'system-control'))
  const fd = fs.openSync(path.join(logs, 'system-maintenance.log'), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600)
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.uid !== entry.uid || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) throw systemError('本人维护日志无法安全打开，未派发迁移。')
    return fd
  } catch (error) { fs.closeSync(fd); throw error }
}
