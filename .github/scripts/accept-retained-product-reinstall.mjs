// CI fixture for U5 only: the partial-removal state is authored explicitly.
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
import { prepareDesktopRemovalReinstall } from '../../scripts/lib/desktop-reinstall.mjs'
import { runPreparedDesktopReinstallHandoff } from '../../scripts/lib/desktop-reinstall-data.mjs'
import identity from '../../scripts/lib/process-identity.cjs'
import { desktopRemovalProgramEntries } from '../../scripts/lib/desktop-removal-programs.mjs'
import { assertDesktopRemovalProgramsUnused } from '../../scripts/lib/desktop-removal-delete.mjs'
import { verifyDesktopPayload } from '../../scripts/lib/desktop-payload.mjs'

export async function prepareRetainedProductReinstall({ installRoot, payload }) {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Requires an isolated CI user, never a developer deployment')
  const own = installation.readDesktopSelection(installRoot), source = await verifyDesktopPayload(payload)
  assert.deepEqual(own.selection, source.record.selection)
  const space = await fs.statfs(own.root, { bigint: true })
  assert.ok(space.bavail * space.bsize > source.bytes * 3n + 2n * 1024n ** 3n, 'Retained repair requires bounded program-copy space')
  const operationId = randomUUID(), sentinel = path.join(own.dataDir, 'retained-reinstall-sentinel.txt')
  assert.equal(inspectInstance(own.dataDir).state, 'stopped')
  // This installation belongs to the disposable CI fixture. Exercise legacy
  // readable roots without changing any real deployment or private records.
  if (process.platform !== 'win32') { await fs.chmod(own.root, 0o755); await fs.chmod(own.dataDir, 0o755) }
  await fs.writeFile(sentinel, 'preserved across partial removal and real GUI recovery\n', { flag: 'wx', mode: 0o600 })
  const rootLock = await acquireExistingCliLock(own.root, 'ci-retained-removal-fixture')
  let dataLock, proof
  try {
    dataLock = await acquireExistingCliLock(own.dataDir, 'ci-retained-removal-fixture')
    assert.equal(inspectInstance(own.dataDir).state, 'stopped')
    proof = await captureDesktopRemovalProof(own.root, operationId)
    try { await assertDesktopRemovalProgramsUnused({ installRoot: own.root, proof }, 'ci-before-partial-removal') }
    catch (error) {
      // Read-only bounded diagnostics. Never convert this second observation
      // into permission to bypass the failed guard or mutate fixture programs.
      const files = desktopRemovalProgramEntries(proof).map(entry => path.join(own.root, entry.name))
      const started = performance.now()
      try {
        const result = await identity.inspectProgramReferences({ roots: [own.coreRoot, own.guiRoot, path.join(own.root, 'bin')], files })
        console.log('CRABOT_RETAINED_REFERENCE_DIAGNOSIS ' + JSON.stringify({ file_count: files.length, max_path_length: files.reduce((maximum, file) => Math.max(maximum, file.length), 0),
          elapsed_ms: Math.round(performance.now() - started), complete: result.complete, incomplete: result.incomplete,
          holders: result.processes.slice(0, 8).map(item => ({ pid: item.pid, parent: item.parent, image: path.basename(item.executable) })),
          holder_count: result.processes.length, unknown_count: result.unknown_pids.length, unknown: result.unknown_details.slice(0, 8) }))
      } catch (diagnostic) { console.log('CRABOT_RETAINED_REFERENCE_DIAGNOSIS ' + JSON.stringify({ file_count: files.length, code: diagnostic.code || 'DIAGNOSIS_UNAVAILABLE' })) }
      throw error
    }
    const directory = management.ensurePrivateDataRoot(path.join(management.ensurePrivateDataRoot(path.join(own.root, 'app/removals')), operationId))
    const text = JSON.stringify(proof) + '\n'
    await privateJson(path.join(directory, 'proof.json'), proof)
    await privateJson(path.join(own.root, '.desktop-removal.json'), { schema_version: 1, installation_id: own.record.installation_id,
      operation_id: operationId, source_selection: own.selection, phase: 'removing', proof_sha256: createHash('sha256').update(text).digest('hex') })
    // Exactly one known sealed program file is removed after the guard. User
    // data/workspaces and executable runtimes remain untouched by this fixture.
    assert.equal(JSON.parse(proof.core.inventory).files['cli.mjs'].type, 'file')
    await fs.unlink(path.join(own.coreRoot, 'cli.mjs'))
  } finally { if (dataLock) releaseCliLock(dataLock); releaseCliLock(rootLock) }
  assert.throws(() => installation.readDesktopSelection(own.root), { code: 'CRABOT_DESKTOP_REMOVAL_PENDING' })
  const options = { payload, installRoot: own.root, operationId,
    verifyStopped: () => assertDesktopRemovalProgramsUnused({ installRoot: own.root, proof }, 'ci-reinstall') }
  await prepareDesktopRemovalReinstall(options)
  const handoff = await runPreparedDesktopReinstallHandoff({ payload, installRoot: own.root, operationId,
    // OS menu registration is covered by actual ordinary installer tests; this
    // fixture exercises the Core/GUI health boundary, not a replacement shell.
    registerEntries: async prepared => assert.deepEqual(prepared.selection, own.selection) })
  assert.equal(handoff.verification_pending, true); assert.equal(handoff.health_verified, false)
  assert.equal(inspectInstance(own.dataDir).state, 'stopped')
  assert.ok(await fs.stat(path.join(own.dataDir, 'desktop-maintenance.json')))
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'preserved across partial removal and real GUI recovery\n')
  return { sentinel, maintenanceId: handoff.maintenance_id, partial_removal_fixture: true, complete_uninstall_tested: false }
}
