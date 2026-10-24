// Initial ordinary-GUI-to-private-copy handoff facts only. Existing removal
// recovery has a separate role; this cannot publish a job or operate services.
import path from 'node:path'
import { createHash } from 'node:crypto'
import physicalFs from './physical-fs.cjs'
import identity from './process-identity.cjs'
import entry from './desktop-entry.cjs'
import management from './desktop-management.cjs'
import installation from './desktop-installation.cjs'
import { processBirthAtLeast } from './owned-process-tree.cjs'
import { captureDesktopRemovalProof } from './desktop-removal-proof.mjs'
import { readOriginalDesktopPayload } from './desktop-program-proof.mjs'
import { verifyDesktopGui } from './desktop-payload.mjs'
const { promises: fs } = physicalFs
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const directoryIdentity = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].join(':')
const inside = (parent, child) => { const relative = path.relative(parent, child); return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
export async function captureInitialRemovalGuiHost({ installRoot, operationId, signal }) {
  let stage = 'transport'
  const fail = () => { throw Object.assign(new Error('卸载维护宿主的安装或进程交接无法核验，原程序与数据已保留。'), { code: 'CRABOT_DESKTOP_REMOVAL', stage }) }
  try {
    if (!['darwin', 'win32'].includes(process.platform) || !process.connected || typeof process.send !== 'function') fail()
    signal?.throwIfAborted()
    stage = 'source-peer'
    const own = installation.readDesktopSelection(installRoot), self = identity.inspectProcess(process.pid)
    const parent = self && identity.inspectProcess(self.parent), policy = { executable: own.executable, development: false }
    if (!self || !parent || self.owner !== own.record.owner || parent.owner !== self.owner || !processBirthAtLeast(self.started, parent.started)
      || !entry.verifyDesktopEntry(parent, policy)) fail()
    stage = 'private-location'
    const executable = await fs.realpath(process.execPath)
    if (await fs.realpath(self.executable) !== executable) fail()
    const guiRoot = process.platform === 'darwin' ? path.resolve(path.dirname(executable), '../../..') : path.dirname(executable)
    const directory = management.requirePrivateDataRoot(path.dirname(guiRoot))
    if (path.basename(guiRoot) !== 'gui' || !/^crabot-removal-host-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(path.basename(directory))
      || inside(own.root, directory) || inside(directory, own.root)) fail()
    const hostIdentity = directoryIdentity(await fs.lstat(directory, { bigint: true })), dataIdentity = directoryIdentity(await fs.lstat(own.dataDir, { bigint: true }))
    stage = 'source-programs'
    const proof = await captureDesktopRemovalProof(own.root, operationId, { signal })
    stage = 'private-programs'
    await verifyDesktopGui(guiRoot, proof.payload, { signal })
    stage = 'recheck'
    const source = await readOriginalDesktopPayload(own.root, own.selection)
    if (!same(source.record, proof.payload)) fail()
    const currentDataIdentity = directoryIdentity(await fs.lstat(own.dataDir, { bigint: true }))
    const currentHostIdentity = directoryIdentity(await fs.lstat(directory, { bigint: true }))
    const current = installation.readDesktopSelection(own.root), actualSelf = identity.inspectProcess(process.pid)
    if (!same(current.record, own.record) || !same(current.selection, proof.source_selection) || !same(own.selection, proof.source_selection)
      || !process.connected || typeof process.send !== 'function' || !identity.sameProcess(self, actualSelf) || actualSelf.parent !== parent.pid
      || !entry.verifyDesktopEntry(parent, policy) || currentDataIdentity !== dataIdentity
      || management.requirePrivateDataRoot(directory) !== directory || currentHostIdentity !== hostIdentity) fail()
    signal?.throwIfAborted()
    return { proof, facts: { installation_id: own.record.installation_id, operation_id: operationId, source_selection: proof.source_selection,
      source_gui: parent, host_gui: self, proof_sha256: createHash('sha256').update(JSON.stringify(proof) + '\n').digest('hex') } }
  } catch { if (signal?.aborted) signal.throwIfAborted(); fail() }
}

// Public facts-only inspection; the transaction captures the same proof under both locks.
export async function inspectInitialRemovalGuiHost(options) {
  return (await captureInitialRemovalGuiHost(options)).facts
}
