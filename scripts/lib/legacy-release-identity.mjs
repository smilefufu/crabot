// Neutral code recognition only. Ownership, deployment scope, data binding and
// any takeover permission belong to the caller's separate policy/transaction.
import { promises as fs, realpathSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { legacyReleaseFiles, legacyReleaseEntryHashes } from './legacy-release-files.mjs'
const catalog = JSON.parse(await fs.readFile(new URL('../desktop/legacy-releases.json', import.meta.url), 'utf8'))
const fail = message => { throw Object.assign(new Error(message), { code: 'CRABOT_LEGACY_UNSUPPORTED' }) }
async function regular(root, relative) {
  const file = path.join(root, relative), stat = await fs.lstat(file)
  if (!stat.isFile() || stat.size > 1024 * 1024 || realpathSync(file) !== file) fail('旧安装入口被重定向或无法识别，未作修改。')
  return fs.readFile(file)
}
export async function verifyLegacyReleaseEntries(root, { platform = process.platform, beforeRead } = {}) {
  const version = (await regular(root, 'VERSION')).toString('utf8').trim()
  if (!catalog.versions.includes(version)) fail('此历史版本尚未列入自动接管范围，请保留原安装。')
  const files = legacyReleaseFiles(catalog, version, platform)
  await beforeRead?.({ version, files })
  for (const file of Object.keys(files)) {
    const actual = createHash('sha256').update(await regular(root, file)).digest('hex')
    if (!legacyReleaseEntryHashes(catalog, version, file, platform).includes(actual)) fail('旧安装的关键入口已修改，不能按标准发行自动接管。')
    files[file] = actual
  }
  return { version, files }
}
