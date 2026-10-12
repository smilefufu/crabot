const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const pin = require('../computer-use/runtime.json')

function loadRuntime(root, { full = false } = {}) {
  const platform = `${process.platform}-${process.arch}`
  const asset = pin.assets[platform]
  if (!asset) throw new Error(`COMPUTER_USE_PLATFORM_UNSUPPORTED: ${platform}`)
  const directory = path.join(root, '.computer-use-runtime', `${pin.version}-${platform}`)
  const ready = JSON.parse(fs.readFileSync(path.join(directory, 'ready.json'), 'utf8'))
  if (ready.sha256 !== asset.sha256 || ready.version !== pin.version) throw new Error('COMPUTER_USE_RUNTIME_MISMATCH')
  const command = path.join(directory, process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver')
  const required = [path.basename(command)]
  if (process.platform === 'darwin') required.push('CuaDriver.app/Contents/MacOS/cua-driver', 'CuaDriver.app/Contents/Info.plist', 'CuaDriver.app/Contents/_CodeSignature/CodeResources')
  if (process.platform === 'win32') required.push('cua-driver-uia.exe')
  if (!ready.files || required.some(file => !ready.files[file])) throw new Error('COMPUTER_USE_RUNTIME_INCOMPLETE')
  for (const [relative, digest] of Object.entries(ready.files)) {
    const file = path.resolve(directory, relative)
    if (!file.startsWith(directory + path.sep)) throw new Error('COMPUTER_USE_RUNTIME_INVALID_PATH')
    if ((full || file === command || relative === 'CuaDriver.app/Contents/MacOS/cua-driver')
      && crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== digest) throw new Error(`COMPUTER_USE_RUNTIME_DAMAGED: ${relative}`)
  }
  return { directory, command, app: process.platform === 'darwin' ? path.join(directory, 'CuaDriver.app') : undefined, version: pin.version }
}
module.exports = { pin, loadRuntime }
