import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { verifyPairedUpdateReport } from './check-paired-update-report.mjs'
const expectedId = '12345-1-darwin-arm64', checker = fileURLToPath(new URL('check-paired-update-report.mjs', import.meta.url))
const complete = () => ({ acceptance_id: expectedId, platform: 'darwin', arch: 'arm64', candidate_channel_enabled: false, remote_model_called: false,
  source_model_configured_via_http: true, higher_retained_reinstall_verified: true, model_substitute: true, source_gui: 'fixture-packaged-component-actor', target_gui: 'ordinary-packaged-main', fixture_debugger: false, real_login_session_verified: false,
  source_version: '1.2.3', target_version: '1.2.4-desktop-fixture.1', selected_pair: { schema_version: 1, version: '1.2.4-desktop-fixture.1',
    gui_id: '01234567-1234-1234-1234-123456789abc', core_id: 'a'.repeat(64) }, source_exited: true, old_mm_stopped: true,
  target_executable_verified: true, target_main_ready: true, same_instance_new_generation: true, maintenance_cleared_after_real_health: true,
  data_preserved: true, normal_peer_policy_verified: true, target_health_proof: 'ordinary-main-maintenance-completion', renderer_inspected: false,
  historical_migration_tested: false, os_login_tested: false, fixture_core_stopped: true, fixture_gui_stopped: true, temporary_program_copies_removed: true })
for (const mode of ['complete', 'observed-zero-exit-failure', 'stale', 'missing-health', 'source-unconfigured', 'higher-reinstall-unverified', 'cleanup', 'wrong-pair', 'peer-bypass', 'contradictory', 'absent']) {
  test('independent paired update result gate: ' + mode, async t => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'crabot-update-result-')); t.after(() => fs.rm(root, { recursive: true, force: true }))
    const file = path.join(root, 'report.json'), report = complete()
    if (mode === 'observed-zero-exit-failure') {
      const producer = path.join(root, 'producer.mjs')
      await fs.writeFile(producer, `import fs from 'node:fs';fs.writeFileSync(process.argv[2], JSON.stringify({acceptance_id:${JSON.stringify(expectedId)},failure_phase:'source-start-and-update',failure_code:'PAIRED_HOST_ACCEPTANCE_FAILED',fixture_core_stopped:true,fixture_gui_stopped:true}));process.exitCode=0;`)
      await promisify(execFile)(process.execPath, [producer, file]) // Actual producer returns zero, as the observed CI did.
    } else if (mode !== 'absent') {
      if (mode === 'stale') report.acceptance_id = '12344-1-darwin-arm64'
      else if (mode === 'missing-health') delete report.maintenance_cleared_after_real_health
      else if (mode === 'source-unconfigured') delete report.source_model_configured_via_http
      else if (mode === 'higher-reinstall-unverified') delete report.higher_retained_reinstall_verified
      else if (mode === 'cleanup') report.temporary_program_copies_removed = false
      else if (mode === 'wrong-pair') report.selected_pair.version = '1.2.3'
      else if (mode === 'peer-bypass') report.normal_peer_policy_verified = false
      else if (mode === 'contradictory') report.failure_code = 'FAILED_DESPITE_OTHER_TRUE_FLAGS'
      await fs.writeFile(file, JSON.stringify(report))
    }
    if (mode === 'complete') {
      const result = await promisify(execFile)(process.execPath, [checker, file, expectedId])
      assert.match(result.stdout, /CRABOT_PAIRED_UPDATE_RESULT_CONFIRMED/)
    } else await assert.rejects(promisify(execFile)(process.execPath, [checker, file, expectedId]), error => {
      assert.equal(error.code, 1); assert.match(error.stderr, /CRABOT_PAIRED_UPDATE_ACCEPTANCE_REJECTED/); return true
    })
  })
}

test('the same actual outcome requirements cover Linux x64 without accepting mismatched platforms', () => {
  const report = { ...complete(), acceptance_id: '12345-1-linux-x64', platform: 'linux', arch: 'x64' }
  assert.doesNotThrow(() => verifyPairedUpdateReport(report, report.acceptance_id))
  assert.throws(() => verifyPairedUpdateReport({ ...report, target_main_ready: false }, report.acceptance_id))
  assert.throws(() => verifyPairedUpdateReport({ ...report, arch: 'arm64' }, report.acceptance_id))
  assert.throws(() => verifyPairedUpdateReport({ ...report, acceptance_id: '12345-1-linux-arm64', arch: 'arm64' }, '12345-1-linux-arm64'))
})
