// Real main-process entry, with an isolated synthetic installation. No MM.
const { app, dialog } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { syncBuiltinESMExports } = require('node:module')
const options = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
app.setPath('userData', options.profile); app.setPath('sessionData', options.profile)
Object.defineProperty(app, 'isPackaged', { value: true })
Object.defineProperty(process, 'resourcesPath', { value: options.resources })
const readSync = fs.readFileSync
fs.readFileSync = (file, ...rest) => typeof file === 'string' && path.resolve(file) === path.resolve(__dirname, '../dist/desktop-release.json')
  ? JSON.stringify(options.pin) + '\n' : readSync(file, ...rest)
syncBuiltinESMExports()
if (options.scenario === 'profile-before-ready') {
  const physical = require('original-fs').promises, readPhysical = physical.readFile
  let waited = false, earlyLock = false
  const requestLock = app.requestSingleInstanceLock.bind(app)
  app.requestSingleInstanceLock = () => { earlyLock = !app.isReady() && !waited; return requestLock() }
  physical.readFile = async (file, ...rest) => {
    if (path.resolve(file) === path.join(options.core, 'core-files.json')) { await app.whenReady(); waited = true }
    return readPhysical(file, ...rest)
  }
  const setPath = app.setPath.bind(app), calls = []
  app.setPath = (name, directory) => {
    if (['userData', 'sessionData', 'temp'].includes(name)) calls.push({ name, directory, beforeReady: !app.isReady() })
    const result = setPath(name, directory)
    if (calls.length === 3 && fs.existsSync(options.marker)) setImmediate(reportProfile)
    return result
  }
  const reportProfile = () => {
    fs.writeFileSync(options.report, JSON.stringify({ external_core_executed: fs.existsSync(options.marker),
      profile_bound_before_ready: calls.length === 3 && calls.every(call => call.beforeReady),
      profile_matches_installation: calls.length === 3 && calls.every(call => call.directory === path.join(options.data, 'desktop-profile', call.name === 'temp' ? 'tmp' : '')),
      core_verification_waited_for_ready: waited, instance_lock_before_verification: earlyLock, business_mm_started: false, actual_packaged_binary: false }) + '\n', { mode: 0o600 })
    app.exit(0)
  }
  process.once('crabot-profile-binding-fixture-core', () => { if (calls.length === 3) setImmediate(reportProfile) })
}
let message = ''
dialog.showMessageBox = async value => { message = value.message; return { response: 0 } }
const timeout = setTimeout(() => app.exit(2), 15_000)
app.on('will-quit', () => {
  clearTimeout(timeout)
  fs.writeFileSync(options.report, JSON.stringify({ external_core_executed: fs.existsSync(options.marker),
    repair_shown: /修复/.test(message), removal_shown: /卸载/.test(message), data_entries: fs.readdirSync(options.data), business_mm_started: false,
    actual_packaged_binary: false }) + '\n', { mode: 0o600, flush: true })
})
void import(pathToFileURL(path.resolve(__dirname, '../dist/main.js')).href).catch(error => {
  console.error(error.stack); clearTimeout(timeout); app.exit(1)
})
