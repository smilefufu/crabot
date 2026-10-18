import { fileURLToPath } from 'node:url'
import { SystemRegistry } from './lib/system-registry.mjs'
import { SystemOperationStore } from './lib/system-operation.mjs'
import { systemUpgradeOperations } from './lib/system-upgrade-job.mjs'
import { runSystemUser } from './lib/system-user.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
try {
  const registry = new SystemRegistry(); registry.authority()
  const store = new SystemOperationStore(registry), id = process.argv[2]
  const plan = store.read(store.file(id), true)?.plan
  const upgrade = plan?.kind === 'upgrade' ? await systemUpgradeOperations(plan, { root, registry }) : undefined
  const result = await store.run(id, { upgrade, apply: async (entry, action, previous) => {
    registry.verifyAccount(entry)
    return runSystemUser(entry, { root, action, previous, operationId: id })
  } })
  process.exitCode = result.exit_code
} catch (error) { console.error('[crabot] ' + error.message); process.exitCode = 1 }
