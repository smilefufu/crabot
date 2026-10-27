// Fixed program files only, under an already-removing job. This cannot stop
// services, change phases, clear the fence or establish uninstall completion.
import path from 'node:path'
import physical from './physical-fs.cjs'
import identity from './process-identity.cjs'
import { captureMacRemovalSystemProcesses, captureLinuxRemovalSystemProcesses } from './desktop-removal-system-processes.mjs'
import { captureDesktopRemovalJob } from './desktop-removal-context.mjs'
import { inspectDesktopRemovalPrograms, desktopRemovalProgramEntries, matchesDesktopRemovalProgram, desktopProgramGeneration } from './desktop-removal-programs.mjs'
const { promises: fs } = physical
const directoryIdentity = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].join(':')
const equalPath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const fail = () => { throw Object.assign(new Error('程序文件或目录身份已变化，剩余程序、用户数据和卸载保护已保留。'), { code: 'CRABOT_DESKTOP_REMOVAL' }) }
const referenceFailure = stage => { throw Object.assign(new Error('程序仍被使用或占用无法核实，剩余程序、用户数据和卸载保护已保留。请关闭相关程序后重试。'), { code: 'CRABOT_DESKTOP_PROGRAM_REFERENCES', stage }) }
// Read-only resource observation. A caller still needs its live job, source-exit
// and lock admission; this fact alone grants no phase change or deletion.
export async function assertDesktopRemovalProgramsUnused({ installRoot, proof }, stage) {
  const files = []
  for (const entry of desktopRemovalProgramEntries(proof)) {
    const file = path.join(installRoot, entry.name)
    try { physical.lstatSync(file); files.push(file) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const programDirectories = [path.join(installRoot, 'releases', proof.source_selection.core_id),
    path.join(installRoot, 'app/releases', proof.source_selection.gui_id)]
  // Once every proved program file and both program directories are absent,
  // there is no remaining deletion target. The bin base is retained. Job,
  // source-exit and lock checks remain the caller's independent responsibility.
  if (!files.length && programDirectories.every(directory => {
    try { physical.lstatSync(directory); return false }
    catch (error) { if (error.code === 'ENOENT') return true; throw error }
  })) return
  let unrelatedSystemUnknowns = () => false
  if (process.platform === 'darwin') unrelatedSystemUnknowns = captureMacRemovalSystemProcesses(installRoot)
  if (process.platform === 'linux') unrelatedSystemUnknowns = captureLinuxRemovalSystemProcesses(installRoot)
  let observation
  try { observation = await identity.inspectProgramReferences({ roots: [...programDirectories, path.join(installRoot, 'bin')], files }) }
  catch { referenceFailure(stage) }
  // Keep the raw observation, including every unknown and its fixed OS reason.
  if (observation.complete !== true || observation.incomplete !== false || !Array.isArray(observation.processes)
    || observation.processes.length || !Array.isArray(observation.unknown_pids) || observation.unknown_pids.length) {
    if (!unrelatedSystemUnknowns(observation)) referenceFailure(stage)
  }
}
export async function removeDesktopRemovalPrograms({ installRoot, operationId }) {
  const scope = { installRoot, operationId }
  const context = await captureDesktopRemovalJob(scope), { own, proof } = context
  const current = async () => { await context.proofCurrent(); context.assertJob() }
  await current()
  const entries = desktopRemovalProgramEntries(proof), parents = new Map(), removed = []
  const root = physical.lstatSync(own.root, { bigint: true })
  const owned = (file, stat) => process.platform === 'win32'
    ? stat.isDirectory() ? identity.isOwnedDirectory(file) : identity.isOwnedFile(file) : stat.uid === root.uid
  const baseDirectories = new Set(['app', 'app/releases', 'releases', 'bin'].map(name => path.join(own.root, name)))
  async function captureParents(file) {
    const list = []
    for (let parent = path.dirname(file); parent !== own.root; parent = path.dirname(parent)) {
      const relative = path.relative(own.root, parent)
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) fail()
      list.push(parent)
    }
    for (const parent of list.reverse()) {
      if (parents.has(parent)) continue
      let stat
      try { stat = await fs.lstat(parent, { bigint: true }) }
      catch (error) { if (error.code === 'ENOENT') return false; throw error }
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== root.dev || !owned(parent, stat)
        || !equalPath(await fs.realpath(parent), parent)) fail()
      parents.set(parent, directoryIdentity(stat))
    }
    return true
  }
  function assertDirectory(directory) {
    const stat = physical.lstatSync(directory, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(directory, stat) || directoryIdentity(stat) !== parents.get(directory)
      || !equalPath(physical.realpathSync(directory), directory)) fail()
  }
  function assertParents(file) {
    for (let parent = path.dirname(file); parent !== own.root; parent = path.dirname(parent)) assertDirectory(parent)
  }
  const assertBases = () => { for (const directory of baseDirectories) assertDirectory(directory) }
  const before = await inspectDesktopRemovalPrograms(scope), candidates = new Set(before.matched)
  for (const entry of entries) await captureParents(path.join(own.root, entry.name))
  await current()
  const directories = [...parents.keys()].filter(directory => !baseDirectories.has(directory))
  const observe = async stage => {
    await assertDesktopRemovalProgramsUnused({ installRoot: own.root, proof }, stage)
    await current()
  }
  if (candidates.size || directories.length) await observe('before-files')
  for (const directory of parents.keys()) assertDirectory(directory)
  let group
  for (const entry of entries) {
    if (!candidates.has(entry.name)) continue
    const nextGroup = entry.name.startsWith('app/') ? 'gui' : entry.name.startsWith('releases/') ? 'core' : 'launcher'
    if (group && group !== nextGroup) await observe('before-group')
    group = nextGroup
    const file = path.join(own.root, entry.name)
    try { assertParents(file) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    let stat
    try { stat = await fs.lstat(file, { bigint: true }) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    if (!await matchesDesktopRemovalProgram(file, entry.expected, stat, { owned })) continue
    assertParents(file); context.assertJob()
    const actual = physical.lstatSync(file, { bigint: true })
    if (desktopProgramGeneration(actual) !== desktopProgramGeneration(stat) || !owned(file, actual)) continue
    try { physical.unlinkSync(file) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    removed.push(entry.name)
    if (process.platform !== 'win32') {
      const directory = await fs.open(path.dirname(file), 'r')
      try { await directory.sync() } finally { await directory.close() }
    }
  }
  if (candidates.size || directories.length) await observe('before-directories')
  // Only known, still-identical, empty program directories. No recursive remove,
  // no traversal into unknown additions and no removal of the installation bases.
  for (const directory of directories.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length)) {
    try { assertDirectory(directory) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    assertParents(directory); context.assertJob()
    try { physical.rmdirSync(directory) }
    catch (error) { if (['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) continue; throw error }
    if (process.platform !== 'win32') {
      const parent = await fs.open(path.dirname(directory), 'r')
      try { await parent.sync() } finally { await parent.close() }
    }
  }
  assertBases()
  if (candidates.size || directories.length) await observe('after-directories')
  assertBases()
  await current()
  const after = await inspectDesktopRemovalPrograms(scope)
  await current(); assertBases()
  const retained = [...after.retained, ...after.matched.map(name => ({ path: name, reason: 'unverified' }))]
  retained.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  return { removed, missing: after.missing, retained }
}
