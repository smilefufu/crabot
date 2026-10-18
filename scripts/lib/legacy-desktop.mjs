// Read-only recognition of the explicitly supported pre-desktop user releases.
// No old script is executed, no process is stopped and no authority is minted.
import { promises as fs, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { verifyLegacyReleaseEntries } from './legacy-release-identity.mjs'
import identity from './process-identity.cjs'
import { detectMode } from './mode.mjs'

const fail = message => { throw Object.assign(new Error(message), { code: 'CRABOT_LEGACY_UNSUPPORTED' }) }
const hash = text => createHash('sha256').update(text).digest('hex')
async function present(file) { try { await fs.lstat(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }

export async function discoverLegacyUserInstall({ root, dataDir, source = process.env, etcDir }) {
  if (detectMode(etcDir) === 'system' || source.CRABOT_DEV === 'true' || Number(source.CRABOT_PORT_OFFSET ?? 0) !== 0) {
    fail('system/dev 部署继续使用原管理入口，桌面不自动接管。')
  }
  root = path.resolve(root); dataDir = path.resolve(dataDir)
  if (!identity.isOwnedDirectory(root) || !identity.isOwnedDirectory(dataDir)) fail('安装或数据目录不属于当前系统用户，未作修改。')
  root = realpathSync(root); dataDir = realpathSync(dataDir)
  if (await present(path.join(root, '.git')) || await present(path.join(root, 'core-release.json'))
    || await present(path.join(dataDir, 'desktop-managed.json'))) fail('此安装不属于可自动接管的旧 user 发行。')
  const { version, files } = await verifyLegacyReleaseEntries(root)
  return { version, installRoot: root, dataRoot: dataDir,
    fingerprint: hash(JSON.stringify({ version, root, dataDir, files })) }
}
