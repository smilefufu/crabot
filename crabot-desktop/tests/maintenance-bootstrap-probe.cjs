// Fixed bootstrap loading only: no application main, Core, session or stop call.
const { app } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const assert = require('node:assert/strict')
async function main() {
  const root = process.env.CRABOT_MAINTENANCE_PROBE_ROOT
  assert.ok(root && path.isAbsolute(root))
  await fs.mkdir(path.join(root, 'profile')); app.setPath('userData', path.join(root, 'profile'))
  await app.whenReady()
  const load = file => import(pathToFileURL(path.join(root, 'app.asar/dist/bootstrap/scripts/lib', file)).href)
  const proof = await load('desktop-removal-proof.mjs'), host = await load('desktop-removal-host.mjs'), controller = await load('instance-controller.mjs')
  assert.equal(typeof proof.captureDesktopRemovalProof, 'function'); assert.equal(typeof proof.readDesktopRemovalProof, 'function')
  assert.equal(typeof host.prepareDesktopRemovalGui, 'function'); assert.equal(typeof host.prepareExistingDesktopRemovalGui, 'function'); assert.equal(typeof controller.stopInstance, 'function')
  const frame = await load('desktop-removal-frame.mjs'); assert.equal(typeof frame.inspectInitialRemovalGuiHost, 'function'); assert.equal(typeof frame.captureExistingRemovalGuiHost, 'function')
  const sourceExit = await load('desktop-removal-source.mjs'); assert.equal(typeof sourceExit.createDesktopRemovalSourceExitVerifier, 'function'); assert.equal(typeof sourceExit.createExistingRemovalSourceExitVerifier, 'function')
  const programs = await load('desktop-removal-programs.mjs'); assert.equal(typeof programs.inspectDesktopRemovalPrograms, 'function')
  const data = await load('desktop-reinstall-data.mjs'); assert.equal(typeof data.inspectDesktopReinstallData, 'function')
  const compatibility = await load('data-compatibility.mjs'); assert.equal(typeof compatibility.verifyDataCompatibility, 'function')
  const reinstall = await load('desktop-reinstall.mjs'); assert.equal(typeof reinstall.prepareDesktopRemovalReinstall, 'function')
  const context = await load('desktop-removal-context.mjs'), deletion = await load('desktop-removal-delete.mjs')
  assert.equal(typeof context.captureDesktopRemovalJob, 'function'); assert.equal(typeof deletion.removeDesktopRemovalPrograms, 'function')
  const job = await load('desktop-removal-job.mjs'); assert.equal(typeof job.beginInitialDesktopRemoval, 'function'); assert.equal(typeof job.resumeDesktopRemoval, 'function')
  const cli = await import(pathToFileURL(path.join(root, 'app.asar/dist/installation-removal.js')).href); assert.equal(typeof cli.removeDesktopCliEntries, 'function'); assert.equal(typeof cli.removeDesktopMenuEntry, 'function'); assert.equal(typeof cli.removeUbuntuAutostartEntry, 'function')
  const native = (await load('process-identity.cjs')).default
  assert.equal(native.inspectProcess(process.pid).pid, process.pid)
  assert.equal(typeof native.inspectProgramReferences, 'function')
  const emptyReferences = await native.inspectProgramReferences({ roots: [], files: [] })
  assert.equal(emptyReferences.complete, true); assert.equal(emptyReferences.incomplete, false); assert.deepEqual(emptyReferences.processes, []); assert.deepEqual(emptyReferences.unknown_pids, [])
  await assert.rejects(fs.lstat(path.join(root, 'crabot-core')), { code: 'ENOENT' })
  const report = { fixed_gui_bootstrap_loaded: true, initial_frame_loaded: true, initial_job_loaded: true, source_exit_verifier_loaded: true, program_inventory_loaded: true, cli_entry_removal_loaded: true, native_helper_loaded: true, native_reference_query_loaded: true, core_present: false, business_mm_started: false,
    stop_called: false, host_executed: false, removal_published: false }
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report), { flag: 'wx' })
}
main().then(() => app.quit()).catch(error => { console.error(error); app.exit(1) })
