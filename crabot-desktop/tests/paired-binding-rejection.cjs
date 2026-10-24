// Real main-process entry, with an isolated synthetic installation. No MM.
const { app, dialog } = require('electron')
const fs = require('node:fs')
const promises = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { syncBuiltinESMExports } = require('node:module')
const options = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
app.setPath('userData', options.profile); app.setPath('sessionData', options.profile)
Object.defineProperty(app, 'isPackaged', { value: true })
Object.defineProperty(process, 'resourcesPath', { value: options.resources })
const read = promises.readFile
promises.readFile = (file, ...rest) => path.resolve(file) === path.resolve(__dirname, '../dist/desktop-release.json')
  ? Promise.resolve(JSON.stringify(options.pin) + '\n') : read(file, ...rest)
syncBuiltinESMExports()
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
