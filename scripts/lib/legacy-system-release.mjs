// Read-only shared code discovery. Never interprets ports.json/employee files or
// grants shutdown/data authority. Actual conversion must reverify this snapshot.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { verifyRootDirectory } from './system-user.mjs'
import { verifyLegacyReleaseEntries } from './legacy-release-identity.mjs'
import { systemError } from './system-registry.mjs'

// Check directories from the shared root outward before touching a leaf. This
// is code-path policy only; it never follows an employee data/config reference.
export async function verifyLegacySystemCodePaths(root, relatives, ownerUid = 0) {
  const directory = await fs.lstat(root)
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== ownerUid || directory.mode & 0o022) throw systemError('旧共享代码目录并非管理员只读。', 'CRABOT_LEGACY_UNSUPPORTED')
  for (const relative of relatives) {
    if (typeof relative !== 'string' || relative.includes('\\') || path.win32.isAbsolute(relative) || path.posix.isAbsolute(relative) || path.posix.normalize(relative) !== relative || relative === '..' || relative.startsWith('../')) throw systemError('旧代码相对路径无法核验。', 'CRABOT_LEGACY_UNSUPPORTED')
    let file = root
    const parts = relative.split('/')
    for (let index = 0; index < parts.length; index++) {
      file = path.join(file, parts[index])
      const stat = await fs.lstat(file)
      if (stat.isSymbolicLink()) throw systemError('旧共享入口或目录被重定向，未作修改：' + file, 'CRABOT_LEGACY_UNSUPPORTED')
      if (stat.uid !== ownerUid || stat.mode & 0o022 || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
        throw systemError('旧共享入口或目录并非管理员只读：' + file, 'CRABOT_LEGACY_UNSUPPORTED')
      }
    }
  }
}

// ownerUid/checkRoot are internal filesystem-fixture seams, not CLI/env options.
export async function discoverLegacySystemRelease({ root, platform = process.platform, ownerUid = 0, checkRoot = verifyRootDirectory }) {
  if (platform !== 'linux') throw systemError('旧共享发行的自动转换仅支持Linux。', 'CRABOT_LEGACY_UNSUPPORTED')
  root = path.resolve(root)
  await checkRoot(root)
  const stat = await fs.lstat(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw systemError('旧共享代码路径被重定向，未作修改。', 'CRABOT_LEGACY_UNSUPPORTED')
  if (stat.uid !== ownerUid || stat.mode & 0o022) throw systemError('旧共享代码目录并非管理员只读。', 'CRABOT_LEGACY_UNSUPPORTED')
  root = await fs.realpath(root)
  for (const name of ['.git', 'core-release.json', 'cli-installation.json']) {
    const present = await fs.lstat(path.join(root, name)).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (present) throw systemError('源码或已受管安装不属于标准旧发行自动转换，原代码和本地修改保留。', 'CRABOT_LEGACY_UNSUPPORTED')
  }
  await verifyLegacySystemCodePaths(root, ['VERSION'], ownerUid)
  const { version, files } = await verifyLegacyReleaseEntries(root, { platform,
    beforeRead: ({ files }) => verifyLegacySystemCodePaths(root, Object.keys(files), ownerUid) })
  return { version, installRoot: root, code_fingerprint: createHash('sha256').update(JSON.stringify({ version, root, files })).digest('hex') }
}
