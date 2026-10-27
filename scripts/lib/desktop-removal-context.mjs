// Same stopped-job facts and real OS-lock admission. No program execution,
// stop, deletion, selection change or maintenance completion occurs here.
import path from 'node:path'
import physical from './physical-fs.cjs'
import installation from './desktop-installation.cjs'
import * as proofs from './desktop-removal-proof.mjs'
import * as locks from './cli-lock.mjs'
import * as runtime from './instance-runtime.mjs'
import workspace from './workspace-maintenance.cjs'
import removal from './desktop-removal-record.cjs'
import identity from './process-identity.cjs'
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const removalFail = () => { throw Object.assign(new Error('卸载作业、操作锁或停止结果无法核验，剩余程序、入口和用户数据已保留。'), { code: 'CRABOT_DESKTOP_REMOVAL' }) }
export async function captureDesktopRemovalFacts(options) {
  const own = installation.readDesktopInstallation(options.installRoot)
  const directoryIdentity = (stat) => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].join(':')
  const dataIdentity = directoryIdentity(physical.lstatSync(own.dataDir, { bigint: true })), selection = installation.readDesktopPairReference(own.root).selection
  const initial = await proofs.readDesktopRemovalProof(own.root)
  const proofDirectory = path.join(own.root, 'app/removals', initial.record.operation_id)
  const proofFile = path.join(proofDirectory, 'proof.json')
  const fileIdentity = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
  const proofIdentity = fileIdentity(physical.lstatSync(proofFile, { bigint: true }))
  const proofParents = [path.dirname(proofDirectory), proofDirectory].map(directory => [directory, directoryIdentity(physical.lstatSync(directory, { bigint: true }))])
  const held = [own.root, own.dataDir].map(directory => {
    const file = path.join(directory, 'cli.lock')
    return { directory, file, token: locks.cliLockToken(file) }
  })
  // Capture immutable document bytes once, then revalidate their complete file
  // generations and access on every admission. Changed generations take the
  // original full readers again; no live process/lock/permission result is cached.
  const directories = [own.root, ...['app', 'app/releases', 'releases', 'data', 'bin'].map(name => path.join(own.root, name))]
  const documents = ['desktop-installation.json', '.desktop-removal.json'].map(name => path.join(own.root, name))
  let documentVersions
  const observeDocument = file => {
    const stat = physical.lstatSync(file, { bigint: true })
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n
      || (process.platform === 'win32' ? !identity.isPrivateFile(file) : String(stat.uid) !== own.record.owner || (stat.mode & 0o777n) !== 0o600n)) removalFail()
    return fileIdentity(stat)
  }
  const observeDocuments = () => documents.map(observeDocument)
  const assertFixedDocuments = () => {
    const before = observeDocuments()
    if (documentVersions && same(before, documentVersions)) return
    const actual = removal.readDesktopRemoval(own.root)
    if (actual?.operation_id !== options.operationId || !same(actual, initial.record)
      || !same(installation.readDesktopInstallation(own.root).record, own.record)
      || !same(before, observeDocuments())) removalFail()
    documentVersions = before
  }
  // Selection is a stopped/removing-role policy. Generic reinstall facts must
  // still allow their caller to verify its explicit old-to-new handoff.
  let selectionVersion
  const assertSourceSelection = () => {
    const file = path.join(own.root, 'current-release.json'), before = observeDocument(file)
    if (before === selectionVersion) return
    if (!same(installation.readDesktopPairReference(own.root).selection, initial.record.source_selection)
      || observeDocument(file) !== before) removalFail()
    selectionVersion = before
  }
  // These facts grant no program mutation or permission to ignore preparations.
  const assertIdentity = () => {
    if (physical.realpathSync.native(own.root) !== own.root) removalFail()
    for (const directory of directories) {
      const stat = physical.lstatSync(directory, { bigint: true }), managed = directory === own.root || directory === own.dataDir
      if (!stat.isDirectory() || stat.isSymbolicLink()
        || directory === own.root && (String(stat.dev) !== own.record.root_identity.dev || String(stat.ino) !== own.record.root_identity.ino)
        || (process.platform === 'win32' ? !identity.isOwnedDirectory(directory) || managed && !identity.isExistingDataDirectory(directory)
          : String(stat.uid) !== own.record.owner || managed && ((stat.mode & 0o700n) !== 0o700n || (stat.mode & 0o022n) !== 0n))) removalFail()
    }
    assertFixedDocuments()
    if (directoryIdentity(physical.lstatSync(own.dataDir, { bigint: true })) !== dataIdentity
      || fileIdentity(physical.lstatSync(proofFile, { bigint: true })) !== proofIdentity
      || proofParents.some(([directory, expected]) => directoryIdentity(physical.lstatSync(directory, { bigint: true })) !== expected)
      || !held.every(lock => lock.token && locks.cliLockToken(lock.file) === lock.token && locks.hasInheritedCliLock(lock.directory, lock.token))
      || workspace.workspaceMaintenancePending(own.dataDir) || runtime.inspectInstance(own.dataDir).state !== 'stopped') removalFail()
  }
  const proofCurrent = async () => {
    if (!same((await proofs.readDesktopRemovalProof(own.root)).record, initial.record)) removalFail()
  }
  return { own, record: initial.record, proof: initial.proof, selection, assertIdentity, assertSourceSelection, proofCurrent }
}

function assertModulesStopped(own) {
  try { physical.lstatSync(path.join(own.dataDir, 'desktop-maintenance.json')); removalFail() }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  try { if (physical.readdirSync(path.join(own.dataDir, 'module-runtime-registry/records')).some(file => file.endsWith('.json'))) removalFail() }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}
// Read-only stopped facts. Each consumer still owns its preparation/phase policy.
export async function captureStoppedDesktopRemoval(options) {
  const { own, record, proof, assertIdentity, assertSourceSelection, proofCurrent } = await captureDesktopRemovalFacts(options)
  return { own, record, proof, proofCurrent, assertStopped: () => { assertIdentity(); assertSourceSelection(); assertModulesStopped(own) } }
}
// Destructive admission keeps its original fixed role and field shape.
export async function captureDesktopRemovalJob(options) {
  const { own, record, proof, assertIdentity, assertSourceSelection, proofCurrent } = await captureDesktopRemovalFacts(options)
  const assertJob = () => {
    if (record.phase !== 'removing') removalFail()
    assertIdentity(); assertSourceSelection()
    try { physical.lstatSync(path.join(own.root, '.desktop-installing.json')); removalFail() }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    assertModulesStopped(own)
  }
  return { own, record, proof, assertJob, proofCurrent }
}
