// Publish/select only the original fixed Root under this fresh recovery role.
import { verifyWorkspaceInterruptedRecoveryRole } from './workspace-interrupted-role.mjs'
import * as records from './workspace-relocation-intent.mjs'
import { sha256CanonicalJson as hash } from '../../crabot-shared/dist/canonical-json.js'
export async function finishWorkspaceInterruptedRoot({ dataDir, recoveryId, launchHash, signal }) {
  const options = { dataDir, recoveryId, launchHash }, role = verifyWorkspaceInterruptedRecoveryRole(options), id = role.launch.request.intent_id
  if (role.launch.action !== 'finish_commit') throw new Error('Original forward Root is unavailable')
  const assertCurrent = () => { signal?.throwIfAborted(); verifyWorkspaceInterruptedRecoveryRole(options) }
  const input = { dataDir, id, signal, assertCurrent, authorize: async () => assertCurrent(), temporaryDirectory: role.launch.control_root.path }
  await records.prepareWorkspaceRelocationRootPlanUnderAuthority(input)
  await records.publishWorkspaceRelocationRootUnderAuthority(input)
  await records.selectWorkspaceRelocationRootUnderAuthority(input)
  assertCurrent()
  const selected = records.readWorkspaceRelocationRootSelected(dataDir, id)
  return Object.freeze({ selected: true, selected_sha256: hash(selected), catalog_sha256: selected.catalog_sha256 })
}
