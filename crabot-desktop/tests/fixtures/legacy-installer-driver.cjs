// CI substitutes native dialog input only. Installer, target Node, conversion,
// OS entries, ordinary target Main and business health remain actual product code.
const fs = require('node:fs'), path = require('node:path')
process.stderr.write('CRABOT_LEGACY_INSTALLER_DRIVER_ENTRY\n')
if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Isolated CI only')
const config = JSON.parse(fs.readFileSync(process.env.CRABOT_LEGACY_INSTALLER_DRIVER, 'utf8'))
const record = (name, value) => fs.writeFileSync(path.join(config.control, name + '.json'), JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 })
record(config.cleanup ? 'cleanup-driver-started' : 'driver-started', { phase: 'entry' })
const { app, dialog, shell } = require('electron')
if (process.platform === 'win32' && !config.cleanup) {
  const dumps = path.join(config.control, 'crashes'); fs.mkdirSync(dumps)
  app.setPath('crashDumps', dumps)
  require('electron').crashReporter.start({ uploadToServer: false, submitURL: '', compress: false })
}
if (!config.cleanup) app.once('ready', () => record('driver-ready', { phase: 'app-ready' }))
app.once('quit', (_event, code) => record(config.cleanup ? 'cleanup-driver-quit' : 'driver-quit', { code }))
let failed = false
const fail = error => {
  if (failed) return
  failed = true; record('driver-failed', { message: error.message }); console.error(error); app.exit(2)
}
if (config.cleanup) {
  const profile = path.join(config.control, 'cleanup-profile'); fs.mkdirSync(profile, { mode: 0o700 })
  app.setPath('userData', profile)
  void app.whenReady().then(async () => {
    const { removeInstallationEntries } = await import('./installation-removal.js')
    const { inspectInstance } = await import('./bootstrap/scripts/lib/instance-runtime.mjs')
    await removeInstallationEntries(config.prepared, { home: require('node:os').homedir(), platform: process.platform, env: process.env, shell,
      verifyStopped: async () => { if (inspectInstance(path.join(config.prepared.installRoot, 'data')).state !== 'stopped') throw new Error('CI fixture still running') } })
    record('entries-cleaned', true); app.exit(0)
  }).catch(fail)
} else {
  // Observe the real target's stderr only in this isolated, dummy-data CI run.
  // The host intentionally presents a bounded error code to end users.
  const childProcess = require('node:child_process'), spawn = childProcess.spawn
  childProcess.spawn = function (file, args, options) {
    const takeover = args?.some(value => typeof value === 'string' && value.endsWith(path.join('scripts', 'lib', 'legacy-desktop-takeover.mjs')))
    if (takeover && process.platform === 'win32' && process.env.PSModuleAnalysisCachePath
      && options.env.PSModuleAnalysisCachePath !== process.env.PSModuleAnalysisCachePath) throw new Error('Target lost the host PowerShell module cache location')
    const child = spawn.call(this, file, args, options)
    if (takeover) {
      child.stderr?.on('data', bytes => process.stderr.write('CRABOT_CI_TARGET_STDERR ' + bytes.toString()))
    }
    return child
  }
  require('node:module').syncBuiltinESMExports()
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [config.installRoot] })
  dialog.showMessageBox = async (...args) => {
    const options = args.at(-1)
    if (options.title === '安装 Crabot') return { response: 0 }
    if (options.title === '接管已有 Crabot' && options.buttons?.[0] === '接管并保留数据') {
      record('takeover-confirmed', { detail: options.detail }); return { response: 0 }
    }
    if (options.title === '继续恢复服务') { record('installer-handoff', true); return { response: 1 } }
    fail(new Error('Unexpected installer dialog: ' + JSON.stringify(options)))
    throw new Error('Unexpected installer dialog')
  }
  void import('./installer-main.js').then(() => record('driver-imported', { phase: 'installer-imported' })).catch(fail)
}
