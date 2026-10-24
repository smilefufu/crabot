// Force the profile stat to finish after ready, using the real Electron lifecycle.
const { app } = require('electron')
const fs = require('node:fs/promises')
const { syncBuiltinESMExports } = require('node:module')
const original = fs.lstat
fs.lstat = async (file, ...args) => {
  if (String(file) === process.env.CRABOT_TEST_INSTALLATION_PROFILE) {
    await app.whenReady()
    process.stderr.write('CRABOT_INSTALL_PROBE_PROFILE_AFTER_READY\n')
  }
  return original(file, ...args)
}
syncBuiltinESMExports()
