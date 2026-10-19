// Finite Electron relaunch/single-instance fixture. Never loads a Crabot Core.
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const identity = require('../../scripts/lib/process-identity.cjs')
const management = require('../../scripts/lib/desktop-management.cjs')
const [root, role, originalText] = process.argv.slice(2)
const profile = management.ensurePrivateDataRoot(path.join(root, 'profile'))
app.setName('Crabot Pair Relaunch Fixture')
app.setPath('userData', profile); app.setPath('sessionData', profile)
const ownLock = app.requestSingleInstanceLock()
const timeout = setTimeout(() => app.exit(2), 20_000)
let handingOff = false, stopCalls = 0
if (role === 'source') app.on('before-quit', event => {
  if (!handingOff) { stopCalls++; event.preventDefault(); app.exit(3) }
  fs.writeFileSync(path.join(root, 'source-exit.json'), JSON.stringify({ stopCalls }) + '\n', { mode: 0o600, flush: true })
})
void app.whenReady().then(() => {
  if (!ownLock) throw new Error('Single-instance lock unavailable')
  if (role === 'source') {
    const original = identity.inspectProcess(process.pid)
    handingOff = true
    app.relaunch({ execPath: process.execPath, args: [__filename, root, 'target', JSON.stringify(original)] })
    app.quit()
  } else if (role === 'target') {
    const original = JSON.parse(originalText)
    const previousExited = !identity.sameProcess(original, identity.inspectProcess(original.pid))
    const prior = JSON.parse(fs.readFileSync(path.join(root, 'source-exit.json'), 'utf8'))
    const evidence = { previous_exited: previousExited, target_single_instance_lock: ownLock,
      ordinary_stop_calls: prior.stopCalls, business_mm_started: false, different_gui_binary: false }
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(evidence) + '\n', { mode: 0o600, flush: true })
    clearTimeout(timeout); app.exit(previousExited && prior.stopCalls === 0 ? 0 : 4)
  } else throw new Error('Unexpected fixture role')
}).catch(error => { console.error(error.stack); clearTimeout(timeout); app.exit(1) })
