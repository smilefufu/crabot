// Root conversion wiring only. All employee data/process actions remain behind
// the fixed dropped-UID roles; root reads only code and operational metadata.
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import cliLocation from './cli-location.cjs'
import { validateSystemConversionPlan } from './system-conversion.mjs'
import { LegacySystemEntryFence } from './legacy-system-fence.mjs'
import { LegacySystemCommandLink } from './legacy-system-command.mjs'
import { collectLegacySystemProcesses, assertLegacySystemProcessCoverage } from './legacy-system-processes.mjs'
import { runLegacySystemConversion, runSystemUser } from './system-user.mjs'
import { installSystemUserService, ensureSystemUserManager, systemdAvailable } from './system-service.mjs'
import { systemError } from './system-registry.mjs'
const fail = () => { throw systemError('旧共享转换来源、目标或账号绑定已改变，未派发本次动作。', 'CRABOT_SYSTEM_CONVERSION_UNVERIFIED') }
async function prepareServices(plan) {
  if (!systemdAvailable()) throw systemError('旧共享托管转换需要可用systemd；原部署保持。', 'CRABOT_SYSTEMD_UNAVAILABLE')
  installSystemUserService(plan.install_root)
  for (const { entry } of plan.instances) await ensureSystemUserManager(entry)
}

// Dependency overrides are current-UID filesystem fixtures, not CLI/env inputs.
export async function systemConversionOperations(plan, { root, registry,
  fence = new LegacySystemEntryFence(), command = new LegacySystemCommandLink(), processes = collectLegacySystemProcesses,
  legacy = runLegacySystemConversion, target = runSystemUser, prepare = prepareServices } = {}) {
  validateSystemConversionPlan(plan); registry.authority()
  root = path.resolve(root)
  const installation = cliLocation.locateCliInstallation(root)
  if (!installation || installation.scope !== 'system' || installation.root !== plan.install_root
    || installation.coreRoot !== root || installation.id !== plan.target.id) fail()
  await command.target(plan)
  if (await command.selected(plan) !== 'legacy') fail()
  for (const { entry } of plan.instances) registry.verifyAccount(entry)
  await prepare(plan)
  const checked = (entry, managed = false) => {
    if (!plan.instances.some(item => isDeepStrictEqual(item.entry, entry))) fail()
    registry.verifyAccount(entry)
    if (managed && !registry.read().some(value => value.enabled && isDeepStrictEqual(value, entry))) fail()
  }
  const invokeLegacy = (entry, action) => { checked(entry); return legacy(entry, { root, operationId: plan.id, action }) }
  const invokeTarget = (entry, action) => { checked(entry, true); return target(entry, { root, operationId: plan.id, action }) }
  const coverage = stopped => assertLegacySystemProcessCoverage(plan, processes(plan.source.installRoot, { trustedTargetRoot: plan.install_root }), { stopped })
  return {
    fence: async () => { coverage(false); return fence.fence(plan.source, plan.id) },
    stop: entry => invokeLegacy(entry, 'stop-legacy'), snapshot: entry => invokeLegacy(entry, 'snapshot'),
    cancelSnapshot: entry => invokeLegacy(entry, 'cancel-preparation'), migrate: entry => invokeLegacy(entry, 'migrate'),
    selected: () => command.selected(plan),
    selectTarget: async () => { coverage(true); return command.select(plan) },
    sealSource: (id, operationId) => { if (operationId !== plan.id) fail(); return fence.seal(plan.source.installRoot, id, plan.id) },
    restoreSource: async (id, operationId) => {
      if (operationId !== plan.id || await command.selected(plan) !== 'legacy') fail()
      coverage(true); return fence.restore(plan.source.installRoot, id, plan.id)
    },
    startSource: async entry => { if (await command.selected(plan) !== 'legacy') fail(); return invokeLegacy(entry, 'start-legacy') },
    register: entry => { checked(entry); return registry.registerConverted(entry, { operationId: plan.id }) },
    configure: entry => invokeTarget(entry, 'configure-service'),
    startTarget: entry => invokeTarget(entry, 'start'), observeTarget: entry => invokeTarget(entry, 'inspect'),
  }
}
