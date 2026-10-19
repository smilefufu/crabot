import { previewLegacyDirectoryPermissions } from './legacy-directory-inputs.mjs'
export async function migrationScope({ dataRoot, from, to }) {
  if (from !== 0 || to !== 1) throw new Error('Unsupported Admin migration range')
  await previewLegacyDirectoryPermissions(dataRoot)
  return { reads: ['admin/friends.json', 'admin/templates.json', 'agent/manager-principal-bindings.json'],
    writes: ['admin/friend-permission-configs.json', 'admin/session-configs.json'] }
}
