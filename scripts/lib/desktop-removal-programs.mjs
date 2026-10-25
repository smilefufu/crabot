// Read-only byte observations of the current pair. These are not deletion or
// process-settlement authority and are never persisted or used to execute Core.
import path from 'node:path'
import { createHash } from 'node:crypto'
import physical from './physical-fs.cjs'
import native from './process-identity.cjs'
import installation from './desktop-installation.cjs'
import { readDesktopRemovalProof } from './desktop-removal-proof.mjs'
const { promises: fs, constants } = physical
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const generation = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
const fail = () => { throw Object.assign(new Error('原程序范围或卸载作业已变化，原文件和数据已保留。'), { code: 'CRABOT_DESKTOP_REMOVAL' }) }
const bytesRecord = text => ({ type: 'file', size: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') })
const equalPath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
export async function matchesDesktopRemovalProgram(file, expected, before, { owned, signal }) {
  if (before.nlink !== 1n || !owned(file, before)) return false
  if (expected.type === 'link') {
    if (!before.isSymbolicLink() || before.size > 32768n) return false
    const link = await fs.readlink(file)
    return link === expected.target && generation(before) === generation(await fs.lstat(file, { bigint: true }))
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size !== BigInt(expected.size)
    || expected.mode !== undefined && Number(before.mode & 0o777n) !== expected.mode) return false
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    if (generation(before) !== generation(await handle.stat({ bigint: true }))) return false
    const hash = createHash('sha256'), buffer = Buffer.alloc(65536)
    let offset = 0
    while (offset < expected.size) {
      signal?.throwIfAborted()
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, expected.size - offset), offset)
      if (!bytesRead) return false
      hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead
    }
    return !(await handle.read(buffer, 0, 1, offset)).bytesRead && hash.digest('hex') === expected.sha256
      && generation(before) === generation(await handle.stat({ bigint: true }))
      && generation(before) === generation(await fs.lstat(file, { bigint: true }))
  } finally { await handle.close() }
}
function programMaps(proof) {
  const core = { ...JSON.parse(proof.core.inventory).files }
  for (const [key, name] of [['release', 'core-release.json'], ['inventory', 'core-files.json'], ['host', 'desktop-host.json']]) {
    if (Object.hasOwn(core, name)) fail()
    core[name] = bytesRecord(proof.core[key])
  }
  const launcher = process.platform === 'win32' ? 'crabot.exe' : 'crabot', launcherRecord = core['bin/' + launcher]
  if (launcherRecord?.type !== 'file') fail()
  return { core, launcher, launcherRecord }
}

export function desktopRemovalProgramEntries(proof) {
  const { core, launcher, launcherRecord } = programMaps(proof), selected = proof.source_selection
  return [
    ...Object.entries(core).map(([name, expected]) => ({ name: 'releases/' + selected.core_id + '/' + name, expected })),
    ...Object.entries(proof.payload.gui).map(([name, expected]) => ({ name: 'app/releases/' + selected.gui_id + '/' + name, expected })),
    { name: 'bin/' + launcher, expected: launcherRecord },
  ].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}

export { generation as desktopProgramGeneration }

export async function inspectDesktopRemovalPrograms({ installRoot, operationId, signal }) {
  signal?.throwIfAborted()
  const own = installation.readDesktopInstallation(installRoot), original = await readDesktopRemovalProof(own.root)
  const { record, proof } = original
  if (record.operation_id !== operationId || !same(installation.readDesktopPairReference(own.root).selection, record.source_selection)) fail()
  const rootStat = await fs.lstat(own.root, { bigint: true }), parents = new Map()
  const result = { matched: [], missing: [], retained: [] }
  const relative = file => path.relative(own.root, file).split(path.sep).join('/')
  const retain = (file, reason) => result.retained.push({ path: relative(file), reason })
  const owned = (file, stat) => {
    if (process.platform !== 'win32') return stat.uid === rootStat.uid
    return stat.isDirectory() ? native.isOwnedDirectory(file) : native.isOwnedFile(file)
  }
  async function directory(file) {
    const stat = await fs.lstat(file, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== rootStat.dev || !owned(file, stat)
      || !equalPath(await fs.realpath(file), file)) fail()
    if (parents.has(file) && parents.get(file) !== generation(stat)) fail()
    parents.set(file, generation(stat))
  }
  async function checkParents(file) {
    const list = []
    for (let parent = path.dirname(file); parent !== own.root; parent = path.dirname(parent)) {
      const from = path.relative(own.root, parent)
      if (!from || from === '..' || from.startsWith('..' + path.sep) || path.isAbsolute(from)) fail()
      list.push(parent)
    }
    for (const parent of list.reverse()) {
      try { await directory(parent) }
      catch (error) { if (error.code === 'ENOENT') return false; throw error }
    }
    return true
  }
  function tree(files) {
    const root = { children: new Map() }
    for (const [name, record] of Object.entries(files)) {
      let node = root
      for (const part of name.split('/')) {
        if (node.record) fail()
        if (!node.children.has(part)) node.children.set(part, { children: new Map() })
        node = node.children.get(part)
      }
      if (node.record || node.children.size) fail()
      node.record = record
    }
    return root
  }
  function missing(file, node) {
    if (node.record) result.missing.push(relative(file))
    else for (const [name, child] of node.children) missing(path.join(file, name), child)
  }
  async function inspect(file, node) {
    signal?.throwIfAborted()
    let before
    try {
      if (!await checkParents(file)) { missing(file, node); return }
      before = await fs.lstat(file, { bigint: true })
    } catch (error) {
      if (error.code === 'ENOENT') missing(file, node)
      else retain(file, 'unverified')
      return
    }
    try {
      if (node.record) {
        const match = await matchesDesktopRemovalProgram(file, node.record, before, { owned, signal })
        if (!await checkParents(file)) fail()
        if (match) result.matched.push(relative(file))
        else retain(file, 'changed')
      } else {
        await directory(file)
        const children = await fs.readdir(file)
        for (const [name, child] of node.children) await inspect(path.join(file, name), child)
        for (const name of children) if (!node.children.has(name)) retain(path.join(file, name), 'unknown')
        await directory(file)
      }
    } catch { signal?.throwIfAborted(); retain(file, 'unverified') }
  }
  const { core, launcher, launcherRecord } = programMaps(proof)
  await inspect(path.join(own.root, 'releases', record.source_selection.core_id), tree(core))
  await inspect(path.join(own.root, 'app/releases', record.source_selection.gui_id), tree(proof.payload.gui))
  await inspect(path.join(own.root, 'bin', launcher), { record: launcherRecord })
  signal?.throwIfAborted()
  const current = await readDesktopRemovalProof(own.root)
  if (!same(current.record, record) || !same(installation.readDesktopInstallation(own.root).record, own.record)
    || !same(installation.readDesktopPairReference(own.root).selection, record.source_selection)) fail()
  // Any observed directory replacement invalidates the entire byte observation.
  for (const file of parents.keys()) await directory(file)
  for (const name of ['matched', 'missing']) result[name].sort()
  result.retained.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  return result
}
