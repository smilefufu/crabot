import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { scopedPath } from '../../scripts/upgrade-lib/scoped-data.mjs'
const { planLegacyDirectoryPermissions } = createRequire(import.meta.url)('../dist/legacy-directory-migration.js')
export async function previewLegacyDirectoryPermissions(dataRoot) {
  async function read(name, missing) {
    const file = await scopedPath(dataRoot, name)
    try { return JSON.parse(await fs.readFile(file, 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return missing; throw error }
  }
  const [friends, templates, friendConfigs, groups, bindings] = await Promise.all([
    read('admin/friends.json', []), read('admin/templates.json', []), read('admin/friend-permission-configs.json', []),
    read('admin/session-configs.json', []), read('agent/manager-principal-bindings.json', { bindings: [] }),
  ])
  return planLegacyDirectoryPermissions({ friends, templates, friendConfigs, groups, bindings }, new Date().toISOString())
}
