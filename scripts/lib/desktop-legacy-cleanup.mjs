// Voluntary historical-program cleanup only. No install, service stop, version switch or data migration.
import physicalFs from './physical-fs.cjs'
const { promises: fs } = physicalFs
import path from 'node:path'
const uuid = value => /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
const digest = value => /^[a-f0-9]{64}$/.test(value)
const identityOf = stat => [String(stat.dev), String(stat.ino)].join(':')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const exists = async file => { try { return await fs.lstat(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
async function productionApi() {
  const [{ default: identity }, { default: installation }, core, gui] = await Promise.all([
    import('./process-identity.cjs'), import('./desktop-installation.cjs'), import('./core-release.mjs'), import('./desktop-payload.mjs'),
  ])
  return { identity, current: root => installation.readDesktopSelection(root),
    verifyCore: (directory, record) => core.verifyCoreRelease(directory, { version: record.selection.version }),
    verifyGui: gui.verifyDesktopGui }
}
export async function legacyProgramCleanup(root, suppliedApi) {
  const api = suppliedApi ?? await productionApi(), original = api.current(root)
  root = original.root
  const assertCurrent = async () => {
    const current = api.current(root)
    if (current.root !== root || current.record.installation_id !== original.record.installation_id
      || current.coreRoot !== original.coreRoot || current.guiRoot !== original.guiRoot || !same(current.selection, original.selection)) throw new Error('安装已变化，请重新预览。')
    for (const name of ['.desktop-installing.json', '.desktop-removal.json', '.desktop-reinstall.json', 'data/desktop-maintenance.json']) {
      if (await exists(path.join(root, name))) throw new Error('有安装或恢复尚未完成，保留历史程序。')
    }
    if (await exists(path.join(root, '.desktop-takeover', 'transaction.json'))) throw new Error('存在历史接管记录，恢复依赖无法确认，保留历史程序。')
    if (original.dataDir && await exists(path.join(original.dataDir, 'desktop-maintenance.json'))) throw new Error('数据恢复尚未完成，保留历史程序。')
  }
  const physical = async relative => {
    let current = root
    for (const segment of relative.split('/')) {
      current = path.join(current, segment)
      const stat = await exists(current)
      if (!stat) return null
      if (stat.isSymbolicLink() || !api.identity.isOwnedDirectory(path.dirname(current))) throw new Error('历史程序路径无法确认。')
    }
    return current
  }
  const treeInfo = async directory => {
    const result = { bytes: 0, files: [] }
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name), stat = await fs.lstat(file)
      if (item.isDirectory()) {
        const child = await treeInfo(file); result.bytes += child.bytes; result.files.push(...child.files)
      } else if (item.isFile()) { result.bytes += stat.size; result.files.push(file) }
      else if (!item.isSymbolicLink()) throw new Error('历史目录含未知文件类型。')
    }
    return result
  }

  const verify = async candidate => {
    await assertCurrent()
    const target = await physical(candidate.relative)
    if (!target || target === original.coreRoot || target === original.guiRoot || !(await fs.lstat(target)).isDirectory() || !api.identity.isOwnedDirectory(target)) throw new Error('历史程序范围已变化。')
    if (identityOf(await fs.lstat(target, { bigint: true })) !== candidate.identity) throw new Error('历史程序目录已被替换。')
    const proof = await physical('app/payloads/' + candidate.record.selection.gui_id + '.json')
    if (!proof || !api.identity.isPrivateFile(proof) || !same(JSON.parse(await fs.readFile(proof, 'utf8')), candidate.record)) throw new Error('历史程序归属证明已变化。')
    if (candidate.kind === 'core') {
      const core = await api.verifyCore(target, candidate.record)
      if (core.inventory_sha256 !== candidate.record.selection.core_id) throw new Error('历史 Core 清单不匹配。')
    } else await api.verifyGui(target, candidate.record)
    const info = await treeInfo(target)
    const observation = await api.identity.inspectProgramReferences({ roots: [target], files: info.files })
    if (observation.complete !== true || observation.incomplete !== false || !Array.isArray(observation.processes)
      || observation.processes.length || !Array.isArray(observation.unknown_pids) || observation.unknown_pids.length) throw new Error('后台进程正在使用，或占用无法确认，已保留。')
    await assertCurrent()
    if (identityOf(await fs.lstat(target, { bigint: true })) !== candidate.identity) throw new Error('历史程序目录已被替换。')
    return { target, bytes: info.bytes }
  }
  await assertCurrent()
  const candidates = [], retained = [], proofs = await physical('app/payloads')
  if (proofs) for (const name of await fs.readdir(proofs)) {
    if (!name.endsWith('.json') || !uuid(name.slice(0, -5))) continue
    try {
      const file = await physical('app/payloads/' + name)
      const stat = file && await fs.lstat(file)
      if (!stat?.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024 || !api.identity.isPrivateFile(file)) continue
      const record = JSON.parse(await fs.readFile(file, 'utf8'))
      if (record.schema_version !== 1 || record.platform !== process.platform || record.arch !== process.arch
        || !uuid(record.selection?.gui_id) || name !== record.selection.gui_id + '.json' || !digest(record.selection?.core_id)) continue
      for (const [kind, relative] of [['core', 'releases/' + record.selection.core_id], ['gui', 'app/releases/' + record.selection.gui_id]]) {
        if (candidates.some(item => item.relative === relative)) continue
        const target = await physical(relative)
        if (!target || target === original.coreRoot || target === original.guiRoot) continue
        const candidate = { kind, relative, identity: identityOf(await fs.lstat(target, { bigint: true })), record }
        try { const checked = await verify(candidate); candidates.push({ ...candidate, bytes: checked.bytes }) }
        catch (error) { retained.push({ relative, reason: error.message }) }
      }
    } catch (error) { retained.push({ relative: 'app/payloads/' + name, reason: error.message }) }
  }
  // Unknown directories are reported, never inferred to be owned from their location alone.
  for (const parent of ['releases', 'app/releases']) {
    const directory = await physical(parent)
    if (!directory) continue
    for (const name of await fs.readdir(directory)) {
      const relative = parent + '/' + name
      if (!candidates.some(item => item.relative === relative) && !retained.some(item => item.relative === relative)
        && path.join(root, relative) !== original.coreRoot && path.join(root, relative) !== original.guiRoot) retained.push({ relative, reason: '缺少可确认的本安装旧程序证明，已保留。' })
    }
  }
  return { preview: candidates.map(({ relative, bytes }) => ({ relative, bytes })), retained,
    async removeConfirmed() {
      const removed = [], kept = [...retained]
      for (const candidate of candidates) {
        let deleting = false
        try {
          const { target } = await verify(candidate)
          deleting = true
          await fs.rm(target, { recursive: true })
          removed.push(candidate.relative)
        } catch (error) { kept.push({ relative: candidate.relative, reason: deleting ? `清理未完成，可能已移除部分旧程序文件：${error.message}` : error.message }) }
      }
      return { removed, retained: kept }
    } }
}
