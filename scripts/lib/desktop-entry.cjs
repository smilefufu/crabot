const { existsSync, readFileSync, realpathSync } = require('node:fs')
const { join, dirname, resolve } = require('node:path')
const identity = require('./process-identity.cjs')

function sameFile(a, b) {
  try { return realpathSync(a) === realpathSync(b) } catch { return false }
}

function loadDesktopEntry(root) {
  const desktop = require('./desktop-installation.cjs').locateDesktopCore(root)
  if (desktop) return { executable: desktop.executable, development: false }
  const marker = join(root, 'desktop-host.json')
  if (existsSync(marker)) {
    const description = JSON.parse(readFileSync(marker, 'utf8'))
    if (description.schema_version !== 1 || description.platform !== process.platform || description.arch !== process.arch
      || Object.keys(description).some(key => !['schema_version', 'platform', 'arch'].includes(key))) throw new Error('Desktop installation metadata is invalid')
    const executable = process.platform === 'darwin' ? resolve(root, '../../MacOS/Crabot')
      : resolve(root, '../..', process.platform === 'win32' ? 'Crabot.exe' : 'crabot-desktop')
    return { executable: realpathSync(executable), development: false }
  }
  // This source-only file is excluded from sealed core packages. No environment override.
  const directory = join(root, 'crabot-desktop'), packageFile = join(directory, 'package.json')
  if (!existsSync(packageFile) || JSON.parse(readFileSync(packageFile, 'utf8')).crabotDesktopDevelopment !== true) return null
  const electron = dirname(require.resolve('electron/package.json', { paths: [directory] }))
  const executable = realpathSync(join(electron, 'dist', readFileSync(join(electron, 'path.txt'), 'utf8').trim()))
  return { executable, development: true, entry: realpathSync(directory) }
}

function verifyDesktopEntry(peer, policy) {
  if (!policy || !peer || peer.owner !== identity.inspectProcess(process.pid).owner
    || !sameFile(peer.executable, policy.executable)) return false
  const args = identity.inspectProcessArguments(peer.pid)
  let tail = args.slice(1)
  if (policy.development) {
    if (!tail.length || !sameFile(tail[0], policy.entry)) return false
    tail = tail.slice(1)
  }
  if (tail.some(value => !['--background', '--check-updates'].includes(value) && !(process.platform === 'darwin' && /^-psn_[0-9_]+$/.test(value)))) return false
  return identity.sameProcess(peer, identity.inspectProcess(peer.pid))
}

// Installed Apps launches the original GUI with this single fixed intent. It
// may hand off maintenance, but cannot authenticate as an ordinary business GUI.
function verifyDesktopRemovalSourceEntry(peer, policy) {
  if (verifyDesktopEntry(peer, policy)) return true
  if (process.platform !== 'win32' || !policy || policy.development || !peer
    || peer.owner !== identity.inspectProcess(process.pid).owner || !sameFile(peer.executable, policy.executable)) return false
  const args = identity.inspectProcessArguments(peer.pid)
  return args.length === 2 && args[1] === '--uninstall' && identity.sameProcess(peer, identity.inspectProcess(peer.pid))
}

module.exports = { loadDesktopEntry, verifyDesktopEntry, verifyDesktopRemovalSourceEntry }
