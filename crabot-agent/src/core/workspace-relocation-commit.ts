import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { sha256CanonicalJson } from 'crabot-shared'
import { createWorkspaceMaintenanceFileAccess, version, sameIdentity, digest } from './workspace-maintenance-files.js'
import type { WorkspaceRelocationLedgerSnapshot } from './workspace-relocation-ledgers.js'
import type { WorkspaceRelocationLedgerClosure } from '../workers/harness/workspace-relocation-close.js'

const native = require('../../../scripts/lib/process-identity.cjs')
const management = require('../../../scripts/lib/desktop-management.cjs')
const failure = () => new Error('执行器关闭提交无法核实，已保留原数据、提交事实和维护保护。')
const { owned, syncDirectory, readJson, publish } = createWorkspaceMaintenanceFileAccess(failure)
interface ClosurePlan {
  intent_id: string
  directories: WorkspaceRelocationLedgerSnapshot['directories']
  names: readonly string[]
  ledgers: ReadonlyArray<{ name: string; manager_key: string; before_version: string; before_sha256: string; after_sha256: string; closed_worker_ids: readonly string[] }>
}
interface PreparedFact { temporary: string; version: string }

/** Agent-owned fixed-plan primitive. Its caller supplies current job authorization before every effect. */
export async function commitWorkspaceRelocationLedgers({ snapshot, plan, prepared, verify }: {
  snapshot: WorkspaceRelocationLedgerSnapshot
  plan: ClosurePlan
  prepared: ReadonlyArray<WorkspaceRelocationLedgerClosure>
  verify: () => Promise<unknown>
}) {
  await verify()
  if (prepared.reduce((sum, row) => sum + Buffer.byteLength(row.contents), 0) > 64 * 1024 * 1024) throw failure()
  const root = management.requireExistingDataRoot(snapshot.data_root) as string
  const directory = path.join(root, 'agent/worker-ledgers'), journal = path.join(root, 'workspace-control/relocation-active/relocation-worker-commits')
  const planHash = sha256CanonicalJson(plan), byManager = new Map<string, WorkspaceRelocationLedgerClosure>(prepared.map(row => [row.manager_key, row]))
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(plan.intent_id)
    || plan.directories.length !== 3 || plan.directories[0].path !== root || plan.directories[1].path !== path.join(root, 'agent')
    || plan.directories[2].path !== directory || plan.ledgers.length !== snapshot.files.length) throw failure()
  const checkDirectories = () => {
    for (const item of plan.directories) {
      const stat = owned(item.path, true)
      if (!sameIdentity(version(stat), item.version, true) || fs.realpathSync(item.path) !== item.path
        || process.platform === 'win32' && native.inspectDirectoryFileId(item.path) !== item.native_id) throw failure()
    }
    owned(path.join(root, 'workspace-control'), true, true)
    owned(path.join(root, 'workspace-control/relocation-active'), true, true)
  }
  const pins: unknown[] = []
  try {
    checkDirectories()
    if (process.platform === 'win32') for (const item of plan.directories) pins.push(native.pinDirectory(item.path))
    let journalExists = false
    try { owned(journal, true, true); if (fs.realpathSync(journal) !== journal) throw failure(); journalExists = true }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const existingHeader = journalExists ? readJson(path.join(journal, 'header.json')) : undefined
    if (!existingHeader) {
      try { fs.lstatSync(journal); throw failure() } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      for (const [index, item] of plan.directories.entries()) if (version(owned(item.path, true)) !== snapshot.directories[index].version
        || snapshot.directories[index].version !== item.version) throw failure()
    }
    const currentFiles = new Map(snapshot.files.map(item => [item.name, item]))
    for (const item of plan.ledgers) {
      const current = currentFiles.get(item.name), output = byManager.get(item.manager_key)
      if (!current || current.manager_key !== item.manager_key || path.basename(item.name) !== item.name || !output
        || output.after_sha256 !== item.after_sha256 || digest(output.contents) !== item.after_sha256
        || current.version !== version(owned(path.join(directory, item.name)))) throw failure()
      const currentHash = digest(current.contents)
      if (currentHash === item.before_sha256) {
        if (current.version !== item.before_version || output.before_sha256 !== item.before_sha256
          || JSON.stringify(output.closed_worker_ids) !== JSON.stringify(item.closed_worker_ids)) throw failure()
      } else if (currentHash !== item.after_sha256 || !existingHeader) throw failure()
    }
    await verify(); checkDirectories()
    if (!existingHeader) {
      if (JSON.stringify(fs.readdirSync(directory).sort()) !== JSON.stringify(plan.names)) throw failure()
      if (process.platform === 'win32') native.createPrivateDirectory(journal)
      else fs.mkdirSync(journal, { mode: 0o700 })
      syncDirectory(path.dirname(journal))
      const stat = owned(journal, true, true)
      publish(journal, 'header.json', { schema_version: 1, intent_id: plan.intent_id, plan_sha256: planHash,
        directory_version: version(stat), native_id: process.platform === 'win32' ? native.inspectDirectoryFileId(journal) : null }, checkDirectories)
    }
    const header = readJson(path.join(journal, 'header.json'))
    const checkJournal = () => {
      checkDirectories()
      if (!header || Object.keys(header).sort().join() !== 'directory_version,intent_id,native_id,plan_sha256,schema_version'
        || header.schema_version !== 1 || header.intent_id !== plan.intent_id || header.plan_sha256 !== planHash
        || !sameIdentity(version(owned(journal, true, true)), header.directory_version, true)
        || (process.platform === 'win32' ? native.inspectDirectoryFileId(journal) !== header.native_id : header.native_id !== null)
        || sha256CanonicalJson(readJson(path.join(journal, 'header.json'))) !== sha256CanonicalJson(header)) throw failure()
    }
    checkJournal()
    if (process.platform === 'win32') pins.push(native.pinDirectory(journal))
    const facts = new Map<number, PreparedFact>(), done = new Map<number, { version: string }>()
    const allowed = new Set(['header.json', 'complete.json'])
    for (const [index, item] of plan.ledgers.entries()) {
      if (item.before_sha256 === item.after_sha256) continue
      const name = index + '.prepared.json', closedName = index + '.closed.json'
      allowed.add(name); allowed.add(closedName)
      const fact = readJson(path.join(journal, name)), closed = readJson(path.join(journal, closedName))
      if (fact !== undefined) {
        if (Object.keys(fact).sort().join() !== 'temporary,version' || typeof fact.temporary !== 'string'
          || !/^\.tmp-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.json$/.test(fact.temporary)
          || typeof fact.version !== 'string' || !/^-?[0-9]+(?::-?[0-9]+){8}$/.test(fact.version)
          || plan.names.includes(fact.temporary)) throw failure()
        facts.set(index, fact)
      }
      if (closed !== undefined) {
        if (!fact || Object.keys(closed).join() !== 'version' || typeof closed.version !== 'string' || !/^-?[0-9]+(?::-?[0-9]+){8}$/.test(closed.version)) throw failure()
        done.set(index, closed)
      }
    }
    if (fs.readdirSync(journal).some(name => !allowed.has(name))) throw failure()
    const existingComplete = readJson(path.join(journal, 'complete.json'), 32 * 1024 * 1024)
    if (existingComplete !== undefined) {
      const expected = { schema_version: 1, plan_sha256: planHash, receipts: [...done].map(([index, receipt]) => ({ index, closed_sha256: sha256CanonicalJson(receipt) })) }
      if (done.size !== plan.ledgers.filter(item => item.before_sha256 !== item.after_sha256).length
        || sha256CanonicalJson(existingComplete) !== sha256CanonicalJson(expected)) throw failure()
    }
    const checkNames = () => {
      checkJournal()
      const expected = [...plan.names]
      for (const fact of facts.values()) {
        try { fs.lstatSync(path.join(directory, fact.temporary)); expected.push(fact.temporary) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
      if (new Set(expected).size !== expected.length || JSON.stringify(fs.readdirSync(directory).sort()) !== JSON.stringify(expected.sort())) throw failure()
    }
    checkNames()
    const receipts: Array<{ index: number; closed_sha256: string }> = []
    let changed = false
    for (const [index, item] of plan.ledgers.entries()) {
      await verify(); checkNames()
      const target = path.join(directory, item.name), output = byManager.get(item.manager_key)!
      const current = currentFiles.get(item.name)!
      if (item.before_sha256 === item.after_sha256) {
        if (version(owned(target)) !== item.before_version || digest(fs.readFileSync(target)) !== item.before_sha256) throw failure()
        continue
      }
      let fact = facts.get(index)
      const completed = done.get(index)
      if (completed) {
        if (!fact || version(owned(target)) !== completed.version || !sameIdentity(completed.version, fact.version)
          || digest(fs.readFileSync(target)) !== item.after_sha256) throw failure()
        try { fs.lstatSync(path.join(directory, fact.temporary)); throw failure() } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        receipts.push({ index, closed_sha256: sha256CanonicalJson(completed) }); continue
      }
      const alreadyReplaced = digest(current.contents) === item.after_sha256
      if (!fact) {
        if (alreadyReplaced || version(owned(target)) !== item.before_version) throw failure()
        const temporary = '.tmp-' + randomUUID() + '.json', temp = path.join(directory, temporary)
        if (process.platform === 'win32') native.writePrivateFile(temp, '')
        else fs.writeFileSync(temp, '', { flag: 'wx', mode: 0o600 })
        fact = { temporary, version: version(owned(temp, false, true)) }
        publish(journal, index + '.prepared.json', fact, checkJournal)
        facts.set(index, fact)
      }
      if (!alreadyReplaced) {
        const temp = path.join(directory, fact.temporary), before = owned(temp, false, true)
        if (!sameIdentity(version(before), fact.version)) throw failure()
        const fd = fs.openSync(temp, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0))
        try {
          if (version(fs.fstatSync(fd, { bigint: true })) !== version(before)) throw failure()
          fs.writeFileSync(fd, output.contents); fs.ftruncateSync(fd, Buffer.byteLength(output.contents)); fs.fsyncSync(fd)
          if (!sameIdentity(version(fs.fstatSync(fd, { bigint: true })), fact.version)
            || version(owned(temp, false, true)) !== version(fs.fstatSync(fd, { bigint: true }))) throw failure()
        } finally { fs.closeSync(fd) }
        await verify(); checkNames()
        if (version(owned(target)) !== item.before_version || digest(fs.readFileSync(target)) !== item.before_sha256
          || !sameIdentity(version(owned(temp, false, true)), fact.version) || digest(fs.readFileSync(temp)) !== item.after_sha256) throw failure()
        fs.renameSync(temp, target)
        syncDirectory(directory)
      }
      const after = owned(target, false, true)
      if (!sameIdentity(version(after), fact.version)) throw failure()
      const fd = fs.openSync(target, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0))
      try {
        fs.fsyncSync(fd)
        if (version(fs.fstatSync(fd, { bigint: true })) !== version(after) || digest(fs.readFileSync(fd)) !== item.after_sha256
          || version(owned(target, false, true)) !== version(after)) throw failure()
      } finally { fs.closeSync(fd) }
      await verify(); checkNames()
      if (version(owned(target, false, true)) !== version(after)) throw failure()
      const receipt = { version: version(after) }
      publish(journal, index + '.closed.json', receipt, checkNames)
      done.set(index, receipt); receipts.push({ index, closed_sha256: sha256CanonicalJson(receipt) }); changed = true
    }
    await verify(); checkNames()
    if (JSON.stringify(fs.readdirSync(directory).sort()) !== JSON.stringify(plan.names)) throw failure()
    for (const [index, item] of plan.ledgers.entries()) {
      const target = path.join(directory, item.name), expected = done.get(index)?.version ?? item.before_version
      if (version(owned(target)) !== expected || digest(fs.readFileSync(target)) !== item.after_sha256) throw failure()
    }
    await verify(); checkNames()
    for (const [index, item] of plan.ledgers.entries()) {
      if (version(owned(path.join(directory, item.name))) !== (done.get(index)?.version ?? item.before_version)) throw failure()
    }
    const complete = { schema_version: 1, plan_sha256: planHash, receipts }, previous = readJson(path.join(journal, 'complete.json'), 32 * 1024 * 1024)
    if (previous !== undefined) { if (sha256CanonicalJson(previous) !== sha256CanonicalJson(complete)) throw failure() }
    else { publish(journal, 'complete.json', complete, checkNames, 32 * 1024 * 1024); changed = true }
    checkNames()
    if (sha256CanonicalJson(readJson(path.join(journal, 'complete.json'), 32 * 1024 * 1024)) !== sha256CanonicalJson(complete)) throw failure()
    return { dispatch: changed ? 'dispatch' as const : 'observe' as const, closed_ledgers: receipts.length, commit_sha256: sha256CanonicalJson(complete) }
  } finally { for (const pin of pins.reverse()) native.releaseDirectoryPin(pin) }
}
