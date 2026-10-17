// Read-only recognition of the explicitly supported pre-desktop user releases.
// No old script is executed, no process is stopped and no authority is minted.
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import identity from './process-identity.cjs'
import { detectMode } from './mode.mjs'

const catalog = JSON.parse(await fs.readFile(new URL('../desktop/legacy-releases.json', import.meta.url), 'utf8'))
const fail = message => { throw Object.assign(new Error(message), { code: 'CRABOT_LEGACY_UNSUPPORTED' }) }
const hash = text => createHash('sha256').update(text).digest('hex')
async function present(file) { try { await fs.lstat(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
async function readRegular(root, relative) {
  const file = path.join(root, relative), stat = await fs.lstat(file)
  if (!stat.isFile() || stat.size > 1024 * 1024 || await fs.realpath(file) !== file) fail('旧安装入口被重定向或无法识别，未作修改。')
  return fs.readFile(file)
}

export async function discoverLegacyUserInstall({ root, dataDir, source = process.env, etcDir }) {
  if (detectMode(etcDir) === 'system' || source.CRABOT_DEV === 'true' || Number(source.CRABOT_PORT_OFFSET ?? 0) !== 0) {
    fail('system/dev 部署继续使用原管理入口，桌面不自动接管。')
  }
  root = path.resolve(root); dataDir = path.resolve(dataDir)
  if (!identity.isOwnedDirectory(root) || !identity.isOwnedDirectory(dataDir)) fail('安装或数据目录不属于当前系统用户，未作修改。')
  root = await fs.realpath(root); dataDir = await fs.realpath(dataDir)
  if (await present(path.join(root, '.git')) || await present(path.join(root, 'core-release.json'))
    || await present(path.join(dataDir, 'desktop-managed.json'))) fail('此安装不属于可自动接管的旧 user 发行。')
  const version = (await readRegular(root, 'VERSION')).toString('utf8').trim()
  if (!catalog.versions.includes(version)) fail('此历史版本尚未列入自动接管范围，请保留原安装。')
  const files = { ...catalog.files, ...catalog.version_files[version] }
  for (const [file, expected] of Object.entries(files)) {
    if (hash(await readRegular(root, file)) !== expected) fail('旧安装的关键入口已修改，不能按标准发行自动接管。')
  }
  return { version, installRoot: root, dataRoot: dataDir,
    fingerprint: hash(JSON.stringify({ version, root, dataDir, files })) }
}
