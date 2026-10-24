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
  assert.equal(typeof host.prepareDesktopRemovalGui, 'function'); assert.equal(typeof controller.stopInstance, 'function')
  const native = (await load('process-identity.cjs')).default
  assert.equal(native.inspectProcess(process.pid).pid, process.pid)
  await assert.rejects(fs.lstat(path.join(root, 'crabot-core')), { code: 'ENOENT' })
  const report = { fixed_gui_bootstrap_loaded: true, native_helper_loaded: true, core_present: false, business_mm_started: false,
    stop_called: false, host_executed: false, removal_published: false }
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report), { flag: 'wx' })
}
main().then(() => app.quit()).catch(error => { console.error(error); app.exit(1) })
