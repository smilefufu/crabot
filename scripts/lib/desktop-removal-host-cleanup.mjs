// A live source may retire only its own captured, exited private child copy.
// Nothing here discovers or executes an old temporary path from disk.
import path from 'node:path'
import physical from './physical-fs.cjs'
import identity from './process-identity.cjs'
import management from './desktop-management.cjs'
import { probeKnownProcessExit } from './known-process-exit.cjs'
import { verifyDesktopGui } from './desktop-payload.mjs'
import { captureMacRemovalSystemProcesses } from './desktop-removal-system-processes.mjs'
const generation = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].join(':')
const fail = () => { throw Object.assign(new Error('临时维护程序尚未确认退出或发生变化，已保留诊断材料。'), { code: 'CRABOT_DESKTOP_REMOVAL' }) }
export function captureRemovalGuiCleanup(prepared, child) {
  if (!['darwin', 'win32'].includes(process.platform)) fail()
  const directory = management.requirePrivateDataRoot(prepared.directory), original = generation(physical.lstatSync(directory, { bigint: true }))
  const expectedGui = path.join(directory, 'gui'), expectedExecutable = path.join(expectedGui, process.platform === 'darwin' ? 'Crabot.app/Contents/MacOS/Crabot' : 'Crabot.exe')
  if (prepared.guiRoot !== expectedGui || prepared.executable !== expectedExecutable) fail()
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
    await verifyDesktopGui(prepared.guiRoot, prepared.proof.payload)
    if (physical.readdirSync(directory).some(name => !['gui', 'profile'].includes(name))) fail()
    current()
    const classify = process.platform === 'darwin' ? captureMacRemovalSystemProcesses(directory) : () => false
    const observation = await identity.inspectProgramReferences({ roots: [directory], files: [] })
    if (!(observation.complete === true && observation.incomplete === false && Array.isArray(observation.processes) && !observation.processes.length
      && Array.isArray(observation.unknown_pids) && !observation.unknown_pids.length) && !classify(observation)) fail()
    current()
    await physical.promises.rm(directory, { recursive: true, maxRetries: 10, retryDelay: 100 })
  }
}
