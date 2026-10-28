// Finite actual Electron/controller actor. No OS setting or business service changes.
const { app, dialog } = require('electron')
const fs = require('node:fs'), path = require('node:path'), { pathToFileURL } = require('node:url')
app.setName('Crabot isolated login warning probe')
app.setPath('userData', process.argv[2]); app.setPath('sessionData', process.argv[2])
app.whenReady().then(async () => {
  const { DesktopController } = await import(pathToFileURL(path.resolve(__dirname, '../dist/controller.js')).href)
  const controller = new DesktopController({ coreRoot: '/target', dataRoot: '/data', appVersion: '1.2.4', platform: process.platform,
    loginStartup: { captureForUpdate: async () => 'off', restoreForUpdate: async () => { throw new Error('No OS mutation in finite probe') } },
    loginStartupRecovered: () => {
      fs.writeSync(1, 'BEFORE_WARNING\n')
      void dialog.showMessageBox({ type: 'warning', message: 'Crabot isolated startup probe', detail: 'Finite local test; closes automatically.', buttons: ['OK'] })
      fs.writeSync(1, 'AFTER_WARNING_CALL\n')
    } })
  controller.load = async file => {
    if (file.endsWith('version-maintenance.mjs')) return { readVersionMaintenance: () => ({ schema_version: 3, phase: 'verifying', install_root: '/source', target_core: { root: '/target' } }),
      recoverVersionMaintenance: async options => { await options.verifyCompatible(); if (!await options.run()) throw new Error('No health'); await options.verifyCompatible(); fs.writeSync(1, 'RECOVERY_FINALIZED\n') } }
    if (file.endsWith('core-preparation.mjs')) return { verifyDataCompatibility: () => [] }
    if (file.endsWith('maintenance-backup.mjs')) return { assertLocalMigrationData: async () => {} }
    throw new Error('Login proof unavailable in finite probe')
  }
  controller.startCore = async () => {
    controller.host.publish({ phase: 'ready', app_version: '1.2.4', platform: process.platform, instance_id: '1'.repeat(64), generation: '11111111-1111-4111-8111-111111111111', admin_url: 'http://127.0.0.1:3000' })
    fs.writeSync(1, 'RECOVERY_CAN_CONTINUE\n')
  }
  await controller.recoverVersion(); controller.close(); setTimeout(() => app.exit(0), 200)
})
