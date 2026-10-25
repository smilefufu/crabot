// Actual immutable GUI/Core archive acceptance only. Test key remains in memory;
// no target preview, OS registration, business Core or model can be started here.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, generateKeyPairSync, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import physicalFs from '../../scripts/lib/physical-fs.cjs'
import product from '../../scripts/lib/product-runtime.cjs'
import { verifyCoreRelease } from '../../scripts/lib/core-release.mjs'
import { verifyDesktopPayload } from '../../scripts/lib/desktop-payload.mjs'
import { writeSignedDesktopPayload } from '../../scripts/desktop/sign-release.mjs'
import { createDesktopReleaseIntake } from '../../crabot-desktop/dist/release-intake.js'
import { startDesktopDiskObservation } from './desktop-disk.mjs'
const { promises: fs } = physicalFs
const management = createRequire(import.meta.url)('../../scripts/lib/desktop-management.cjs')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), build = path.join(root, '.desktop-build')
const reportFile = path.join(build, 'complete-paired-release.json'), reserve = 1024n ** 3n
let phase = 'arguments', job, intake, stage, observation
const report = { schema_version: 1, platform: process.platform, arch: process.arch, candidate_only: true, release_signed: false,
  formal_channel_enabled: false, full_signed_archive_verified: false, full_gui_and_core_verified: false,
  target_runtime_executed: false, business_mm_started: false, provider_called: false, gui_handoff: false, os_signing: 'not_verified_by_this_check' }
async function main() {
  if (process.argv.length !== 4) throw new Error('Expected trusted runtime Core and actual paired payload')
  const core = await fs.realpath(path.resolve(process.argv[2])), payload = await fs.realpath(path.resolve(process.argv[3]))
  phase = 'verify-runtime'
  const release = await verifyCoreRelease(core), runtime = product.loadProductRuntime(core, { required: true, full: true })
  phase = 'verify-payload'
  const verified = await verifyDesktopPayload(payload)
  if (release.source_dirty) throw new Error('Actual candidate must have clean product source')
  if (process.platform === 'linux' && !['resources/crabot-sandbox-helper', 'resources/crabot-maintenance', 'resources/browser-probe.py'].every(name => verified.record.gui[name]?.type === 'file')) throw new Error('Signed Ubuntu GUI must cover all fixed native maintenance resources')
  if (verified.record.selection.version !== release.version || verified.record.selection.core_id !== release.inventory_sha256) throw new Error('Runtime Core and paired payload mismatch')
  const space = await fs.statfs(build, { bigint: true }), maximum = verified.bytes * 2n + reserve
  if (maximum > 20n * reserve || space.bavail * space.bsize < maximum) throw Object.assign(new Error('Complete archive check needs bounded program-copy space'), { code: 'CRABOT_UPDATE_SPACE' })
  observation = await startDesktopDiskObservation(build)
  job = management.ensurePrivateDataRoot(path.join(build, 'signed-verification-' + randomUUID()))
  const keys = generateKeyPairSync('ed25519'), publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  phase = 'archive'
  const published = await writeSignedDesktopPayload({ payload, python: runtime.executables.python,
    privateKeys: [keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()], output: path.join(job, 'publication') })
  intake = createDesktopReleaseIntake({ pinnedPublicKeys: [publicKey], python: runtime.executables.python, cacheRoot: path.join(job, 'cache'),
    verifyPayload: verifyDesktopPayload, preparePair: async () => { throw new Error('This check must never prepare or execute a target program') } })
  phase = 'authenticate-expand'
  stage = await intake.stage({ manifestBytes: await fs.readFile(published.manifestFile), signatureBytes: await fs.readFile(published.signaturesFile),
    artifact: published.artifact, context: { platform: process.platform, arch: process.arch, purpose: 'install' } })
  Object.assign(report, { source_commit: release.commit, source_dirty: release.source_dirty, selection: stage.manifest.selection,
    artifact: stage.manifest.artifact, full_signed_archive_verified: true, full_gui_and_core_verified: true,
    bundled_python: runtime.manifest.versions.python, key_id: createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex'),
    public_test_key: publicKey })
  phase = 'complete'
}
try { await main() }
catch (error) {
  report.failure_phase = phase
  const code = error?.code
  report.failure_code = ['CRABOT_UPDATE_SPACE', 'ENOSPC', 'CRABOT_CORE_INTEGRITY', 'CRABOT_DESKTOP_RELEASE_METADATA',
    'CRABOT_DESKTOP_RELEASE_SIGNATURE', 'CRABOT_DESKTOP_RELEASE_INTEGRITY'].includes(code) ? code : 'COMPLETE_PAIR_CHECK_FAILED'
  process.exitCode = 1
} finally {
  try {
    if (stage) await intake.discard(stage)
    if (job) await fs.rm(job, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    report.temporary_program_copies_removed = true
  } catch { report.temporary_program_copies_removed = false; process.exitCode = 1 }
  if (observation) report.disk = await observation.stop()
  await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600, flush: true })
  console.log('CRABOT_COMPLETE_PAIRED_RELEASE ' + JSON.stringify({ ...report, public_test_key: undefined }))
}
