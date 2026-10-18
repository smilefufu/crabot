import fs from 'node:fs/promises'
import path from 'node:path'

/** Process entry gate: no request runtime may start after incomplete/unknown preparation. */
export async function assertRequestUpgradeReady(agentDir: string): Promise<void> {
  const value = JSON.parse(await fs.readFile(path.join(agentDir, 'shared-request-upgrade.json'), 'utf8'))
  const supported = value?.schema_version === 1 && value.transaction === 'shared-request-upgrade-v1'
    || value?.schema_version === 2 && value.transaction === 'shared-request-upgrade-v2'
  if (!supported || value.status !== 'ready'
    || typeof value.plan_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.plan_sha256)) throw new Error('Request upgrade is not ready; run the unified Crabot startup/upgrade')
}
