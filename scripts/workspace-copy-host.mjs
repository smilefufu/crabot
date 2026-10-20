// Internal physical copier only. Directories are inherited kernel handles, never paths to re-resolve after launch.
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { finished } from 'node:stream/promises'
import native from './lib/process-identity.cjs'

if (process.platform !== 'darwin' && process.platform !== 'linux'
  || process.argv.length !== 6 || !process.argv.slice(2).every(value => /^(?:0|[1-9][0-9]*)$/.test(value))) {
  throw new Error('Invalid internal copy-host invocation')
}
const [sourceDevice, sourceInode, targetDevice, targetInode] = process.argv.slice(2)
native.enterDirectoryFd(4, targetDevice, targetInode)
fs.mkdirSync('tree', { mode: 0o700 })
const treeFd = fs.openSync('tree', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
const tree = fs.fstatSync(treeFd, { bigint: true })
const actors = [], completions = []; let failed = false, force
function stop() {
  failed = true
  for (const child of actors) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  force ??= setTimeout(() => {
    for (const child of actors) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, 2000)
}
function actor(args) {
  const child = spawn('/usr/bin/tar', args, { stdio: ['pipe', 'pipe', 'inherit'] })
  actors.push(child)
  const closed = new Promise(resolve => {
    child.once('error', () => { stop(); resolve(false) })
    child.once('close', code => { if (code !== 0) stop(); resolve(code === 0) })
  })
  completions.push(closed)
  return { child, closed }
}
try {
  const metadata = process.platform === 'darwin'
    ? ['--acls', '--xattrs', '--fflags', '--mac-metadata'] : ['--acls', '--xattrs', '--xattrs-include=*']
  native.enterDirectoryFd(3, sourceDevice, sourceInode)
  const pack = actor(['-c', '--format=pax', ...metadata, '-f', '-', '.'])
  pack.child.stdin.end()
  native.enterDirectoryFd(treeFd, tree.dev.toString(), tree.ino.toString())
  const unpack = actor(['-x', ...metadata, '--same-owner', '--same-permissions', '-f', '-'])
  // No -v or -O: archive bytes only flow between these two owned processes, never into logs.
  unpack.child.stdout.resume()
  pack.child.stdout.on('error', stop)
  pack.child.stdout.pipe(unpack.child.stdin)
  const transport = finished(unpack.child.stdin).catch(() => { stop() })
  const results = await Promise.all([pack.closed, unpack.closed, transport])
  if (failed || results[0] !== true || results[1] !== true) process.exitCode = 1
  else native.copyDirectoryTimesFd(3, treeFd)
} catch (error) {
  stop(); process.exitCode = 1; console.error('Workspace copy host failed: ' + (error.code ?? 'unverified'))
  await Promise.all(completions)
} finally {
  clearTimeout(force); fs.closeSync(treeFd)
}
