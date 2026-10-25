import { fileURLToPath } from 'node:url'
import { SystemRegistry } from './lib/system-registry.mjs'
import { SystemOperationStore } from './lib/system-operation.mjs'
import { systemConversionOperations, systemConversionRecoveryOperations } from './lib/system-conversion-job.mjs'
import { systemUpgradeOperations } from './lib/system-upgrade-job.mjs'
import { runSystemUser } from './lib/system-user.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
try {
  const registry = new SystemRegistry(); registry.authority()
  const store = new SystemOperationStore(registry), [id, recoveryId, ...extra] = process.argv.slice(2)
  if (extra.length) throw new Error('Unexpected coordinator arguments')
  const record = store.read(store.file(id), true), plan = record?.plan
  const upgrade = plan?.kind === 'upgrade' ? await systemUpgradeOperations(plan, { root, registry, recovering: Boolean(recoveryId) }) : undefined
  const conversion = plan?.kind === 'conversion' && !recoveryId ? await systemConversionOperations(plan, { root, registry }) : undefined
  const conversionRecovery = plan?.kind === 'conversion' && recoveryId
    ? await systemConversionRecoveryOperations(plan, { root, registry, prior: record.recovery?.base_progress }) : undefined
  const apply = async (entry, action, previous) => {
    if (!registry.read().some(current => current.enabled && JSON.stringify(current) === JSON.stringify(entry))) throw new Error('System user binding changed')
    registry.verifyAccount(entry)
    return runSystemUser(entry, { root, action, previous, operationId: id })
  }
  const observe = async entry => {
    registry.verifyAccount(entry)
    return runSystemUser(entry, { root, action: 'inspect', operationId: id })
  }
  const result = recoveryId ? await store.runRecovery(id, recoveryId, upgrade ?? conversionRecovery ?? { apply, observe })
    : await store.run(id, { upgrade, conversion, apply })
  process.exitCode = result.exit_code
} catch (error) { console.error('[crabot] ' + error.message); process.exitCode = 1 }
