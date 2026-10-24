// Read-only parent-side authorization of the fixed child IPC exit intent.
// A true result permits only normal source-GUI exit, never program deletion.
import path from 'node:path'
import { createHash } from 'node:crypto'
import physical from './physical-fs.cjs'
import identity from './process-identity.cjs'
import entry from './desktop-entry.cjs'
import installation from './desktop-installation.cjs'
import management from './desktop-management.cjs'
import { processBirthAtLeast } from './owned-process-tree.cjs'
import { readDesktopRemoval } from './desktop-removal-record.cjs'
import { readDesktopRemovalProof } from './desktop-removal-proof.mjs'
import { verifyDesktopGui } from './desktop-payload.mjs'
import { inspectInstance } from './instance-runtime.mjs'
import { workspaceMaintenancePending } from './workspace-maintenance.cjs'
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const inside = (parent, child) => { const relative = path.relative(parent, child); return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
const generation = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].join(':')
export function createDesktopRemovalSourceExitVerifier({ installRoot, prepared, child }) {
  const own = installation.readDesktopInstallation(installRoot), source = identity.inspectProcess(process.pid)
  const proofText = JSON.stringify(prepared.proof) + '\n', proof = JSON.parse(proofText)
  const digest = createHash('sha256').update(proofText).digest('hex')
  const directory = prepared.directory, guiRoot = prepared.guiRoot, executable = prepared.executable
  const expectedExecutable = path.join(guiRoot, process.platform === 'darwin' ? 'Crabot.app/Contents/MacOS/Crabot' : 'Crabot.exe')
  const originalData = generation(physical.lstatSync(own.dataDir, { bigint: true }))
  const originalDirectory = generation(physical.lstatSync(directory, { bigint: true }))
  const sourceExecutable = path.join(own.root, 'app/releases', proof.source_selection.gui_id,
    process.platform === 'darwin' ? 'Crabot.app/Contents/MacOS/Crabot' : 'Crabot.exe')
  let host
  const current = () => {
    const actual = identity.inspectProcess(child.pid), self = identity.inspectProcess(process.pid)
    const record = readDesktopRemoval(own.root)
    if (!host || !source || !child.connected || child.exitCode !== null || child.signalCode !== null
      || !identity.sameProcess(source, self) || !identity.sameProcess(host, actual)
      || actual.parent !== source.pid || actual.owner !== own.record.owner || !processBirthAtLeast(actual.started, source.started)
      || !entry.verifyDesktopEntry(self, { executable: sourceExecutable, development: false })
      || executable !== expectedExecutable || physical.realpathSync(actual.executable) !== physical.realpathSync(expectedExecutable)
      || inside(own.root, directory) || inside(directory, own.root)
      || path.dirname(guiRoot) !== directory || path.basename(guiRoot) !== 'gui'
      || !/^crabot-removal-host-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(path.basename(directory))
      || management.requirePrivateDataRoot(directory) !== directory || physical.realpathSync(guiRoot) !== guiRoot
      || generation(physical.lstatSync(directory, { bigint: true })) !== originalDirectory
      || generation(physical.lstatSync(own.dataDir, { bigint: true })) !== originalData
      || !same(installation.readDesktopInstallation(own.root).record, own.record)
      || !same(installation.readDesktopPairReference(own.root).selection, proof.source_selection)
      || !record || record.phase !== 'stopping' || record.installation_id !== proof.installation_id
      || record.operation_id !== proof.operation_id || record.proof_sha256 !== digest || !same(record.source_selection, proof.source_selection)
      || inspectInstance(own.dataDir).state !== 'stopped' || workspaceMaintenancePending(own.dataDir)) return false
    for (const file of [path.join(own.root, '.desktop-installing.json'), path.join(own.dataDir, 'desktop-maintenance.json')]) {
      try { physical.lstatSync(file); return false } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    try { if (physical.readdirSync(path.join(own.dataDir, 'module-runtime-registry/records')).some(name => name.endsWith('.json'))) return false }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    return true
  }
  return async message => {
    try {
      if (!['darwin', 'win32'].includes(process.platform) || !message || typeof message !== 'object' || Array.isArray(message)
        || Object.keys(message).length !== 4 || !['kind', 'installation_id', 'operation_id', 'source_selection'].every(key => Object.hasOwn(message, key))
        || message.kind !== 'desktop_removal_source_exit' || message.installation_id !== proof.installation_id
        || message.operation_id !== proof.operation_id || !same(message.source_selection, proof.source_selection)
        || !child.connected || child.exitCode !== null || child.signalCode !== null) return false
      // The private ChildProcess channel is bound by the source caller. Capture
      // its actual image after startup, then require the same birth thereafter.
      host ??= identity.inspectProcess(child.pid)
      if (!current()) return false
      await verifyDesktopGui(guiRoot, proof.payload)
      const actual = await readDesktopRemovalProof(own.root)
      return actual.record.proof_sha256 === digest && same(actual.proof, proof) && current()
    } catch { return false }
  }
}
