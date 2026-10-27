// Read static code capabilities and existing data-version facts only.
import { assertAdminDataCompatibility } from './admin-data-compat.mjs'
import { assertWorkspaceDataCompatibility } from './workspace-data-compat.mjs'
import { scanModules } from './module-data-versions.mjs'

export function verifyDataCompatibility(root, dataDir) {
  assertAdminDataCompatibility(root, dataDir)
  assertWorkspaceDataCompatibility(root, dataDir)
  const pending = scanModules(root, dataDir)
  // Preflight the whole version set before the first module can mutate data.
  // A rollback cannot turn a newer schema into an older one by relabelling it.
  for (const migration of pending) {
    const versions = [migration.dataVersion ?? 'v0', migration.codeVersion]
    if (versions.some(value => !/^v\d+$/.test(value) || !Number.isSafeInteger(Number(value.slice(1))))) {
      throw Object.assign(new Error(`Invalid schema version: ${migration.moduleId}`), { code: 'CRABOT_SCHEMA_VERSION_INVALID' })
    }
    if (Number(versions[0].slice(1)) > Number(versions[1].slice(1))) {
      throw Object.assign(new Error(`Data requires a newer core: ${migration.moduleId}`), { code: 'CRABOT_DATA_NEWER_THAN_CODE' })
    }
  }
  return pending
}
