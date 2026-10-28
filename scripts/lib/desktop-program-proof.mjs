// Read-only original payload bytes. This grants no execution, repair, deletion
// or lifecycle authority; callers independently prove their current operation.
import physicalFs from './physical-fs.cjs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import identity from './process-identity.cjs'
import { payloadName } from './desktop-preparation-files.mjs'
const { promises: fs, constants } = physicalFs
const fail = message => { throw Object.assign(new Error(message), { code: 'CRABOT_DESKTOP_INSTALLATION' }) }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const digest = text => createHash('sha256').update(text).digest('hex')
const version = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.size, stat.nlink, stat.mtimeNs, stat.ctimeNs].join(':')
async function present(file) { try { return await fs.lstat(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
export async function readOriginalDesktopPayload(root, selection) {
  let file = path.join(root, payloadName)
  const directory = path.join(root, 'app/payloads'), parent = await present(directory)
  if (parent) {
    if (!parent.isDirectory() || parent.isSymbolicLink() || (process.platform === 'win32'
      ? !identity.isPrivateDirectory(directory) : parent.uid !== process.getuid() || (parent.mode & 0o777) !== 0o700)) fail('原程序清单目录无法核验，已保留安装。')
    const current = path.join(directory, selection.gui_id + '.json')
    if (await present(current)) file = current
  }
  let before
  try { before = await fs.lstat(file, { bigint: true }) }
  catch (error) { if (error.code === 'ENOENT') fail('原程序完整清单缺失，已保留原安装与数据。'); throw error }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 64n * 1024n * 1024n
    || (process.platform === 'win32' ? !identity.isPrivateFile(file) : before.uid !== BigInt(process.getuid()) || (before.mode & 0o777n) !== 0o600n)) fail('原程序完整清单无法核验，已保留安装。')
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let text
  try {
    if (version(await handle.stat({ bigint: true })) !== version(before)) fail('原程序清单已变化。')
    text = await handle.readFile('utf8')
    if (version(await handle.stat({ bigint: true })) !== version(before) || version(await fs.lstat(file, { bigint: true })) !== version(before)) fail('原程序清单已变化。')
  } finally { await handle.close() }
  let record
  try { record = JSON.parse(text) } catch { fail('原程序清单损坏，未按新安装覆盖。') }
  if (!record || !same(record.selection, selection) || text !== JSON.stringify(record) + '\n') fail('原程序清单与当前版本对不一致。')
  return { file, text, record, sha256: digest(text) }
}
