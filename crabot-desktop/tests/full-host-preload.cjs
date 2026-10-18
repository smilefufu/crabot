// Development Electron only, supplied with NODE_OPTIONS by the isolated CI test.
// No product auth handler is replaced. Final packaged fuses disable this route.
if (!process.versions.electron || !process.env.CRABOT_FULL_HOST_FIXTURE) throw new Error('Full host fixture requires an explicitly isolated Electron process')
delete process.env.NODE_OPTIONS
const controlReader = require('./full-host-transport.cjs')
const { createConnection } = require('node:net')
const port = Number(process.env.CRABOT_FULL_HOST_CONTROL_PORT), token = process.env.CRABOT_FULL_HOST_CONTROL_TOKEN
delete process.env.CRABOT_FULL_HOST_CONTROL_PORT
delete process.env.CRABOT_FULL_HOST_CONTROL_TOKEN
let window, quitResponse = 0
const emit = (tag, fields = {}) => process.stdout.write('CRABOT_FULL_HOST ' + JSON.stringify({ tag, ...fields }) + '\n')
const state = () => window.webContents.executeJavaScript('window.crabotDesktop.getState()')
// NODE_OPTIONS is evaluated before Electron exposes its main-process APIs.
const deadline = Date.now() + 5000
function install() {
  const { app, dialog, BrowserWindow } = require('electron')
  if (!app) {
    if (Date.now() < deadline) setImmediate(install)
    else emit('fixture_error', { message: 'Electron main API did not initialize' })
    return
  }
  dialog.showMessageBox = async (...args) => {
    const options = args.at(-1)
    if (options.title === '退出 Crabot') return { response: quitResponse, checkboxChecked: false }
    emit('unexpected_dialog', { message: options.message }); return { response: 0, checkboxChecked: false }
  }
  function capture(created) {
    if (window) return
    window = created
    const ready = async () => {
      try {
        const deadline = Date.now() + 90_000
        while (Date.now() < deadline) {
          const current = await state()
          if (current.phase === 'ready') {
            const renderer = await window.webContents.executeJavaScript('({node:typeof require,token:localStorage.getItem("crabot_admin_token")})')
            emit('ready', { generation: current.generation, renderer }); return
          }
          if (['error', 'migration_required'].includes(current.phase)) throw new Error('Host state: ' + current.phase + '/' + current.code)
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        throw new Error('Host did not reach ready')
      } catch (error) { emit('fixture_error', { message: String(error) }) }
    }
    if (window.webContents.getURL().startsWith('app://crabot/') && !window.webContents.isLoadingMainFrame()) void ready()
    else window.webContents.once('did-finish-load', ready)
  }
  app.on('browser-window-created', (_event, created) => capture(created))
  const existing = BrowserWindow.getAllWindows().sort((a, b) => a.id - b.id)[0]
  if (existing) capture(existing)
  let commands = Promise.resolve()
  // Electron 44.9.0 common/init.ts deliberately replaces Windows stdin with EOF.
  const control = createConnection({ host: '127.0.0.1', port })
  control.once('connect', () => control.write(token + '\n'))
  control.once('error', error => emit('fixture_error', { message: 'Control connection: ' + error.code }))
  app.once('will-quit', () => control.destroy())
  controlReader(control).on('line', command => {
    commands = commands.then(async () => {
      if (command === 'capture_welcome' || command === 'capture_chat') {
        if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Captures require synthetic isolated CI data')
        const selector = command === 'capture_welcome' ? '.desktop-welcome' : '[data-msg-role="assistant"]'
        const deadline = Date.now() + 30_000
        let rendered = false
        while (Date.now() < deadline) {
          rendered = await window.webContents.executeJavaScript('!!document.querySelector(' + JSON.stringify(selector) + ')')
          if (rendered) break
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        if (!rendered) throw new Error('Expected synthetic UI was not rendered')
        const fs = require('node:fs'), path = require('node:path'), directory = path.resolve(__dirname, '../../.desktop-build')
        fs.mkdirSync(directory, { recursive: true })
        fs.writeFileSync(path.join(directory, command + '-' + process.platform + '.png'), (await window.webContents.capturePage()).toPNG())
        emit(command, { captured: true }); return
      }
      if (command.startsWith('first_model:')) {
        const result = await require('./fixtures/first-model-renderer.cjs')(window, command.slice('first_model:'.length))
        emit('first_model', result); return
      }
      if (command === 'close') window.close()
      else if (command === 'show') app.emit('activate')
      else if (command === 'quit_cancel' || command === 'quit_confirm') {
        quitResponse = command === 'quit_confirm' ? 1 : 0
        const result = await window.webContents.executeJavaScript('window.crabotDesktop.quit()')
        emit(command, { result }); return
      } else if (command !== 'state') throw new Error('Unknown fixture command')
      const current = await state()
      emit(command, { phase: current.phase, generation: current.phase === 'ready' ? current.generation : undefined, visible: window.isVisible() })
    }).catch(async error => {
      if (command.startsWith('first_model:') && process.env.GITHUB_ACTIONS === 'true') {
        try {
          const fs = require('node:fs'), path = require('node:path')
          fs.writeFileSync(path.resolve(__dirname, '../../.desktop-build/capture_first_model_failure-' + process.platform + '.png'), (await window.webContents.capturePage()).toPNG())
        } catch {}
      }
      emit('fixture_error', { message: String(error) })
    })
  })
}
setImmediate(install)
