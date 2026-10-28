// Privileged coordinator: immutable installation and operational metadata only.
// Every employee data access is delegated through the authenticated UID helper.
import path from 'node:path'
import cliLocation from './cli-location.cjs'
import { selectCliPayload } from './cli-installation.mjs'
import { verifyCoreRelease } from './core-release.mjs'
import { validateSystemDeployment } from './system-upgrade.mjs'
import { runSystemUser, verifyRootExecutable } from './system-user.mjs'
import { systemError } from './system-registry.mjs'

export async function systemUpgradeOperations(plan, { root, registry, recovering = false }) {
  validateSystemDeployment(plan)
  const target = cliLocation.locateCliInstallation(root)
  if (!target || target.scope !== 'system' || target.root !== plan.install_root || target.id !== plan.target.id
    || !(recovering ? [plan.source.id, plan.target.id] : [plan.source.id]).includes(cliLocation.readCliSelection(plan.install_root))) throw systemError('共享更新作业来源或目标已改变。')
  for (const release of [plan.source, plan.target]) {
    const directory = path.join(plan.install_root, 'releases', release.id)
    verifyRootExecutable(path.join(directory, 'scripts/system-user-helper.mjs'))
    if ((await verifyCoreRelease(directory, { version: release.version })).inventory_sha256 !== release.id) throw systemError('共享核心完整性已改变。')
  }
  const checked = entry => {
    if (!registry.read().some(current => current.enabled && JSON.stringify(current) === JSON.stringify(entry))) throw systemError('作业用户绑定已改变。', 'CRABOT_SYSTEM_INSTANCE_CHANGED')
    registry.verifyAccount(entry)
  }
  const deployment = { install_root: plan.install_root, source: plan.source, target: plan.target }
  const invoke = async (entry, action, options) => {
    checked(entry)
    return runSystemUser(entry, { root, action, operationId: plan.id, deployment, ...options })
  }
  const snapshots = new Map()
  return {
    observe: entry => invoke(entry, 'inspect'),
    stop: (entry, previous) => invoke(entry, 'stop', { previous }),
    snapshot: async entry => { const receipt = await invoke(entry, 'snapshot'); snapshots.set(entry.uid, receipt); return receipt },
    migrate: (entry, snapshot) => invoke(entry, 'migrate', { snapshot }),
    checkMigration: (entry, snapshot) => invoke(entry, 'check-migration', { snapshot }),
    cancelSnapshot: entry => invoke(entry, 'cancel-preparation'),
    startSource: entry => invoke(entry, 'start'), startTarget: entry => invoke(entry, 'start'),
    selected: async () => cliLocation.readCliSelection(plan.install_root),
    select: async expected => {
      for (const item of plan.instances) {
        if ((await invoke(item.entry, 'inspect')).state !== 'stopped') throw systemError('切换前用户停止状态发生变化。', 'CRABOT_SYSTEM_STOP_UNKNOWN')
        const snapshot = snapshots.get(item.entry.uid)
        const proof = snapshot && await invoke(item.entry, 'verify-snapshot', { snapshot })
        if (proof?.verified !== true || proof.service_started !== false) throw systemError('切换前范围恢复材料无法核验。')
      }
      await selectCliPayload({ installRoot: plan.install_root, coreRoot: root, scope: 'system', id: plan.target.id,
        version: plan.target.version }, { expected })
    },
  }
}
