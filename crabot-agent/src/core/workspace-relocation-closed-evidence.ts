import fs from 'node:fs'
import path from 'node:path'
import { sha256CanonicalJson } from 'crabot-shared'
import { captureWorkspaceRelocationLedgers } from './workspace-relocation-ledgers.js'
import { captureWorkspaceRelocationRecovery } from './workspace-relocation-recovery-capture.js'
import { assertWorkspaceRecoveryProgress, verifyWorkspaceRecoveryProgress } from './workspace-relocation-recovery-commit.js'
import { archiveWorkspaceRelocationCheckpoint } from './workspace-relocation-checkpoints.js'
import { WorkspaceRelocationRetirements } from './workspace-relocation-retirements.js'
import { createWorkspaceMaintenanceFileAccess, digest, version, sameIdentity } from './workspace-maintenance-files.js'

const native = require('../../../scripts/lib/process-identity.cjs')
const failure = () => Object.assign(new Error('旧执行器或恢复终态无法重新核实，已保留原记录及维护保护。'), { code: 'CRABOT_WORKSPACE_CLOSED_EVIDENCE' })

interface ClosureInspectionOptions {
  dataDir: string
  id: string
  verify: () => Promise<unknown>
  signal?: AbortSignal
}

/** Read-only Agent facts; callers retain current role, lock and whole-execution exit checks. */
async function inspectClosureFacts({ dataDir, id, verify, signal }: ClosureInspectionOptions, readFacts: () => any) {
  if (typeof verify !== 'function') throw failure()
  const { owned, readJson } = createWorkspaceMaintenanceFileAccess(failure)
  await verify()
  const { workerPlan, workerComplete, recoveryPlan, recoveryComplete, controlRoot } = readFacts()
  if (!workerPlan || !workerComplete || !recoveryPlan || !recoveryComplete) throw failure()
  const workerHash = sha256CanonicalJson(workerComplete), recoveryHash = sha256CanonicalJson(recoveryComplete)
  const workerPlanHash = sha256CanonicalJson(workerPlan), recoveryPlanHash = sha256CanonicalJson(recoveryPlan)
  let directories: Array<{ path: string; version: string; native_id: string | null }>, files: Array<{ path: string; version: string }>, names: readonly string[]
  // Keep only technical versions in the retained verifier, not the ledger bodies.
  {
    const snapshot = await captureWorkspaceRelocationLedgers(dataDir, { signal })
    if (sha256CanonicalJson(snapshot.names) !== sha256CanonicalJson(workerPlan.names) || snapshot.files.length !== workerPlan.ledgers.length) throw failure()
    for (const [index, directory] of snapshot.directories.entries()) {
      const original = workerPlan.directories[index]
      if (!original || directory.path !== original.path || !sameIdentity(directory.version, original.version, true) || directory.native_id !== original.native_id) throw failure()
    }
    files = snapshot.files.map((file, index) => {
      const planned = workerPlan.ledgers[index]
      if (!planned || file.name !== planned.name || file.manager_key !== planned.manager_key || digest(file.contents) !== planned.after_sha256) throw failure()
      const expectedVersion = planned.before_sha256 === planned.after_sha256 ? planned.before_version
        : readJson(path.join(controlRoot, 'relocation-worker-commits', index + '.closed.json'))?.version
      if (file.version !== expectedVersion) throw failure()
      return { path: path.join(snapshot.directories[2].path, file.name), version: file.version }
    })
    directories = [...snapshot.directories]; names = snapshot.names
  }
  const snapshot = await captureWorkspaceRelocationRecovery(dataDir, { signal })
  assertWorkspaceRecoveryProgress(recoveryPlan.snapshot, snapshot)
  if (snapshot.checkpoints.length) throw failure()
  new WorkspaceRelocationRetirements(dataDir).load()
  const retirementDirectory = path.join(dataDir, 'agent/workspace-relocation-retirements'), retirementFile = path.join(retirementDirectory, id + '.json')
  const retirementStat = version(owned(retirementFile, false, true))
  if (sha256CanonicalJson(readJson(retirementFile, 32 * 1024 * 1024)) !== recoveryComplete.retirement_sha256) throw failure()
  const archives: Array<() => void> = []
  for (const [index, checkpoint] of recoveryPlan.snapshot.checkpoints.entries()) {
    const result = await archiveWorkspaceRelocationCheckpoint({ dataDir, id, managerKey: checkpoint.manager_key, source: checkpoint.source,
      beforeVersion: checkpoint.before_version, beforeSha256: checkpoint.before_sha256, verify, requireComplete: true,
      retainVerification: check => archives.push(check) })
    const expected = recoveryComplete.checkpoints[index]
    if (!expected || result.dispatch !== 'observe' || result.manifest_sha256 !== expected.manifest_sha256 || result.complete_sha256 !== expected.complete_sha256) throw failure()
  }
  const check = () => {
    if (signal?.aborted) throw failure()
    const current = readFacts()
    if (sha256CanonicalJson(current.workerPlan) !== workerPlanHash || sha256CanonicalJson(current.workerComplete) !== workerHash
      || sha256CanonicalJson(current.recoveryPlan) !== recoveryPlanHash || sha256CanonicalJson(current.recoveryComplete) !== recoveryHash || current.controlRoot !== controlRoot) throw failure()
    for (const directory of directories) if (!sameIdentity(version(owned(directory.path, true)), directory.version, true)
      || fs.realpathSync(directory.path) !== directory.path || process.platform === 'win32' && native.inspectDirectoryFileId(directory.path) !== directory.native_id) throw failure()
    if (sha256CanonicalJson(fs.readdirSync(directories[2].path).sort()) !== sha256CanonicalJson(names)) throw failure()
    for (const file of files) if (version(owned(file.path)) !== file.version) throw failure()
    verifyWorkspaceRecoveryProgress(recoveryPlan.snapshot)
    owned(retirementDirectory, true, true)
    if (fs.realpathSync(retirementDirectory) !== retirementDirectory || version(owned(retirementFile, false, true)) !== retirementStat) throw failure()
    for (const verifyArchive of archives) verifyArchive()
  }
  await verify(); check()
  return Object.freeze({ worker_commit_sha256: workerHash, recovery_commit_sha256: recoveryHash, verify: check })
}


