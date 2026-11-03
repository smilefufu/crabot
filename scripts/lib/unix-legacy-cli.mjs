// After explicit data admission only: retarget the known per-user release link.
// Custom commands, source links and system registrations are never replaced.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const present = async file => { try { return await fs.lstat(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
export async function forwardImportedUnixCommand({ sourceRoot, coreRoot, home }) {
  const directory = path.join(home, '.local/bin'), entry = path.join(directory, 'crabot')
  const prefix = await present(directory), current = await present(entry)
  if (!prefix?.isDirectory() || prefix.isSymbolicLink() || prefix.uid !== process.getuid() || prefix.mode & 0o022
    || !current?.isSymbolicLink() || current.uid !== process.getuid()) return false
  const original = await fs.readlink(entry), actual = path.resolve(directory, original), desired = path.join(coreRoot, 'bin/crabot')
  if (actual === desired) return true
  if (![path.join(sourceRoot, 'cli.mjs'), path.join(sourceRoot, 'bin/crabot')].includes(actual)
    || await present(path.join(sourceRoot, '.git'))) return false
  const temporary = path.join(directory, '.crabot-import-' + randomUUID())
  try {
    await fs.symlink(desired, temporary)
    const latest = await fs.lstat(entry)
    if (latest.dev !== current.dev || latest.ino !== current.ino || await fs.readlink(entry) !== original) throw new Error('旧命令在接入期间发生变化，未覆盖该命令。')
    await fs.rename(temporary, entry)
  } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
  return true
}
