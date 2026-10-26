// A fresh Node process checks actual outcome facts independently of the builder
// process exit status. This is CI evidence, never product execution authority.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const completed = ['source_model_configured_via_http', 'model_substitute', 'source_exited', 'old_mm_stopped', 'target_executable_verified', 'target_main_ready', 'same_instance_new_generation',
  'maintenance_cleared_after_real_health', 'data_preserved', 'normal_peer_policy_verified', 'fixture_core_stopped', 'fixture_gui_stopped', 'temporary_program_copies_removed']
const excluded = ['candidate_channel_enabled', 'remote_model_called', 'fixture_debugger', 'real_login_session_verified', 'renderer_inspected', 'historical_migration_tested', 'os_login_tested']
export function verifyPairedUpdateReport(report, expectedId) {
  assert.match(expectedId, /^\d+-[1-9]\d*-(?:darwin-(?:arm64|x64)|win32-x64|linux-x64)$/)
  assert.ok(report && typeof report === 'object' && !Array.isArray(report))
  assert.equal(report.acceptance_id, expectedId)
  assert.ok(expectedId.endsWith('-' + report.platform + '-' + report.arch))
  for (const key of ['failure_phase', 'failure_code', 'failure_message']) assert.equal(Object.hasOwn(report, key), false)
  for (const key of completed) assert.equal(report[key], true, key)
  for (const key of excluded) assert.equal(report[key], false, key)
  assert.equal(report.source_gui, 'fixture-packaged-component-actor'); assert.equal(report.target_gui, 'ordinary-packaged-main')
  assert.equal(report.target_health_proof, 'ordinary-main-maintenance-completion')
  for (const key of ['source_version', 'target_version']) assert.match(report[key], /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/)
  assert.notEqual(report.source_version, report.target_version)
  const pair = report.selected_pair
  assert.deepEqual(Object.keys(pair).sort(), ['core_id', 'gui_id', 'schema_version', 'version'])
  assert.equal(pair.schema_version, 1); assert.equal(pair.version, report.target_version)
  assert.match(pair.gui_id, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/); assert.match(pair.core_id, /^[a-f0-9]{64}$/)
}
async function main() {
  assert.equal(process.argv.length, 4)
  const file = path.resolve(process.argv[2]), stat = await fs.lstat(file)
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 65536)
  verifyPairedUpdateReport(JSON.parse(await fs.readFile(file, 'utf8')), process.argv[3])
  console.log('CRABOT_PAIRED_UPDATE_RESULT_CONFIRMED')
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  void main().catch(() => { console.error('CRABOT_PAIRED_UPDATE_ACCEPTANCE_REJECTED'); process.exitCode = 1 })
}