export function inspectWorkspaceRelocationClosures(options: ClosureInspectionOptions) {
  const records = require('../../../scripts/lib/workspace-relocation-intent.mjs'), { dataDir, id } = options
  return inspectClosureFacts(options, () => ({
    workerPlan: records.readWorkspaceRelocationClosurePlan(dataDir, id), workerComplete: records.readWorkspaceRelocationClosureCommit(dataDir, id),
    recoveryPlan: records.readWorkspaceRelocationRecoveryPlan(dataDir, id), recoveryComplete: records.readWorkspaceRelocationRecoveryCommit(dataDir, id),
    controlRoot: path.join(dataDir, 'workspace-control/relocation-active'),
  }))
}

export function inspectArchivedWorkspaceRelocationClosures(options: ClosureInspectionOptions) {
  const records = require('../../../scripts/lib/workspace-relocation-intent.mjs')
  return inspectClosureFacts(options, () => ({ ...records.readWorkspaceRelocationArchivedClosureFacts(options.dataDir, options.id),
    controlRoot: path.join(options.dataDir, 'workspace-control/relocation-history', options.id) }))
}

/** Current caller supplies authority; the version-2 facts do not revive an old completion. */
export function inspectInterruptedWorkspaceRelocationClosures(options: ClosureInspectionOptions) {
  const records = require('../../../scripts/lib/workspace-interrupted-forward-records.mjs')
  return inspectClosureFacts(options, () => {
    const facts = records.readWorkspaceInterruptedForwardPreparation(options.dataDir, options.id)
    if (!facts) throw failure()
    return { workerPlan: facts.checkpoint.closure_plan, workerComplete: facts.checkpoint.closure_commit,
      recoveryPlan: facts.checkpoint.recovery_plan, recoveryComplete: facts.checkpoint.recovery_commit, controlRoot: facts.original.path }
  })
}
