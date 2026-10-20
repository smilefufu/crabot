// Only the isolated POSIX copy host may change its cwd. No business process calls this routine.
import fs from 'node:fs'
import native from './process-identity.cjs'

const failure = () => Object.assign(new Error('工作区副本未能完成文件同步；原目录和暂存保留。'), { code: 'WORKSPACE_SYNC_UNVERIFIED' })
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid
  && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
export function syncWorkspaceDirectoryFd(fd, identity) {
  if (process.platform !== 'darwin' && process.platform !== 'linux') throw failure()
  native.enterDirectoryFd(fd, identity?.dev, identity?.ino)
  const root = fs.fstatSync(fd, { bigint: true })
  function enter(directory, stat) { native.enterDirectoryFd(directory, stat.dev.toString(), stat.ino.toString()) }
  function visit(directory, before) {
    enter(directory, before)
    for (const name of fs.readdirSync('.').sort()) {
      const entry = fs.lstatSync(name, { bigint: true })
      if (entry.isSymbolicLink()) continue
      if ((!entry.isFile() && !entry.isDirectory()) || entry.dev !== root.dev) throw failure()
      const child = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
        | (entry.isDirectory() ? fs.constants.O_DIRECTORY : 0))
      try {
        const opened = fs.fstatSync(child, { bigint: true })
        if (!same(entry, opened)) throw failure()
        if (opened.isDirectory()) visit(child, opened)
        else fs.fsyncSync(child)
        if (!same(opened, fs.fstatSync(child, { bigint: true }))) throw failure()
      } finally {
        try { fs.closeSync(child) } finally { enter(directory, before) }
      }
      if (!same(entry, fs.lstatSync(name, { bigint: true }))) throw failure()
    }
    fs.fsyncSync(directory)
    if (!same(before, fs.fstatSync(directory, { bigint: true }))) throw failure()
  }
  visit(fd, root)
}
