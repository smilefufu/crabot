// Finalize only the fresh private copy after its original source has exited.
// The small native child waits for this actual host's kernel exit. No locator
// is persisted and no installation/data/renderer path is passed to that child.
import path from 'node:path'
import { spawn } from 'node:child_process'
import physical from './physical-fs.cjs'
import identity from './process-identity.cjs'
import management from './desktop-management.cjs'
import { probeKnownProcessExit } from './known-process-exit.cjs'
import { verifyDesktopGui } from './desktop-payload.mjs'
import { desktopMaintenanceNodeFiles } from './desktop-maintenance-bootstrap.mjs'
import { matchesDesktopRemovalProgram } from './desktop-removal-programs.mjs'
const { promises: fs, constants } = physical
const fail = () => { throw Object.assign(new Error('私有维护副本收尾尚未核实，诊断材料已保留。'), { code: 'CRABOT_DESKTOP_REMOVAL' }) }
export async function scheduleRemovalCopyCleanup({ directory, source, payload, node }) {
  const state = probeKnownProcessExit([source]).state
  if (state === 'running') return false // The original source still reaps its child normally.
  if (state !== 'stopped' || management.requirePrivateDataRoot(directory) !== directory) fail()
  const suffix = process.platform === 'win32' ? '.exe' : '', executable = path.join(directory, 'cleanup' + suffix)
  const resource = (process.platform === 'darwin' ? 'Crabot.app/Contents/Resources/' : 'resources/') + 'crabot-copy-cleanup' + suffix
  const expected = payload.gui[resource]
  if (expected?.type !== 'file') fail()
  if (process.platform === 'linux') {
    const files = new Map([
      ['node', node], ['cleanup', expected],
      ...['crabot-maintenance', 'crabot-sandbox-helper'].map(name => [name, payload.gui['resources/' + name]]),
      ...desktopMaintenanceNodeFiles.map(name => ['backend/' + name, payload.gui['resources/crabot-maintenance-backend/' + name]]),
    ])
    const directories = new Set()
    for (const name of files.keys()) for (let parent = path.posix.dirname(name); parent !== '.'; parent = path.posix.dirname(parent)) directories.add(parent)
    const verify = async current => {
      for (const item of await fs.readdir(current, { withFileTypes: true })) {
        const file = path.join(current, item.name), name = path.relative(directory, file).split(path.sep).join('/')
        if (item.isDirectory() && directories.has(name)) await verify(file)
        else if (!item.isFile() || !files.has(name)) fail()
      }
    }
    await verify(directory)
    for (const [name, entry] of files) {
      if (entry?.type !== 'file') fail()
      const file = path.join(directory, name), stat = await fs.lstat(file, { bigint: true })
      if (!await matchesDesktopRemovalProgram(file, entry, stat, { owned: (_file, value) => value.uid === BigInt(process.getuid()) })) fail()
    }
  } else {
    await verifyDesktopGui(path.join(directory, 'gui'), payload)
    const original = path.join(directory, 'gui', resource), stat = await fs.lstat(original)
    if (!stat.isFile() || stat.isSymbolicLink()) fail()
    await fs.copyFile(original, executable, constants.COPYFILE_EXCL)
    if (process.platform !== 'win32') await fs.chmod(executable, expected.mode)
  }
  const stat = await fs.lstat(executable, { bigint: true })
  if (!await matchesDesktopRemovalProgram(executable, expected, stat, { owned: (file, value) => process.platform === 'win32'
    ? identity.isOwnedFile(file) : value.uid === BigInt(process.getuid()) })) fail()
  const child = spawn(executable, [], { cwd: path.dirname(directory), detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  await new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(failError()) }, 5000)
    const finish = error => { clearTimeout(timer); child.stdout.destroy(); error ? reject(error) : resolve() }
    const failError = () => Object.assign(new Error('Private copy cleanup not ready'), { code: 'CRABOT_DESKTOP_REMOVAL' })
    child.once('error', () => finish(failError()))
    child.once('exit', () => finish(failError()))
    child.stdout.on('data', bytes => {
      output += bytes.toString()
      if (output === 'READY\n') { child.unref(); finish() }
      else if (output.length > 64) { child.kill('SIGKILL'); finish(failError()) }
    })
  })
  return true
}
