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

/** Read-only Agent facts, not execution authority. The fixed Root caller owns fresh role/lock/global-exit checks. */
export async function inspectWorkspaceRelocationClosures({ dataDir, id, verify, signal }: {
  dataDir: string; id: string; verify: () => Promise<unknown>; signal?: AbortSignal
}) {
  if (typeof verify !== 'function') throw failure()
  const records = require(path.join(__dirname, '../../../scripts/lib/workspace-relocation-intent.mjs'))
  const { owned, readJson } = createWorkspaceMaintenanceFileAccess(failure)
  await verify()
  const workerPlan = records.readWorkspaceRelocationClosurePlan(dataDir, id), workerComplete = records.readWorkspaceRelocationClosureCommit(dataDir, id)
  const recoveryPlan = records.readWorkspaceRelocationRecoveryPlan(dataDir, id), recoveryComplete = records.readWorkspaceRelocationRecoveryCommit(dataDir, id)
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
        : readJson(path.join(dataDir, 'workspace-control/relocation-active/relocation-worker-commits', index + '.closed.json'))?.version
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
    if (signal?.aborted || sha256CanonicalJson(records.readWorkspaceRelocationClosurePlan(dataDir, id)) !== workerPlanHash
      || sha256CanonicalJson(records.readWorkspaceRelocationClosureCommit(dataDir, id)) !== workerHash
      || sha256CanonicalJson(records.readWorkspaceRelocationRecoveryPlan(dataDir, id)) !== recoveryPlanHash
      || sha256CanonicalJson(records.readWorkspaceRelocationRecoveryCommit(dataDir, id)) !== recoveryHash) throw failure()
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
