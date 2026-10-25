// Installer preflight only: trusted code and operational hints in root; employee
// observations are obtained after UID drop. No data, service or registry writes.
import fs from 'node:fs'
import path from 'node:path'
import cliLocation from './cli-location.cjs'
import { verifyCoreRelease } from './core-release.mjs'
import { discoverLegacySystemRelease } from './legacy-system-release.mjs'
import { readLegacySystemHints, resolveLegacySystemCandidates } from './legacy-system-hints.mjs'
import { runLegacySystemAccount, verifyRootDirectory } from './system-user.mjs'
import { planSystemConversion } from './system-conversion.mjs'
import { SystemRegistry, systemError } from './system-registry.mjs'
import { SystemOperationStore } from './system-operation.mjs'
const fail = () => { throw systemError('旧共享预检未能核实完整用户集合、来源或目标，未停机或修改原数据。', 'CRABOT_SYSTEM_CONVERSION_UNVERIFIED') }

// Read-only observation overrides are filesystem fixtures, never CLI/env input.
export async function preflightLegacySystemConversion({ root, sourceRoot, registry = new SystemRegistry(),
  readHints = readLegacySystemHints, resolveCandidates = resolveLegacySystemCandidates,
  discoverRelease = discoverLegacySystemRelease, observe = runLegacySystemAccount, checkRoot = verifyRootDirectory }) {
  registry.authority(); root = path.resolve(root)
  const installed = cliLocation.assertSelectedCli(root)
  if (!installed || installed.scope !== 'system') fail()
  await checkRoot(installed.root)
  const release = await verifyCoreRelease(root)
  if (release.inventory_sha256 !== installed.id) fail()
  await checkRoot(path.dirname(registry.directory))
  if (fs.existsSync(registry.directory)) {
    await checkRoot(registry.directory)
    if (registry.read().length) fail()
    new SystemOperationStore(registry).assertIdle()
  }
  const source = await discoverRelease({ root: sourceRoot }), hints = readHints()
  const { candidates, failures } = resolveCandidates(hints)
  if (failures.length || candidates.length !== hints.hints.length) fail()
  const instances = []
  for (const { account, port_offset_hint: offset } of candidates) {
    registry.verifyAccount(account)
    const observation = await observe(account, { root, release: source, portOffsetHint: offset })
    const entry = { ...account, data_dir: observation?.data_dir, port_offset: offset, enabled: true, autostart: false }
    instances.push({ entry, observation })
  }
  const plan = planSystemConversion({ installRoot: installed.root, source,
    target: { id: release.inventory_sha256, version: release.version }, instances })
  return { plan, hints_fingerprint: hints.fingerprint }
}
