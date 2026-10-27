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
import { verifyUbuntuRemovalNodeCopy } from './desktop-removal-host.mjs'
import { verifyDesktopGui } from './desktop-payload.mjs'
import { inspectInstance } from './instance-runtime.mjs'
import { workspaceMaintenancePending } from './workspace-maintenance.cjs'
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const inside = (parent, child) => { const relative = path.relative(parent, child); return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
const generation = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].join(':')
function createSourceExitVerifier({ installRoot, prepared, child }, existing, role = 'gui') {
  const node = role === 'node'
  const own = installation.readDesktopInstallation(installRoot), source = identity.inspectProcess(process.pid)
  const proofText = JSON.stringify(prepared.proof) + '\n', proof = JSON.parse(proofText)
  const digest = createHash('sha256').update(proofText).digest('hex')
  const phases = { preparing: 'stopping', stopping: 'stopping', removing: 'removing', completed: 'completed' }
  const expectedPhase = existing ? phases[prepared.record?.phase] : 'stopping'
  const expectedRecord = existing && prepared.record ? { ...structuredClone(prepared.record), phase: expectedPhase } : null
  const directory = prepared.directory, guiRoot = prepared.guiRoot, executable = prepared.executable
  const expectedExecutable = node ? path.join(directory, 'node') : path.join(guiRoot, process.platform === 'darwin' ? 'Crabot.app/Contents/MacOS/Crabot' : 'Crabot.exe')
  const hostLocationMatches = () => node
    ? prepared.self_verified === true && path.dirname(executable) === directory && path.basename(executable) === 'node'
    : path.dirname(guiRoot) === directory && path.basename(guiRoot) === 'gui' && physical.realpathSync(guiRoot) === guiRoot
  const originalData = generation(physical.lstatSync(own.dataDir, { bigint: true }))
  const originalDirectory = generation(physical.lstatSync(directory, { bigint: true }))
  const sourceExecutable = path.join(own.root, 'app/releases', proof.source_selection.gui_id,
    process.platform === 'darwin' ? 'Crabot.app/Contents/MacOS/Crabot' : process.platform === 'linux' ? 'crabot-desktop' : 'Crabot.exe')
  let host, stage
  const current = () => {
    stage = 'process-identity'
    const actual = identity.inspectProcess(child.pid), self = identity.inspectProcess(process.pid)
    const record = readDesktopRemoval(own.root)
    if (!expectedPhase || (existing ? !expectedRecord || !same(record, expectedRecord) : Object.hasOwn(prepared, 'record'))) return false
    if (!host || !source || !child.connected || child.exitCode !== null || child.signalCode !== null
      || !identity.sameProcess(source, self) || !identity.sameProcess(host, actual)
      || actual.parent !== source.pid || actual.owner !== own.record.owner || !processBirthAtLeast(actual.started, source.started)
      || !entry.verifyDesktopRemovalSourceEntry(self, { executable: sourceExecutable, development: false }) ) return false
    stage = 'host-location'
    if (executable !== expectedExecutable || physical.realpathSync(actual.executable) !== physical.realpathSync(expectedExecutable)
      || inside(own.root, directory) || inside(directory, own.root)
      || !hostLocationMatches()
      || !/^crabot-removal-host-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(path.basename(directory))
      || management.requirePrivateDataRoot(directory) !== directory
      || generation(physical.lstatSync(directory, { bigint: true })) !== originalDirectory ) return false
    stage = 'installation-and-job'
    if (generation(physical.lstatSync(own.dataDir, { bigint: true })) !== originalData
      || !same(installation.readDesktopInstallation(own.root).record, own.record)
      || !same(installation.readDesktopPairReference(own.root).selection, proof.source_selection)
      || !record || record.phase !== expectedPhase || record.installation_id !== proof.installation_id
      || record.operation_id !== proof.operation_id || record.proof_sha256 !== digest || !same(record.source_selection, proof.source_selection) ) return false
    stage = 'stopped-service'
    if (inspectInstance(own.dataDir).state !== 'stopped' || workspaceMaintenancePending(own.dataDir)) return false
    for (const file of [path.join(own.root, '.desktop-installing.json'), path.join(own.dataDir, 'desktop-maintenance.json')]) {
      try { physical.lstatSync(file); return false } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    try { if (physical.readdirSync(path.join(own.dataDir, 'module-runtime-registry/records')).some(name => name.endsWith('.json'))) return false }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    return true
  }
  return async message => {
    let accepted = false
    const started = performance.now()
    try {
      stage = 'exit-intent'
      if (!(node ? process.platform === 'linux' : ['darwin', 'win32'].includes(process.platform)) || !message || typeof message !== 'object' || Array.isArray(message)
        || Object.keys(message).length !== 4 || !['kind', 'installation_id', 'operation_id', 'source_selection'].every(key => Object.hasOwn(message, key))
        || message.kind !== 'desktop_removal_source_exit' || message.installation_id !== proof.installation_id
        || message.operation_id !== proof.operation_id || !same(message.source_selection, proof.source_selection)
        || !child.connected || child.exitCode !== null || child.signalCode !== null) return false
      // The private ChildProcess channel is bound by the source caller. Capture
      // its actual image after startup, then require the same birth thereafter.
      host ??= identity.inspectProcess(child.pid)
      if (!current()) return false
      stage = 'private-programs'
      if (node) await verifyUbuntuRemovalNodeCopy(directory, proof)
      else await verifyDesktopGui(guiRoot, proof.payload)
      stage = 'job-proof'
      const actual = await readDesktopRemovalProof(own.root)
      accepted = actual.record.proof_sha256 === digest && same(actual.proof, proof) && current()
      return accepted
    } catch { return false }
    finally { console.info(JSON.stringify({ component: 'desktop-removal-source-exit', stage, accepted, elapsed_ms: Math.round(performance.now() - started) })) }
  }
}

// Role choice is fixed by the trusted source, never accepted from an IPC field.
export function createDesktopRemovalSourceExitVerifier(options) { return createSourceExitVerifier(options, false) }
export function createExistingRemovalSourceExitVerifier(options) { return createSourceExitVerifier(options, true) }

export function createDesktopRemovalNodeSourceExitVerifier(options) {
  if (process.platform !== 'linux') return async () => false
  return createSourceExitVerifier(options, false, 'node')
}

export function createExistingRemovalNodeSourceExitVerifier(options) {
  if (process.platform !== 'linux') return async () => false
  return createSourceExitVerifier(options, true, 'node')
}
