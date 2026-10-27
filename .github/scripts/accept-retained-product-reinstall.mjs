// CI fixture for U5: the removing record is authored explicitly; program deletion can be real.
// Program preparation/handoff and the subsequent ordinary GUI/Core are real.
// This does not stand in for the complete uninstall UI/host lifecycle.
import assert from 'node:assert/strict'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import installation from '../../scripts/lib/desktop-installation.cjs'
import management from '../../scripts/lib/desktop-management.cjs'
import { inspectInstance } from '../../scripts/lib/instance-runtime.mjs'
import { acquireExistingCliLock, releaseCliLock } from '../../scripts/lib/cli-lock.mjs'
import { captureDesktopRemovalProof } from '../../scripts/lib/desktop-removal-proof.mjs'
import { privateJson } from '../../scripts/lib/desktop-preparation-files.mjs'
import { prepareDesktopRemovalReinstall, assertReinstallVersion } from '../../scripts/lib/desktop-reinstall.mjs'
import { runPreparedDesktopReinstallHandoff } from '../../scripts/lib/desktop-reinstall-data.mjs'
import identity from '../../scripts/lib/process-identity.cjs'
import { desktopRemovalProgramEntries } from '../../scripts/lib/desktop-removal-programs.mjs'
import { assertDesktopRemovalProgramsUnused, removeDesktopRemovalPrograms } from '../../scripts/lib/desktop-removal-delete.mjs'
import { verifyDesktopPayload } from '../../scripts/lib/desktop-payload.mjs'

export async function prepareRetainedProductReinstall({ installRoot, payload, preparePrograms = async () => {}, removeAllPrograms = false }) {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Requires an isolated CI user, never a developer deployment')
  assert.equal(typeof removeAllPrograms, 'boolean')
  const started = performance.now()
  const stage = name => console.log('CRABOT_RETAINED_REPAIR_STAGE ' + JSON.stringify({ stage: name, elapsed_ms: Math.round(performance.now() - started) }))
  stage('source-verification')
  const own = installation.readDesktopSelection(installRoot), source = await verifyDesktopPayload(payload)
  stage('source-verified')
  assertReinstallVersion(own.selection.version, source.record.selection.version)
  const space = await fs.statfs(own.root, { bigint: true })
  assert.ok(space.bavail * space.bsize > source.bytes * 3n + 2n * 1024n ** 3n, 'Retained repair requires bounded program-copy space')
  const operationId = randomUUID(), sentinel = path.join(own.dataDir, 'retained-reinstall-sentinel.txt')
  assert.equal(inspectInstance(own.dataDir).state, 'stopped')
  // This installation belongs to the disposable CI fixture. Exercise legacy
  // readable roots without changing any real deployment or private records.
  if (process.platform !== 'win32') { await fs.chmod(own.root, 0o755); await fs.chmod(own.dataDir, 0o755) }
  await fs.writeFile(sentinel, 'preserved across program removal and real GUI recovery\n', { flag: 'wx', mode: 0o600 })
  const rootLock = await acquireExistingCliLock(own.root, 'ci-retained-removal-fixture')
  let dataLock, proof
  const withReferenceDiagnosis = async (stage, action) => {
    const inspect = identity.inspectProgramReferences
    let observation
    // Preserve the first actual observation on failure; a second query can hide
    // a transient process generation change. Results and product policy are unchanged.
    identity.inspectProgramReferences = async query => { observation = await inspect(query); return observation }
    try { return await action() }
    catch (error) {
      if (observation) console.log('CRABOT_RETAINED_REFERENCE_DIAGNOSIS ' + JSON.stringify({ stage: error.stage ?? stage,
        inventory_file_count: desktopRemovalProgramEntries(proof).length, complete: observation.complete, incomplete: observation.incomplete,
        holders: observation.processes.slice(0, 8).map(item => ({ pid: item.pid, parent: item.parent, image: path.basename(item.executable) })),
        holder_count: observation.processes.length, unknown_count: observation.unknown_pids.length, unknown: observation.unknown_details.slice(0, 16) }))
      throw error
    } finally { identity.inspectProgramReferences = inspect }
  }
  const verifyUnused = stage => withReferenceDiagnosis(stage, () => assertDesktopRemovalProgramsUnused({ installRoot: own.root, proof }, stage))
  try {
    dataLock = await acquireExistingCliLock(own.dataDir, 'ci-retained-removal-fixture')
    assert.equal(inspectInstance(own.dataDir).state, 'stopped')
    stage('fixture-proof-capture')
    proof = await captureDesktopRemovalProof(own.root, operationId)
    stage('fixture-proof-captured')
    await verifyUnused('ci-before-partial-removal')
    stage('fixture-programs-unused')
    const directory = management.ensurePrivateDataRoot(path.join(management.ensurePrivateDataRoot(path.join(own.root, 'app/removals')), operationId))
    const text = JSON.stringify(proof) + '\n'
    await privateJson(path.join(directory, 'proof.json'), proof)
    await privateJson(path.join(own.root, '.desktop-removal.json'), { schema_version: 1, installation_id: own.record.installation_id,
      operation_id: operationId, source_selection: own.selection, phase: 'removing', proof_sha256: createHash('sha256').update(text).digest('hex') })
    if (removeAllPrograms) {
      const removed = await withReferenceDiagnosis('ci-program-removal', () => removeDesktopRemovalPrograms({ installRoot: own.root, operationId }))
      assert.deepEqual(removed.retained, [])
      for (const directory of [own.coreRoot, own.guiRoot]) await assert.rejects(fs.lstat(directory), { code: 'ENOENT' })
      stage('fixture-all-programs-removed')
    } else {
      // Preserve an interrupted partial-deletion case alongside the full program
      // removal case. Neither fixture asserts OS-entry or UI lifecycle completion.
      assert.equal(JSON.parse(proof.core.inventory).files['cli.mjs'].type, 'file')
      await fs.unlink(path.join(own.coreRoot, 'cli.mjs'))
    }
  } finally { if (dataLock) releaseCliLock(dataLock); releaseCliLock(rootLock) }
  assert.throws(() => installation.readDesktopSelection(own.root), { code: 'CRABOT_DESKTOP_REMOVAL_PENDING' })
  const options = { payload, installRoot: own.root, operationId,
    verifyStopped: () => verifyUnused('ci-reinstall') }
  stage('fixture-ready')
  await prepareDesktopRemovalReinstall({ ...options, progress: phase => stage('programs-' + phase) })
  stage('handoff-start')
  const handoff = await runPreparedDesktopReinstallHandoff({ payload, installRoot: own.root, operationId,
    // OS menu registration is covered by actual ordinary installer tests; this
    // fixture exercises the Core/GUI health boundary, not a replacement shell.
    registerEntries: async prepared => { assert.deepEqual(prepared.selection, source.record.selection); await preparePrograms(prepared) } })
  stage('handoff-completed')
  assert.equal(handoff.verification_pending, true); assert.equal(handoff.health_verified, false)
  assert.equal(inspectInstance(own.dataDir).state, 'stopped')
  assert.ok(await fs.stat(path.join(own.dataDir, 'desktop-maintenance.json')))
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'preserved across program removal and real GUI recovery\n')
  return { sentinel, maintenanceId: handoff.maintenance_id, executable: handoff.executable, coreRoot: path.join(own.root, 'releases', source.record.selection.core_id),
    selection: source.record.selection, partial_removal_fixture: !removeAllPrograms, complete_program_removal: removeAllPrograms, complete_uninstall_tested: false }
}
