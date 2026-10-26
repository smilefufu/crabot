// Actual ordinary installer entry/progress window in a disposable HOME. Dialog
// choices and macOS LaunchServices registration are controlled; no MM is started.
const { app, dialog } = require('electron')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), childProcess = require('node:child_process')
const { syncBuiltinESMExports } = require('node:module'), { pathToFileURL } = require('node:url')
const options = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const assert = require('node:assert/strict')
os.homedir = () => options.home
const originalExecFile = childProcess.execFile
let macRegistration = 0, windows = 0, sandboxed = true
childProcess.execFile = (file, args, ...rest) => {
  if (file !== '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister') return originalExecFile(file, args, ...rest)
  assert.deepEqual(args, ['-f', options.application]); macRegistration++
  rest.at(-1)(null, '', '')
}
syncBuiltinESMExports()
Object.defineProperty(process, 'resourcesPath', { value: options.resources })
process.argv.push('--install-root=' + options.root)
const observations = [], native = require(path.join(path.dirname(options.entry), 'bootstrap/scripts/lib/process-identity.cjs'))
const observe = native.inspectProgramReferences
native.inspectProgramReferences = async options => {
  const result = await observe(options)
  observations.push({ complete: result.complete, incomplete: result.incomplete, references: result.processes.length, unknown_stages: result.unknown_stages,
        unknown: await Promise.all(result.unknown_details.filter(item => item.os_error !== 1).slice(0, 8).map(async item => {
          let current
          try { const value = native.inspectProcess(item.pid); if (value) current = { pid: value.pid, parent: value.parent, started: value.started, executable: value.executable } } catch {}
          return { ...item, current, ...(process.platform === 'linux' ? {
            comm: (await fs.promises.readFile('/proc/' + item.pid + '/comm', 'utf8').catch(() => 'unavailable')).trim().slice(0, 64) } : {}) }
        })) })
  return result
}
const dialogs = []
dialog.showMessageBox = async value => {
  dialogs.push({ title: value.title, message: value.message })
  if (value.title === '安装位置') return { response: 0 }
  assert.ok(['继续恢复服务', '安装尚未完成'].includes(value.title), 'Unexpected ordinary installer dialog')
  return { response: 1 } // Finish this finite actor without starting the product GUI.
}
app.on('browser-window-created', (_event, window) => {
  windows++
  const preferences = window.webContents.getLastWebPreferences()
  sandboxed &&= preferences.sandbox === true && preferences.contextIsolation === true && preferences.nodeIntegration === false
})
const originalExit = app.exit.bind(app)
const timer = setTimeout(() => app.exit(2), 110000)
app.exit = code => {
  clearTimeout(timer)
  fs.writeFileSync(options.report, JSON.stringify({ dialogs, windows, sandboxed, macRegistration, observations, profile: app.getPath('userData'),
    actual_installer_main: true, actual_product_gui: false, business_mm_started: false }) + '\n', { flag: 'wx', mode: 0o600 })
  originalExit(code)
}
void import(pathToFileURL(options.entry).href).catch(error => { console.error(error.stack); app.exit(1) })
