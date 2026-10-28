// CI-only native-dialog/menu driver. The ordinary Main and all removal modules
// run unchanged; this contains no controller, lifecycle or file-deletion logic.
const fs = require('node:fs')
const path = require('node:path')
const { app, dialog, Menu, shell } = require('electron')
if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Isolated CI only')
// Electron's own CI uses this for unsigned apps without a login keychain:
// https://github.com/electron/electron/pull/53790 . No product argument is changed.
if (process.platform === 'darwin') app.commandLine.appendSwitch('use-mock-keychain')
const config = JSON.parse(fs.readFileSync(process.env.CRABOT_UNINSTALL_MAIN_DRIVER, 'utf8'))
const event = (name, fields = {}) => {
  const file = path.join(config.control, name + '.json'), temporary = file + '.tmp-' + process.pid
  fs.writeFileSync(temporary, JSON.stringify({ pid: process.pid, ...fields }) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file)
}
const failure = details => {
  const diagnostic = details instanceof Error ? { message: details.message, code: details.code } : details
  if (!fs.existsSync(path.join(config.control, 'driver-failed.json'))) event('driver-failed', { diagnostic })
  console.error('CRABOT_UNINSTALL_DRIVER_FAILED ' + JSON.stringify({ pid: process.pid, diagnostic }))
  app.exit(2)
}
const originalError = console.error
console.error = (...args) => {
  fs.appendFileSync(path.join(config.control, 'driver-error-' + process.pid + '.log'), args.map(value => String(value)).join(' ') + '\n')
  originalError(...args)
}
// Observe the ordinary Main's actual quit path without bypassing any handler.
for (const phase of ['before-quit', 'will-quit', 'quit']) app.on(phase, event => {
  console.error('CRABOT_UNINSTALL_QUIT ' + JSON.stringify({ phase, pid: process.pid, prevented: event.defaultPrevented,
    active_resources: process.getActiveResourcesInfo(), windows: require('electron').BrowserWindow.getAllWindows().map(window => ({ id: window.id, destroyed: window.isDestroyed() })) }))
})
app.on('browser-window-created', (_event, window) => window.on('close', event => {
  queueMicrotask(() => console.error('CRABOT_UNINSTALL_WINDOW_CLOSE ' + JSON.stringify({ pid: process.pid, id: window.id, prevented: event.defaultPrevented, destroyed: window.isDestroyed() })))
}))
const host = process.argv.some(value => value.startsWith('--crabot-removal-host='))
if (host) {
  if (process.platform === 'darwin') {
    const getLoginItemSettings = app.getLoginItemSettings.bind(app)
    app.getLoginItemSettings = (...args) => {
      const value = getLoginItemSettings(...args)
      console.error('CRABOT_UNINSTALL_LOGIN_STATE ' + JSON.stringify({ openAtLogin: value.openAtLogin, status: value.status }))
      return value
    }
  }
  const identity = require('./bootstrap/scripts/lib/process-identity.cjs')
  const gui = process.platform === 'darwin' ? path.resolve(process.resourcesPath, '../../..') : path.dirname(process.resourcesPath)
  event('maintenance-started', { identity: identity.inspectProcess(process.pid), directory: path.dirname(gui) })
}
dialog.showMessageBox = async (...args) => {
  const options = args.at(-1)
  if (options.title === '卸载 Crabot' && options.buttons?.[1] === '卸载并保留数据') {
    event('confirmed'); return { response: 1, checkboxChecked: false }
  }
  if (options.title === 'Crabot 已卸载' && options.buttons?.[0] === '关闭') {
    event('completed-dialog'); return { response: 0, checkboxChecked: false }
  }
  failure({ dialog: { title: options.title, message: options.message, detail: options.detail, buttons: options.buttons } })
  throw new Error('Unexpected native dialog')
}
const timer = setTimeout(failure, 20 * 60 * 1000)
timer.unref()
if (!host && !config.registration) {
  const inspect = setInterval(async () => {
    if (!fs.existsSync(path.join(config.control, 'allow-remove'))) return
    const items = Menu.getApplicationMenu()?.items.flatMap(item => item.submenu?.items || []) || []
    const item = items.find(value => value.label === '卸载 Crabot…')
    if (!item?.enabled) return
    clearInterval(inspect)
    try {
      const { registerInstallationEntries } = await import('./installation-entries.js')
      await registerInstallationEntries(config.prepared, { home: require('node:os').homedir(), platform: process.platform, env: process.env, shell })
      event('entries-registered'); event('menu-clicked'); item.click(item, undefined, {})
    } catch (error) { failure(error) }
  }, 100)
  inspect.unref()
}
if (config.registration) {
  const profile = path.join(config.control, 'registration-profile')
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 }); app.setPath('userData', profile)
  void app.whenReady().then(async () => {
    const options = { home: require('node:os').homedir(), platform: process.platform, env: process.env, shell }
    if (config.registration === 'remove') {
      const { removeInstallationEntries } = await import('./installation-removal.js')
      const { inspectInstance } = await import('./bootstrap/scripts/lib/instance-runtime.mjs')
      await removeInstallationEntries(config.prepared, { ...options, verifyStopped: async () => {
        if (inspectInstance(path.join(config.prepared.installRoot, 'data')).state !== 'stopped') throw new Error('Fixture still running')
      } })
      event('entries-cleaned')
    } else {
      const { registerInstallationEntries } = await import('./installation-entries.js')
      await registerInstallationEntries(config.prepared, options); event('entries-restored')
    }
    app.exit(0)
  }).catch(failure)
} else void import('./main.js').catch(failure)
