import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { prepareSharedRequests as prepareV1, ledgerValue, wrappedLedgerBytes, validateBindings, validateRequestVersions } from './shared-requests-v1.mjs'
import { hash, optional, writeAtomic, scopedPath, snapshot, sameSnapshot, createBackup, verifyBackup, assertStopped, backupBytes } from './scoped-data.mjs'
import { acquireCliLock, releaseCliLock } from '../lib/cli-lock.mjs'

const TX = 'shared-request-upgrade-v2', READY = 'agent/shared-request-upgrade.json'
const CONFIG = ['admin/templates.json', 'admin/friends.json', 'admin/friend-permission-configs.json', 'admin/session-configs.json', 'agent/manager-principal-bindings.json']
async function children(root, name) {
  await scopedPath(root, name + '/.scope-probe')
  try { return (await fs.readdir(path.join(root, name), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
}
/** Enumerate only dedicated identity/version records; do not walk Agent or its histories. */
async function inputs(root) {
  const names = [...CONFIG]
  for (const entry of await children(root, 'agent/worker-ledgers')) {
    if (entry.name.endsWith('.json') && !entry.name.startsWith('.tmp-')) names.push(path.join('agent/worker-ledgers', entry.name))
  }
  for (const [collection, files] of [['managers', ['requests.json', 'request-sources.json']], ['workers', ['context.json']]]) {
    for (const entry of await children(root, `agent/${collection}`)) {
      if (entry.isSymbolicLink()) throw new Error('Authority data symlink cannot be verified')
      if (entry.isDirectory()) for (const file of files) names.push(path.join('agent', collection, entry.name, file))
    }
  }
  for (const entry of await children(root, 'agent/conversation-requests')) {
    if (entry.isSymbolicLink()) throw new Error('Authority data symlink cannot be verified')
    if (!entry.isDirectory()) continue
    const directory = path.join('agent/conversation-requests', entry.name)
    for (const name of ['owner.json', 'admission.json', 'event.json', 'delivery-pending.json']) names.push(path.join(directory, name))
    for (const event of await children(root, path.join(directory, 'events'))) {
      if (event.isSymbolicLink()) throw new Error('Authority data symlink cannot be verified')
      if (event.isDirectory()) names.push(path.join(directory, 'events', event.name, 'event.json'))
    }
    for (const receipt of await children(root, path.join(directory, 'deliveries'))) {
      if (receipt.name.endsWith('.json')) names.push(path.join(directory, 'deliveries', receipt.name))
    }
  }
  return names.sort()
}
/** Invoke only production metadata readers; never run admission, replay or delivery. */
async function validateRuntimeMetadata(home, root, entries, requests) {
  if (!entries.some(entry => entry.name.startsWith(`conversation-requests${path.sep}`))) return
  const load = name => import(pathToFileURL(path.join(home, 'crabot-agent/dist/manager', name)).href)
  const reader = await load('request-runtime-metadata.js')
  for (const entry of entries) {
    const parts = entry.name.split(path.sep)
    if (parts[0] !== 'conversation-requests') continue
    const request = requests.get(parts[1]), filename = path.join(root, 'agent', entry.name)
    if (!request) throw new Error('Missing original request for runtime metadata')
    const name = parts.at(-1)
    if (name === 'owner.json') {
      const owner = JSON.parse(await fs.readFile(filename, 'utf8'))
      if (owner.schema_version !== 1 || owner.request_id !== request.request_id || owner.manager_key !== request.manager_key || owner.source_sha256 !== request.source_sha256) throw new Error('Invalid request owner')
    } else if (name === 'admission.json') await reader.readRequestAdmission(filename, request)
    else if (name === 'event.json') await reader.readRequestEvent(filename, request, parts.at(-2))
    else {
      const directory = path.join(root, 'agent/conversation-requests', parts[1])
      const value = await reader.readRequestDeliveryFile(filename)
      if (name === 'delivery-pending.json') reader.parseRequestDeliveryAttempt(value, request)
      else {
        const { receipt, ...attempt } = value
        reader.parseRequestDeliveryAttempt(attempt, request)
        if (parts.at(-1) !== `${attempt.operation_id}.json` || !await reader.readRequestDeliveryConfirmation(directory, request, attempt)) throw new Error('Invalid delivery receipt')
      }
    }
  }
}
async function verify(root, transaction, plan, completed = false) {
  if (plan.schema_version !== 2 || !Array.isArray(plan.files) || !Array.isArray(plan.inputs) || !Array.isArray(plan.write_scope)) throw new Error('Unsupported request upgrade plan')
  await verifyBackup(path.join(transaction, 'backup'), plan.write_scope, plan.backup_manifest)
  if (hash(await fs.readFile(path.join(transaction, 'impact.json'))) !== plan.impact_sha256) throw new Error('Impact report verification failed')
  if (await optional(path.join(root, READY))) throw new Error('Data changed: request completion marker appeared during migration')
  const current = await snapshot(root, await inputs(root))
  const conversions = new Map(plan.files.map(file => [file.name, file]))
  const unchanged = current.map(entry => {
    const file = conversions.get(entry.name)
    if (!file) return entry
    if (entry.type !== 'file' || !(completed ? [file.target_sha256] : [file.original_sha256, file.target_sha256]).includes(entry.sha256)) throw new Error('Migration data hash mismatch')
    return plan.inputs.find(original => original.name === entry.name)
  })
  if (!sameSnapshot(plan.inputs, unchanged)) throw new Error('Data changed since request backup')
  for (const file of plan.files) {
    if (path.dirname(file.name) !== path.join('agent', 'worker-ledgers') || !file.name.endsWith('.json')) throw new Error('Invalid migration target')
    const original = await fs.readFile(await scopedPath(path.join(transaction, 'backup'), file.name))
    if (hash(original) !== file.original_sha256 || hash(wrappedLedgerBytes(original, file.name)) !== file.target_sha256) throw new Error('Invalid migration hashes')
  }
}

export async function previewSharedRequests(crabotHome, dataRoot) {
  const code = await optional(path.join(crabotHome, 'crabot-agent/shared_request_version'))
  if (!code) return { status: 'not_applicable', files: 0, backup_bytes: 0 }
  if (code.toString().trim() !== '1') throw new Error('Unsupported request code version')
  const ready = await optional(path.join(dataRoot, READY))
  if (ready) {
    const value = JSON.parse(ready)
    if (!((value.schema_version === 1 && value.transaction === 'shared-request-upgrade-v1') || (value.schema_version === 2 && value.transaction === TX)) || value.status !== 'ready') throw new Error('Unsupported request upgrade marker')
    const transaction = path.join(dataRoot, value.transaction)
    const bytes = await fs.readFile(path.join(transaction, 'plan.json'))
    if (hash(bytes) !== value.plan_sha256) throw new Error('Request upgrade plan changed')
    if (hash(await fs.readFile(path.join(transaction, 'impact.json'))) !== JSON.parse(bytes).impact_sha256) throw new Error('Impact report changed')
    return { status: 'ready', files: 0, backup_bytes: 0, report: path.join(transaction, 'impact.json') }
  }
  const legacy = await fs.lstat(path.join(dataRoot, 'shared-request-upgrade-v1')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
  if (legacy) return { status: 'legacy_pending', files: null, backup_bytes: null }
  const entries = await snapshot(dataRoot, await inputs(dataRoot)), files = []
  for (const entry of entries) if (entry.name.startsWith(`agent${path.sep}worker-ledgers${path.sep}`) && entry.type === 'file') {
    if (!ledgerValue(await fs.readFile(path.join(dataRoot, entry.name)), entry.name).wrapped) files.push(entry)
  }
  return { status: 'pending', files: files.length, backup_bytes: backupBytes(files), entries }
}

/** Offline data preparation only. All startup/upgrade callers share the instance operation lock. */
export async function prepareSharedRequests(crabotHome, dataRoot, logger = console, options = {}) {
  const preview = await previewSharedRequests(crabotHome, dataRoot)
  if (['ready', 'not_applicable'].includes(preview.status)) return preview
  let release
  if (!options.lockHeld) {
    await fs.mkdir(dataRoot, { recursive: true })
    release = await acquireCliLock(dataRoot, 'data-migration')
  }
  try {
    await assertStopped(dataRoot)
    if (preview.status === 'legacy_pending') return await prepareV1(crabotHome, dataRoot, logger, options)
    const transaction = path.join(dataRoot, TX), planFile = path.join(transaction, 'plan.json')
    let bytes = await optional(planFile)
    if (!bytes) {
      const backup = path.join(transaction, 'backup')
      try { await fs.mkdir(backup, { recursive: false, mode: 0o700 }) }
      catch (error) {
        if (error.code === 'EEXIST') throw new Error('Incomplete request backup; preserve and inspect before retry')
        if (error.code !== 'ENOENT') throw error
        await fs.mkdir(transaction, { recursive: true, mode: 0o700 }); await fs.mkdir(backup, { mode: 0o700 })
      }
      const entries = await snapshot(dataRoot, await inputs(dataRoot))
      const agentEntries = entries.filter(e => e.type === 'file' && e.name.startsWith(`agent${path.sep}`)).map(e => ({ ...e, name: e.name.slice(6) }))
      await validateRequestVersions(path.join(dataRoot, 'agent'), agentEntries)
      const requests = await validateBindings(crabotHome, dataRoot, agentEntries)
      await validateRuntimeMetadata(crabotHome, dataRoot, agentEntries, requests)
      const files = []
      for (const entry of entries) if (entry.type === 'file' && entry.name.startsWith(`agent${path.sep}worker-ledgers${path.sep}`)) {
        const original = await fs.readFile(path.join(dataRoot, entry.name))
        if (!ledgerValue(original, entry.name).wrapped) files.push({ name: entry.name, original_sha256: hash(original), target_sha256: hash(wrappedLedgerBytes(original, entry.name)) })
      }
      const writeScope = [...files.map(file => file.name), READY]
      const before = await snapshot(dataRoot, writeScope)
      const space = await fs.statfs(dataRoot)
      if (Number(space.bavail) * Number(space.bsize) < backupBytes(before) * 3) throw new Error('Insufficient space for scoped request migration')
      const original = await createBackup(dataRoot, backup, writeScope)
      const { buildSharedRequestImpact } = await import(pathToFileURL(path.join(crabotHome, 'crabot-admin/dist/shared-request-impact.js')).href)
      const impact = Buffer.from(JSON.stringify(await buildSharedRequestImpact(dataRoot), null, 2))
      await writeAtomic(path.join(transaction, 'impact.json'), impact)
      bytes = Buffer.from(JSON.stringify({ schema_version: 2, inputs: entries, write_scope: writeScope, backup_manifest: original, files, impact_sha256: hash(impact) }, null, 2))
      await writeAtomic(planFile, bytes)
    }
    const plan = JSON.parse(bytes)
    await verify(dataRoot, transaction, plan)
    try {
      for (const file of plan.files) {
        const original = await fs.readFile(path.join(transaction, 'backup', file.name))
        const mode = plan.backup_manifest.find(entry => entry.name === file.name).mode
        await writeAtomic(path.join(dataRoot, file.name), wrappedLedgerBytes(original, file.name), mode)
        await options.afterConvert?.(file.name)
      }
      await verify(dataRoot, transaction, plan, true)
      await writeAtomic(path.join(dataRoot, READY), JSON.stringify({ schema_version: 2, status: 'ready', transaction: TX, plan_sha256: hash(bytes), completed_at: new Date().toISOString() }))
    } catch (error) {
      await verifyBackup(path.join(transaction, 'backup'), plan.write_scope, plan.backup_manifest)
      for (const file of plan.files) {
        const current = await fs.readFile(path.join(dataRoot, file.name))
        if (hash(current) === file.target_sha256) {
          const metadata = plan.backup_manifest.find(entry => entry.name === file.name)
          await fs.copyFile(path.join(transaction, 'backup', file.name), path.join(dataRoot, file.name))
          await fs.chmod(path.join(dataRoot, file.name), metadata.mode)
          await fs.utimes(path.join(dataRoot, file.name), metadata.mtime_ms / 1000, metadata.mtime_ms / 1000)
        } else if (hash(current) !== file.original_sha256) throw new Error('Migration rollback cannot verify original data; startup blocked', { cause: error })
      }
      throw error
    }
    logger.info(`[shared-requests] ${plan.files.length} ledgers; verified backup ${backupBytes(plan.backup_manifest)} bytes`)
    return { status: 'prepared', report: path.join(transaction, 'impact.json'), backup_bytes: backupBytes(plan.backup_manifest) }
  } finally { releaseCliLock(release) }
}
