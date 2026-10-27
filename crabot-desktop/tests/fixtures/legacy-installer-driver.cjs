// CI substitutes native dialog input only. Installer, target Node, conversion,
// OS entries, ordinary target Main and business health remain actual product code.
const fs = require('node:fs'), path = require('node:path')
const { app, dialog, shell } = require('electron')
if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Isolated CI only')
const config = JSON.parse(fs.readFileSync(process.env.CRABOT_LEGACY_INSTALLER_DRIVER, 'utf8'))
const record = (name, value) => fs.writeFileSync(path.join(config.control, name + '.json'), JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 })
const fail = error => { record('driver-failed', { message: error.message }); console.error(error); app.exit(2) }
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
  void import('./installer-main.js').catch(fail)
}
