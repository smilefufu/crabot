// Read-only shared code discovery. Never interprets ports.json/employee files or
// grants shutdown/data authority. Actual conversion must reverify this snapshot.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { verifyRootDirectory } from './system-user.mjs'
import { verifyLegacyReleaseEntries } from './legacy-release-identity.mjs'
import { systemError } from './system-registry.mjs'

// ownerUid/checkRoot are internal filesystem-fixture seams, not CLI/env options.
export async function discoverLegacySystemRelease({ root, platform = process.platform, ownerUid = 0, checkRoot = verifyRootDirectory }) {
  if (platform !== 'linux') throw systemError('旧共享发行的自动转换仅支持Linux。', 'CRABOT_LEGACY_UNSUPPORTED')
  root = path.resolve(root)
  await checkRoot(root)
  const stat = await fs.lstat(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw systemError('旧共享代码路径被重定向，未作修改。', 'CRABOT_LEGACY_UNSUPPORTED')
  root = await fs.realpath(root)
  for (const name of ['.git', 'core-release.json', 'cli-installation.json']) {
    const present = await fs.lstat(path.join(root, name)).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (present) throw systemError('源码或已受管安装不属于标准旧发行自动转换，原代码和本地修改保留。', 'CRABOT_LEGACY_UNSUPPORTED')
  }
  const { version, files } = await verifyLegacyReleaseEntries(root, { platform })
  for (const relative of ['VERSION', ...Object.keys(files)]) {
    for (let current = path.join(root, relative);; current = path.dirname(current)) {
      const value = await fs.lstat(current)
      if (value.isSymbolicLink() || value.uid !== ownerUid || value.mode & 0o022) throw systemError('旧共享入口或目录并非管理员只读：' + current, 'CRABOT_LEGACY_UNSUPPORTED')
      if (current === root) break
    }
  }
  return { version, installRoot: root, code_fingerprint: createHash('sha256').update(JSON.stringify({ version, root, files })).digest('hex') }
}
