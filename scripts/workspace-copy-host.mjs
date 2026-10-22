// Internal physical copier only. Directories are inherited kernel handles, never paths to re-resolve after launch.
import fs from 'node:fs'
import native from './lib/process-identity.cjs'
import { copyWorkspaceTreeFd } from './lib/workspace-posix-copy.mjs'

if (process.platform !== 'darwin' && process.platform !== 'linux'
  || process.argv.length !== 6 || !process.argv.slice(2).every(value => /^(?:0|[1-9][0-9]*)$/.test(value))) {
  throw new Error('Invalid internal copy-host invocation')
}
const [sourceDevice, sourceInode, targetDevice, targetInode] = process.argv.slice(2)
native.enterDirectoryFd(3, sourceDevice, sourceInode)
native.enterDirectoryFd(4, targetDevice, targetInode)
fs.mkdirSync('tree', { mode: 0o700 })
const treeFd = fs.openSync('tree', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
try { await copyWorkspaceTreeFd(3, treeFd, 4) }
catch (error) {
  process.exitCode = 1
  const stages = ['bind-directories', 'pack-start', 'unpack-start', 'actors-register', 'actors-permit', 'actors-finish', 'actors-complete', 'directory-times', 'directory-sync', 'container-sync']
  const exits = value => Number.isInteger(value) && value >= 0 && value <= 2147483647 ? value : null
  console.error('Workspace copy host failed: ' + (error.code ?? 'unverified') + ' ' + JSON.stringify({
    stage: stages.includes(error.copy_stage) ? error.copy_stage : null,
    pack_exit: exits(error.pack_exit), unpack_exit: exits(error.unpack_exit),
    transport_code: ['EPIPE', 'ERR_STREAM_PREMATURE_CLOSE', 'ABORT_ERR', 'unverified'].includes(error.transport_code) ? error.transport_code : null,
  }))
}
finally { fs.closeSync(treeFd) }
