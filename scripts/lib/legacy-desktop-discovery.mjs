// Read-only installer discovery, including the already fenced takeover source.
// No new data, stop, entry write or recovery authority is created here.
import { promises as fs, realpathSync } from 'node:fs'
import path from 'node:path'
import { detectMode } from './mode.mjs'
import { discoverLegacyUserInstall } from './legacy-desktop.mjs'
import { inspectLegacyEntryFence } from './legacy-entry-fence.mjs'
const pending = () => { throw Object.assign(new Error('原接管维护尚未完成，请使用原安装包和原安装位置继续；数据和记录已保留。'), { code: 'CRABOT_MAINTENANCE_PENDING' }) }
async function present(file) { try { return await fs.lstat(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
export async function discoverLegacyDesktopTakeover({ root, source = process.env, etcDir }) {
  if (detectMode(etcDir) === 'system' || source.CRABOT_DEV === 'true' || Number(source.CRABOT_PORT_OFFSET ?? 0) !== 0) {
    throw Object.assign(new Error('system/dev 部署继续使用原管理入口。'), { code: 'CRABOT_LEGACY_UNSUPPORTED' })
  }
  root = path.resolve(root)
  const stat = await present(root)
  if (!stat) return null
  if (!stat.isDirectory() || stat.isSymbolicLink()) pending()
  root = realpathSync(root)
  const dataDir = path.join(root, 'data'), desktop = await present(path.join(root, 'desktop-installation.json'))
  let record
  if (desktop) {
    const { readVersionMaintenance } = await import('./version-maintenance.mjs')
    record = readVersionMaintenance(dataDir)
    if (!record || [1, 3].includes(record.schema_version)) return null
    if (record.schema_version !== 4) pending()
  }
  if (await present(path.join(root, '.desktop-takeover'))) {
    const entry = await inspectLegacyEntryFence(root)
    if (entry.installation.dataRoot !== dataDir) pending()
    const { readVersionMaintenance } = await import('./version-maintenance.mjs')
    record ??= readVersionMaintenance(dataDir)
    if (!record && entry.phase === 'restored') return { installation: await discoverLegacyUserInstall({ root, dataDir, source, etcDir }) }
    if (!entry.entries_fenced || !['fenced', 'data_changing'].includes(entry.phase)) pending()
    if (record && (record.schema_version !== 4 || record.install_root !== root || record.data_dir !== dataDir
      || record.legacy_source.entry_fence_id !== entry.id || record.legacy_source.fingerprint !== entry.installation.fingerprint)) pending()
    if (!record && entry.phase !== 'fenced') pending()
    return { installation: entry.installation, entryFenceId: entry.id }
  }
  if (record?.schema_version === 4) pending()
  if (desktop || !await present(path.join(root, 'VERSION')) && !await present(path.join(root, 'cli.mjs'))) return null
  return { installation: await discoverLegacyUserInstall({ root, dataDir, source, etcDir }) }
}
