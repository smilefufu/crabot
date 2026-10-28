// Historical byte facts only. Parsing this proof cannot execute Core, remove
// programs, stop services, select versions or clear any maintenance protection.
import path from 'node:path'
import { createHash } from 'node:crypto'
import physicalFs from './physical-fs.cjs'
import identity from './process-identity.cjs'
import installation from './desktop-installation.cjs'
import management from './desktop-management.cjs'
import { readDesktopRemoval } from './desktop-removal-record.cjs'
import { readOriginalDesktopPayload } from './desktop-program-proof.mjs'
import { verifyDesktopPrograms } from './desktop-payload.mjs'
const { promises: fs, constants } = physicalFs
const fail = () => { throw Object.assign(new Error('卸载原程序证明无法核验，程序、用户数据和保护已保留。'), { code: 'CRABOT_DESKTOP_REMOVAL' }) }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const digest = text => createHash('sha256').update(text).digest('hex')
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
const fields = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const generation = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.size, stat.nlink, stat.mtimeNs, stat.ctimeNs].join(':')
function relative(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 32768
    && !/[\0\\:]/.test(value) && !path.posix.isAbsolute(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..'
      && (process.platform !== 'win32' || !/[<>"|?*]|[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))
}
function inventory(files) {
  if (!files || typeof files !== 'object' || Array.isArray(files) || !Object.keys(files).length) fail()
  for (const [name, item] of Object.entries(files)) {
    if (!relative(name)) fail()
    if (item?.type === 'file') {
      if (!fields(item, process.platform === 'win32' ? ['type', 'size', 'sha256'] : ['type', 'size', 'sha256', 'mode'])
        || !Number.isSafeInteger(item.size) || item.size < 0 || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)
        || process.platform !== 'win32' && (!Number.isInteger(item.mode) || item.mode < 0 || item.mode > 0o777)) fail()
    } else if (item?.type === 'link') {
      if (!fields(item, ['type', 'target']) || typeof item.target !== 'string' || !item.target || /[\0\\:]/.test(item.target) || path.posix.isAbsolute(item.target)) fail()
      const destination = path.posix.normalize(path.posix.join(path.posix.dirname(name), item.target))
      if (destination === '..' || destination.startsWith('../')) fail()
    } else fail()
  }
}
function validate(proof, record) {
  const selected = proof?.source_selection, payload = proof?.payload
  if (!fields(proof, ['schema_version', 'installation_id', 'operation_id', 'source_selection', 'payload', 'core'])
    || proof.schema_version !== 1 || proof.installation_id !== record.installation_id || proof.operation_id !== record.operation_id
    || !same(selected, record.source_selection) || !fields(selected, ['schema_version', 'version', 'gui_id', 'core_id'])
    || !fields(payload, ['schema_version', 'platform', 'arch', 'selection', 'gui']) || payload.schema_version !== 1
    || payload.platform !== process.platform || payload.arch !== process.arch || !same(payload.selection, selected)
    || !fields(proof.core, ['release', 'inventory', 'host']) || Object.values(proof.core).some(text => typeof text !== 'string')
    || Buffer.byteLength(proof.core.release) > 65536 || Buffer.byteLength(proof.core.host) > 4096
    || Buffer.byteLength(proof.core.inventory) > 64 * 1024 * 1024) fail()
  const release = JSON.parse(proof.core.release), index = JSON.parse(proof.core.inventory), host = JSON.parse(proof.core.host)
  if (!fields(release, ['schema_version', 'version', 'platform', 'arch', 'commit', 'source_dirty', 'inventory_sha256'])
    || release.schema_version !== 1 || release.version !== selected.version || release.platform !== process.platform || release.arch !== process.arch
    || typeof release.commit !== 'string' || !/^[a-f0-9]{40}$/.test(release.commit) || typeof release.source_dirty !== 'boolean'
    || release.inventory_sha256 !== selected.core_id || digest(proof.core.inventory) !== selected.core_id
    || !fields(index, ['schema_version', 'files']) || index.schema_version !== 1 || proof.core.inventory !== JSON.stringify({ schema_version: 1, files: index.files }) + '\n'
    || !fields(host, ['schema_version', 'platform', 'arch']) || host.schema_version !== 2 || host.platform !== process.platform || host.arch !== process.arch) fail()
  inventory(index.files); inventory(payload.gui)
  const canonical = { schema_version: 1, installation_id: record.installation_id, operation_id: record.operation_id,
    source_selection: record.source_selection, payload: { schema_version: 1, platform: process.platform, arch: process.arch,
      selection: record.source_selection, gui: payload.gui }, core: { release: proof.core.release, inventory: proof.core.inventory, host: proof.core.host } }
  if (!same(proof, canonical)) fail()
  return canonical
}
async function readFile(file, limit, privateFile) {
  const before = await fs.lstat(file, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(limit)
    || (process.platform === 'win32' ? !identity.isOwnedFile(file) || privateFile && !identity.isPrivateFile(file)
      : before.uid !== BigInt(process.getuid()) || privateFile && (before.mode & 0o777n) !== 0o600n)) fail()
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    if (generation(await handle.stat({ bigint: true })) !== generation(before)) fail()
    const bytes = Buffer.alloc(Number(before.size))
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) fail()
      offset += bytesRead
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead) fail()
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    if (generation(await handle.stat({ bigint: true })) !== generation(before) || generation(await fs.lstat(file, { bigint: true })) !== generation(before)) fail()
    return text
  } finally { await handle.close() }
}
export async function captureDesktopRemovalProof(root, operationId, { signal } = {}) {
  try {
    if (!uuid(operationId)) fail()
    const own = installation.readDesktopSelection(root), original = await readOriginalDesktopPayload(own.root, own.selection)
    await verifyDesktopPrograms(own.coreRoot, own.guiRoot, original.record, { signal })
    const core = {}
    for (const [key, name, limit] of [['release', 'core-release.json', 65536], ['inventory', 'core-files.json', 64 * 1024 * 1024], ['host', 'desktop-host.json', 4096]]) {
      signal?.throwIfAborted(); core[key] = await readFile(path.join(own.coreRoot, name), limit, false)
    }
    const proof = { schema_version: 1, installation_id: own.record.installation_id, operation_id: operationId,
      source_selection: own.selection, payload: original.record, core }
    validate(proof, { installation_id: own.record.installation_id, operation_id: operationId, source_selection: own.selection })
    if (Buffer.byteLength(JSON.stringify(proof) + '\n') > 128 * 1024 * 1024) fail()
    const current = installation.readDesktopSelection(own.root), actual = await readOriginalDesktopPayload(own.root, own.selection)
    if (!same(current.record, own.record) || !same(current.selection, own.selection) || actual.file !== original.file || actual.text !== original.text) fail()
    signal?.throwIfAborted(); return proof
  } catch (error) { if (signal?.aborted) signal.throwIfAborted(); fail() }
}
export async function readDesktopRemovalProof(root) {
  try {
    const own = installation.readDesktopInstallation(root), record = readDesktopRemoval(own.root)
    if (!record) fail()
    const parent = management.requirePrivateDataRoot(path.join(own.root, 'app/removals'))
    const directory = management.requirePrivateDataRoot(path.join(parent, record.operation_id))
    const directoryVersion = async file => {
      if (management.requirePrivateDataRoot(file) !== file) fail()
      const stat = await fs.lstat(file, { bigint: true })
      return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].join(':')
    }
    const parents = [parent, directory], generations = await Promise.all(parents.map(directoryVersion))
    const text = await readFile(path.join(directory, 'proof.json'), 128 * 1024 * 1024, true)
    if (digest(text) !== record.proof_sha256) fail()
    const proof = validate(JSON.parse(text), record)
    if (!same(await Promise.all(parents.map(directoryVersion)), generations)
      || text !== JSON.stringify(proof) + '\n' || !same(readDesktopRemoval(own.root), record)
      || !same(installation.readDesktopInstallation(own.root).record, own.record)) fail()
    return { record, proof }
  } catch { fail() }
}
