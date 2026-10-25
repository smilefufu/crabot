// Same removing-job facts and real OS-lock admission. No program execution,
// stop, deletion, selection change or maintenance completion occurs here.
import path from 'node:path'
import physical from './physical-fs.cjs'
import installation from './desktop-installation.cjs'
import * as proofs from './desktop-removal-proof.mjs'
import * as locks from './cli-lock.mjs'
import * as runtime from './instance-runtime.mjs'
import workspace from './workspace-maintenance.cjs'
import removal from './desktop-removal-record.cjs'
export async function captureDesktopRemovalJob(options) {
  const removalFail = () => { throw Object.assign(new Error('卸载作业、操作锁或停止结果无法核验，剩余程序、入口和用户数据已保留。'), { code: 'CRABOT_DESKTOP_REMOVAL' }) }
  const own = installation.readDesktopInstallation(options.installRoot)
  const directoryIdentity = (stat) => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].join(':')
  const dataIdentity = directoryIdentity(physical.lstatSync(own.dataDir, { bigint: true }))
  const initial = await proofs.readDesktopRemovalProof(own.root)
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const proofDirectory = path.join(own.root, 'app/removals', initial.record.operation_id)
  const proofFile = path.join(proofDirectory, 'proof.json')
  const fileIdentity = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
  const proofIdentity = fileIdentity(physical.lstatSync(proofFile, { bigint: true }))
  const proofParents = [path.dirname(proofDirectory), proofDirectory].map(directory => [directory, directoryIdentity(physical.lstatSync(directory, { bigint: true }))])
  const held = [own.root, own.dataDir].map(directory => {
    const file = path.join(directory, 'cli.lock')
    return { directory, file, token: locks.cliLockToken(file) }
  })
  // Final synchronous binding directly precedes each unlink; an earlier async
  // proof/snapshot must not retain authority after either OS lock was released.
  const assertJob = () => {
    const actual = removal.readDesktopRemoval(own.root)
    if (actual?.phase !== 'removing' || actual.operation_id !== options.operationId || !same(actual, initial.record)
      || !same(installation.readDesktopInstallation(own.root).record, own.record)
      || !same(installation.readDesktopPairReference(own.root).selection, initial.record.source_selection)
      || directoryIdentity(physical.lstatSync(own.dataDir, { bigint: true })) !== dataIdentity
      || fileIdentity(physical.lstatSync(proofFile, { bigint: true })) !== proofIdentity
      || proofParents.some(([directory, expected]) => directoryIdentity(physical.lstatSync(directory, { bigint: true })) !== expected)
      || !held.every(lock => lock.token && locks.cliLockToken(lock.file) === lock.token && locks.hasInheritedCliLock(lock.directory, lock.token))
      || workspace.workspaceMaintenancePending(own.dataDir) || runtime.inspectInstance(own.dataDir).state !== 'stopped') removalFail()
    try { physical.lstatSync(path.join(own.root, '.desktop-installing.json')); removalFail() }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    try { physical.lstatSync(path.join(own.dataDir, 'desktop-maintenance.json')); removalFail() }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    try { if (physical.readdirSync(path.join(own.dataDir, 'module-runtime-registry/records')).some((file) => file.endsWith('.json'))) removalFail() }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const proofCurrent = async () => {
    if (!same((await proofs.readDesktopRemovalProof(own.root)).record, initial.record)) removalFail()
  }
  return { own, record: initial.record, proof: initial.proof, assertJob, proofCurrent }
}
