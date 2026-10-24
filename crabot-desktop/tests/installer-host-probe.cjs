// Verifies the shipped ASAR's own backend/preload outside the checkout. Never
// invokes installer-main, OS registration, an install action or a business MM.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const assert = require('node:assert/strict')
app.on('window-all-closed', () => {})
let progress
async function main() {
  const root = process.env.CRABOT_INSTALLER_PROBE_ROOT, payload = process.env.CRABOT_INSTALLER_PROBE_PAYLOAD
  assert.ok(root && payload && path.isAbsolute(root) && path.isAbsolute(payload))
  await fs.mkdir(path.join(root, 'profile')); app.setPath('userData', path.join(root, 'profile'))
  await app.whenReady()
  const archive = path.join(root, 'resources/app.asar'), module = name => import(pathToFileURL(path.join(archive, 'dist', name)).href)
  const backend = await module('bootstrap/scripts/lib/desktop-payload.mjs')
  const removal = await module('bootstrap/scripts/lib/desktop-removal-record.cjs')
  assert.equal(typeof removal.default.readDesktopRemoval, 'function')
  const repair = await module('bootstrap/scripts/lib/desktop-repair.mjs')
  assert.equal(typeof repair.prepareDesktopRepair, 'function'); assert.equal(typeof repair.commitDesktopRepair, 'function')
  const proof = await module('bootstrap/scripts/lib/desktop-removal-proof.mjs')
  assert.equal(typeof proof.captureDesktopRemovalProof, 'function'); assert.equal(typeof proof.readDesktopRemovalProof, 'function')
  const checked = await backend.verifyDesktopPayload(payload)
  assert.ok(checked.bytes > 0n)
  const entries = await module('installation-entries.js')
  assert.equal(typeof entries.registerInstallationEntries, 'function')
  const { createInstallationProgressWindow } = await module('installation-progress-window.js')
  const abort = new AbortController(); progress = createInstallationProgressWindow(abort); await progress.ready
  const window = BrowserWindow.getAllWindows()[0]
  assert.deepEqual(await window.webContents.executeJavaScript('Object.keys(window.crabotInstall).sort()'), ['cancel', 'subscribe'])
  assert.equal(await window.webContents.executeJavaScript('typeof require'), 'undefined')
  await window.webContents.executeJavaScript('window.crabotInstall.cancel()')
  assert.equal(abort.signal.aborted, true)
  progress.close()
  const report = { trusted_backend_in_asar: true, trusted_repair_backend_in_asar: true, trusted_removal_reader_in_asar: true, trusted_removal_proof_in_asar: true, opaque_payload_verified: true, sandboxed_progress_preload: true,
    outside_checkout: true, actual_installer_flow: false, business_mm_started: false }
  await fs.writeFile(path.join(root, 'probe-report.json'), JSON.stringify(report), { flag: 'wx' })
  console.log('CRABOT_INSTALLER_HOST ' + JSON.stringify(report))
}
main().then(() => app.quit()).catch(error => { console.error(error); try { progress?.close() } finally { app.exit(1) } })
