import { fileURLToPath } from 'node:url'
import { SystemRegistry } from './lib/system-registry.mjs'
import { SystemOperationStore } from './lib/system-operation.mjs'
import { runSystemUser } from './lib/system-user.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
try {
  const registry = new SystemRegistry(); registry.authority()
  const store = new SystemOperationStore(registry), id = process.argv[2]
  const result = await store.run(id, { apply: async (entry, action, previous) => {
    registry.verifyAccount(entry)
    return runSystemUser(entry, { root, action, previous, operationId: id })
  } })
  process.exitCode = result.exit_code
} catch (error) { console.error('[crabot] ' + error.message); process.exitCode = 1 }
