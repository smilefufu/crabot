// Best-effort copy of existing console metadata in the disposable UI profile.
// This is never read by lifecycle, authentication, migration or recovery code.
import fs from 'node:fs'
import path from 'node:path'
type Files = {
  isOwnedDirectory: (file: string) => boolean
  isOwnerOnlyDirectory?: (file: string) => boolean
  isPrivateFile?: (file: string) => boolean
  writePrivateFile?: (file: string, text: string) => void
}
const close = (fd: number | undefined) => { if (fd !== undefined) try { fs.closeSync(fd) } catch { /* Diagnostics cannot block startup. */ } }
type Event = { phase: string; at: string; code?: string; app_version?: string }
export function openBootstrapLog(profile: string, files: Files): ((event: Event) => void) | undefined {
  let fd: number | undefined
  try {
    const directory = fs.lstatSync(profile), file = path.join(profile, 'bootstrap.log')
    const profileCurrent = () => {
      const current = fs.lstatSync(profile)
      return current.isDirectory() && !current.isSymbolicLink() && current.dev === directory.dev && current.ino === directory.ino
        && fs.realpathSync(profile) === profile && files.isOwnedDirectory(profile)
        && (process.platform === 'win32' ? files.isOwnerOnlyDirectory?.(profile) : (current.mode & 0o777) === 0o700)
    }
    if (!profileCurrent()) return
    const open = () => {
      const before = fs.lstatSync(file)
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 16384
        || (process.platform === 'win32' ? !files.isPrivateFile?.(file) : before.uid !== process.getuid!() || (before.mode & 0o777) !== 0o600)) throw new Error('Unavailable bootstrap log')
      const handle = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0))
      try {
        const actual = fs.fstatSync(handle)
        if (!actual.isFile() || actual.dev !== before.dev || actual.ino !== before.ino || actual.nlink !== 1) throw new Error('Changed bootstrap log')
        return handle
      } catch (error) { close(handle); throw error }
    }
    if (!fs.existsSync(file)) {
      if (process.platform === 'win32') files.writePrivateFile!(file, '')
      else fs.closeSync(fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600))
    }
    fd = open(); const original = fs.fstatSync(fd); fs.ftruncateSync(fd, 0); fs.closeSync(fd); fd = undefined
    let count = 0, failed = false
    return event => {
      if (!event || failed || count >= 32 || !/^[a-z][a-z-]{0,47}$/.test(event.phase) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(event.at)
        || event.code !== undefined && !/^[A-Z0-9_]{1,128}$/.test(event.code)
        || event.app_version !== undefined && !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9._-]{1,64})?$/.test(event.app_version)) return
      let handle: number | undefined
      try {
        if (!profileCurrent()) return
        handle = open(); const current = fs.fstatSync(handle)
        if (current.dev !== original.dev || current.ino !== original.ino) throw new Error('Replaced bootstrap log')
        const line = JSON.stringify({ component: 'desktop-bootstrap', phase: event.phase, at: event.at,
          ...(event.code === undefined ? {} : { code: event.code }), ...(event.app_version === undefined ? {} : { app_version: event.app_version }) }) + '\n'
        if (current.size + Buffer.byteLength(line) > 16384) return
        fs.writeSync(handle, line); count++
      } catch { failed = true } finally { close(handle) }
    }
  } catch { return undefined } finally { close(fd) }
}
