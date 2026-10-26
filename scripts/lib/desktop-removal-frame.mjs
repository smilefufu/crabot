// Ordinary-GUI-to-private-copy handoff facts in separate initial/existing roles.
// Neither role publishes a job, operates services or executes Core.
import path from 'node:path'
import { createHash } from 'node:crypto'
import physicalFs from './physical-fs.cjs'
import identity from './process-identity.cjs'
import entry from './desktop-entry.cjs'
import management from './desktop-management.cjs'
import installation from './desktop-installation.cjs'
import { verifyUbuntuRemovalNodeCopy } from './desktop-removal-host.mjs'
import { processBirthAtLeast } from './owned-process-tree.cjs'
import { captureDesktopRemovalProof, readDesktopRemovalProof } from './desktop-removal-proof.mjs'
import { readOriginalDesktopPayload } from './desktop-program-proof.mjs'
import { verifyDesktopGui } from './desktop-payload.mjs'
const { promises: fs } = physicalFs
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const directoryIdentity = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].join(':')
const inside = (parent, child) => { const relative = path.relative(parent, child); return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
async function captureGuiHost({ installRoot, operationId, signal }, existing) {
  let stage = 'transport'
  const fail = () => { throw Object.assign(new Error('卸载维护宿主的安装或进程交接无法核验，原程序与数据已保留。'), { code: 'CRABOT_DESKTOP_REMOVAL', stage }) }
  try {
    if (!['darwin', 'win32'].includes(process.platform) || !process.connected || typeof process.send !== 'function') fail()
    signal?.throwIfAborted()
    stage = 'source-peer'
    const base = existing ? installation.readDesktopInstallation(installRoot) : installation.readDesktopSelection(installRoot)
    const selection = existing ? installation.readDesktopPairReference(base.root).selection : base.selection
    const guiRootAtSource = path.join(base.root, 'app/releases', selection.gui_id)
    const own = { ...base, selection, guiRoot: guiRootAtSource, executable: path.join(guiRootAtSource,
      process.platform === 'darwin' ? 'Crabot.app/Contents/MacOS/Crabot' : 'Crabot.exe') }
    const self = identity.inspectProcess(process.pid)
    const parent = self && identity.inspectProcess(self.parent), policy = { executable: own.executable, development: false }
    if (!self || !parent || self.owner !== own.record.owner || parent.owner !== self.owner || !processBirthAtLeast(self.started, parent.started)
      || !entry.verifyDesktopRemovalSourceEntry(parent, policy)) fail()
    stage = 'private-location'
    const executable = await fs.realpath(process.execPath)
    if (await fs.realpath(self.executable) !== executable) fail()
    const guiRoot = process.platform === 'darwin' ? path.resolve(path.dirname(executable), '../../..') : path.dirname(executable)
    const directory = management.requirePrivateDataRoot(path.dirname(guiRoot))
    if (path.basename(guiRoot) !== 'gui' || !/^crabot-removal-host-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(path.basename(directory))
      || inside(own.root, directory) || inside(directory, own.root)) fail()
    const hostIdentity = directoryIdentity(await fs.lstat(directory, { bigint: true })), dataIdentity = directoryIdentity(await fs.lstat(own.dataDir, { bigint: true }))
    stage = 'source-programs'
    const previous = existing ? await readDesktopRemovalProof(own.root) : null
    if (previous && (previous.record.operation_id !== operationId || !same(previous.record.source_selection, own.selection))) fail()
    const proof = previous ? previous.proof : await captureDesktopRemovalProof(own.root, operationId, { signal })
    if (previous) await verifyDesktopGui(own.guiRoot, proof.payload, { signal })
    stage = 'private-programs'
    await verifyDesktopGui(guiRoot, proof.payload, { signal })
    stage = 'recheck'
    if (previous) {
      const source = await readDesktopRemovalProof(own.root)
      if (!same(source.record, previous.record) || !same(source.proof, proof)) fail()
    } else if (!same((await readOriginalDesktopPayload(own.root, own.selection)).record, proof.payload)) fail()
    const currentDataIdentity = directoryIdentity(await fs.lstat(own.dataDir, { bigint: true }))
    const currentHostIdentity = directoryIdentity(await fs.lstat(directory, { bigint: true }))
    const current = existing ? { ...installation.readDesktopInstallation(own.root), selection: installation.readDesktopPairReference(own.root).selection }
      : installation.readDesktopSelection(own.root)
    const actualSelf = identity.inspectProcess(process.pid)
    if (!same(current.record, own.record) || !same(current.selection, proof.source_selection) || !same(own.selection, proof.source_selection)
      || !process.connected || typeof process.send !== 'function' || !identity.sameProcess(self, actualSelf) || actualSelf.parent !== parent.pid
      || !entry.verifyDesktopRemovalSourceEntry(parent, policy) || currentDataIdentity !== dataIdentity
      || management.requirePrivateDataRoot(directory) !== directory || currentHostIdentity !== hostIdentity) fail()
    signal?.throwIfAborted()
    return { ...(previous ? { record: previous.record } : {}), proof, facts: { installation_id: own.record.installation_id, operation_id: operationId, source_selection: proof.source_selection,
      source_gui: parent, host_gui: self, proof_sha256: createHash('sha256').update(JSON.stringify(proof) + '\n').digest('hex') } }
  } catch { if (signal?.aborted) signal.throwIfAborted(); fail() }
}

export function captureInitialRemovalGuiHost(options) { return captureGuiHost(options, false) }
// A separate existing-job role: no initial proof creation and no Core loading.
export function captureExistingRemovalGuiHost(options) { return captureGuiHost(options, true) }

// Public facts-only inspection; the transaction captures the same proof under both locks.
export async function inspectInitialRemovalGuiHost(options) {
  return (await captureInitialRemovalGuiHost(options)).facts
}

// Linux's plain Node is a distinct host role, never an ordinary desktop peer.
// These are handoff facts only; the transaction owns publication and actions.
export async function captureInitialRemovalNodeHost({ installRoot, operationId, signal }) {
  const fail = () => { throw Object.assign(new Error('独立Node维护宿主的来源或副本无法核验，原程序与数据已保留。'), { code: 'CRABOT_DESKTOP_REMOVAL' }) }
  try {
    if (process.platform !== 'linux' || !process.connected || typeof process.send !== 'function') fail()
    signal?.throwIfAborted()
    const own = installation.readDesktopSelection(installRoot), self = identity.inspectProcess(process.pid)
    const parent = self && identity.inspectProcess(self.parent), policy = { executable: own.executable, development: false }
    if (!self || !parent || self.owner !== own.record.owner || parent.owner !== self.owner || !processBirthAtLeast(self.started, parent.started)
      || !entry.verifyDesktopRemovalSourceEntry(parent, policy)) fail()
    const executable = await fs.realpath(process.execPath), directory = management.requirePrivateDataRoot(path.dirname(executable))
    if (await fs.realpath(self.executable) !== executable || path.basename(executable) !== 'node'
      || !/^crabot-removal-host-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(path.basename(directory))
      || inside(own.root, directory) || inside(directory, own.root) || await fs.realpath(process.cwd()) !== directory) fail()
    const hostIdentity = directoryIdentity(await fs.lstat(directory, { bigint: true })), dataIdentity = directoryIdentity(await fs.lstat(own.dataDir, { bigint: true }))
    const proof = await captureDesktopRemovalProof(own.root, operationId, { signal })
    await verifyUbuntuRemovalNodeCopy(directory, proof, { signal })
    const current = installation.readDesktopSelection(own.root), source = await readOriginalDesktopPayload(own.root, own.selection)
    const actualSelf = identity.inspectProcess(process.pid), actualParent = identity.inspectProcess(parent.pid)
    if (!same(current.record, own.record) || !same(current.selection, proof.source_selection) || !same(source.record, proof.payload)
      || !process.connected || typeof process.send !== 'function' || !identity.sameProcess(self, actualSelf) || actualSelf.parent !== parent.pid
      || !identity.sameProcess(parent, actualParent) || !entry.verifyDesktopRemovalSourceEntry(actualParent, policy) || directoryIdentity(await fs.lstat(own.dataDir, { bigint: true })) !== dataIdentity
      || management.requirePrivateDataRoot(directory) !== directory || directoryIdentity(await fs.lstat(directory, { bigint: true })) !== hostIdentity) fail()
    signal?.throwIfAborted()
    return { proof, facts: { installation_id: own.record.installation_id, operation_id: operationId, source_selection: proof.source_selection,
      source_gui: parent, host_node: self, proof_sha256: createHash('sha256').update(JSON.stringify(proof) + '\n').digest('hex') } }
  } catch { if (signal?.aborted) signal.throwIfAborted(); fail() }
}
