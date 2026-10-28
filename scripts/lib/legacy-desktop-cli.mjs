// Replace only the original installer-owned POSIX link. The caller holds the
// takeover locks and has verified the native launcher and paired installation.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { privateJson } from './desktop-preparation-files.mjs'
const fail = () => { throw Object.assign(new Error('原命令入口在接管期间发生变化，已有内容已保留。请核对后继续。'), { code: 'CRABOT_MAINTENANCE_PENDING' }) }
async function present(file) { try { return await fs.lstat(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
export async function adoptLegacyDesktopCli({ installRoot, home = homedir() }) {
  if (process.platform === 'win32') return false
  const directory = path.join(home, '.local/bin'), entry = path.join(directory, 'crabot'), metadata = path.join(directory, '.crabot-desktop-cli.json')
  const prefix = await present(directory), original = await present(entry)
  // Custom entries and directories stay outside this narrowly recognized link.
  if (!prefix?.isDirectory() || prefix.isSymbolicLink() || prefix.uid !== process.getuid() || prefix.mode & 0o022
    || !original?.isSymbolicLink() || original.uid !== process.getuid()) return false
  const previous = await fs.readlink(entry), target = path.join(installRoot, 'bin/crabot')
  if (![path.join(installRoot, 'cli.mjs'), target].includes(path.resolve(directory, previous))) return false
  const expected = { schema_version: 2, install_root: installRoot }, record = await present(metadata)
  if (record) {
    if (!record.isFile() || record.isSymbolicLink() || record.nlink !== 1 || record.uid !== process.getuid()
      || record.mode & 0o077 || record.size > 16384) fail()
    if (JSON.stringify(JSON.parse(await fs.readFile(metadata, 'utf8'))) !== JSON.stringify(expected)) fail()
  } else await privateJson(metadata, expected)
  if (path.resolve(directory, previous) === target) return true
  const temporary = path.join(directory, '.crabot-link-' + randomUUID())
  try {
    await fs.symlink(target, temporary)
    const current = await fs.lstat(entry)
    if (!current.isSymbolicLink() || current.dev !== original.dev || current.ino !== original.ino || await fs.readlink(entry) !== previous) fail()
    await fs.rename(temporary, entry)
    const opened = await fs.open(directory, 'r'); try { await opened.sync() } finally { await opened.close() }
  } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
  return true
}
