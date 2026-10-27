// A live source may retire only its own captured, exited private child copy.
// Nothing here discovers or executes an old temporary path from disk.
import path from 'node:path'
import physical from './physical-fs.cjs'
import identity from './process-identity.cjs'
import management from './desktop-management.cjs'
import { probeKnownProcessExit } from './known-process-exit.cjs'
import { verifyDesktopGui } from './desktop-payload.mjs'
import { verifyUbuntuRemovalNodeCopy } from './desktop-removal-host.mjs'
import { desktopMaintenanceNodeFiles } from './desktop-maintenance-bootstrap.mjs'
import { captureMacRemovalSystemProcesses, captureLinuxRemovalSystemProcesses } from './desktop-removal-system-processes.mjs'
const generation = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].join(':')
const fail = () => { throw Object.assign(new Error('临时维护程序尚未确认退出或发生变化，已保留诊断材料。'), { code: 'CRABOT_DESKTOP_REMOVAL' }) }
// Shared only: captured child exit, directory identity and resource observation.
// Each fixed role supplies its own complete copy/closed-content verification.
function capturePrivateCleanup(prepared, child, verifyCopy) {
  const directory = management.requirePrivateDataRoot(prepared.directory), original = generation(physical.lstatSync(directory, { bigint: true }))
  const parent = identity.inspectProcess(process.pid), peer = identity.inspectProcess(child.pid)
  if (!parent || !peer || peer.parent !== parent.pid || peer.owner !== parent.owner
    || physical.realpathSync(peer.executable) !== physical.realpathSync(prepared.executable)
    || !/^crabot-removal-host-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(path.basename(directory))) fail()
  const current = () => {
    if (management.requirePrivateDataRoot(directory) !== directory || generation(physical.lstatSync(directory, { bigint: true })) !== original
      || !identity.sameProcess(parent, identity.inspectProcess(process.pid))) fail()
  }
  return async () => {
    current()
    if (child.exitCode === null && child.signalCode === null || probeKnownProcessExit([peer]).state !== 'stopped') fail()
    await verifyCopy(); current()
    const classify = process.platform === 'darwin' ? captureMacRemovalSystemProcesses(directory)
      : process.platform === 'linux' ? captureLinuxRemovalSystemProcesses(directory) : () => false
    const observation = await identity.inspectProgramReferences({ roots: [directory], files: [] })
    if (!(observation.complete === true && observation.incomplete === false && Array.isArray(observation.processes) && !observation.processes.length
      && Array.isArray(observation.unknown_pids) && !observation.unknown_pids.length) && !classify(observation)) fail()
    current()
    await physical.promises.rm(directory, { recursive: true, maxRetries: 10, retryDelay: 100 })
  }
}
export function captureRemovalGuiCleanup(prepared, child) {
  if (!['darwin', 'win32'].includes(process.platform)) fail()
  const directory = prepared.directory, gui = path.join(directory, 'gui')
  if (prepared.guiRoot !== gui || prepared.executable !== path.join(gui, process.platform === 'darwin' ? 'Crabot.app/Contents/MacOS/Crabot' : 'Crabot.exe')) fail()
  return capturePrivateCleanup(prepared, child, async () => {
    await verifyDesktopGui(gui, prepared.hostPayload ?? prepared.proof.payload)
    if (physical.readdirSync(directory).some(name => !['gui', 'profile'].includes(name))) fail()
  })
}
export function captureRemovalNodeCleanup(prepared, child) {
  if (process.platform !== 'linux' || prepared.executable !== path.join(prepared.directory, 'node')
    || prepared.frontend !== path.join(prepared.directory, 'crabot-maintenance') || prepared.self_verified !== true) fail()
  const allowed = new Map(['node', 'crabot-maintenance', 'crabot-sandbox-helper', 'cleanup', ...desktopMaintenanceNodeFiles.map(name => 'backend/' + name)].map(name => [name, 'file']))
  for (const name of [...allowed.keys()]) for (let parent = path.posix.dirname(name); parent !== '.'; parent = path.posix.dirname(parent)) allowed.set(parent, 'directory')
  const closedContents = directory => {
    for (const entry of physical.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name), name = path.relative(prepared.directory, file).split(path.sep).join('/')
      if (allowed.get(name) === 'directory' && entry.isDirectory() && !entry.isSymbolicLink()) closedContents(file)
      else if (allowed.get(name) !== 'file' || !entry.isFile() || entry.isSymbolicLink()) fail()
    }
  }
  return capturePrivateCleanup(prepared, child, async () => {
    await verifyUbuntuRemovalNodeCopy(prepared.directory, prepared.proof)
    closedContents(prepared.directory)
  })
}
