import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { fileDigest, optional, hash, writeAtomic, snapshot, sameSnapshot, createBackup, verifyBackup, restoreBackup, backupBytes, scopedPath, assertStopped } from './scoped-data.mjs'
import { acquireCliLock, releaseCliLock } from '../lib/cli-lock.mjs'

export function versionNumber(value) {
  if (value === null) return 0
  if (!/^v\d+$/.test(value)) throw new Error(`Invalid data version: ${value}`)
  return Number(value.slice(1))
}
export async function describeMigration(moduleDir, dataDir, fromVersion, toVersion) {
  const from = versionNumber(fromVersion), to = versionNumber(toVersion)
  fromVersion = from === 0 ? null : `v${from}`
  toVersion = `v${to}`
  if (to <= from) throw new Error('Migration must advance the data version')
  const moduleId = path.basename(moduleDir)
  if (!/^crabot-[a-z0-9-]+$/.test(moduleId) || path.basename(dataDir) !== moduleId.slice(7)) throw new Error('Migration module/data ownership mismatch')
  const dataRoot = path.dirname(path.resolve(dataDir)), id = `${moduleId}-v${from}-v${to}`
  const scopeFile = path.join(moduleDir, 'upgrade/scope.mjs')
  if (!await optional(scopeFile)) throw new Error(`Missing migration scope adapter: ${moduleId}`)
  const adapterSha256 = await fileDigest(scopeFile)
  const { migrationScope } = await import(`${pathToFileURL(scopeFile).href}?sha256=${adapterSha256}`)
  const directory = path.join(dataRoot, '.upgrade-migrations', id)
  const existing = await optional(path.join(directory, 'plan.json'))
  const saved = existing ? JSON.parse(existing).description : null
  const state = existing ? JSON.parse(await fs.readFile(path.join(directory, 'state.json'), 'utf8')) : null
  const scope = saved && state.phase !== 'rolled_back' ? saved.scope : await migrationScope({ dataRoot, from, to, transactionId: id })
  if (!scope || !Array.isArray(scope.reads) || !Array.isArray(scope.writes)) throw new Error('Invalid migration scope adapter')
  scope.writes = [...new Set([...scope.writes.map(name => name.split(/[\\/]/).join(path.sep)), path.join(moduleId.slice(7), 'SCHEMA_VERSION')])].sort()
  scope.reads = [...new Set(scope.reads.map(name => name.split(/[\\/]/).join(path.sep)))].filter(name => !scope.writes.includes(name)).sort()
  for (const name of [...scope.reads, ...scope.writes]) await scopedPath(dataRoot, name)
  const scripts = []
  const entries = await fs.readdir(path.join(moduleDir, 'upgrade'))
  for (let n = from; n < to; n++) {
    const matches = entries.filter(name => new RegExp(`^from_v${n}_to_v${n + 1}\\.(py|mjs|js|ts)$`).test(name))
    if (matches.length !== 1) throw new Error(`missing or ambiguous upgrade script: from v${n} to v${n + 1}`)
    const script = path.join(moduleDir, 'upgrade', matches[0])
    scripts.push({ path: script, sha256: await fileDigest(script) })
  }
  const description = { schema_version: 1, id, module_id: moduleId, data_root: dataRoot, from: fromVersion, to: toVersion, scope, scripts, adapter_sha256: adapterSha256 }
  if (saved && (state.phase === 'rolled_back' || JSON.stringify(saved) !== JSON.stringify(description))) await verifyRolledBack(existing, state, description)
  return description
}

/** Only a proven rollback can release its original code binding; never mutate during preview. */
async function verifyRolledBack(bytes, state, description) {
  const plan = JSON.parse(bytes), saved = plan.description
  if (state.schema_version !== 1 || state.plan_sha256 !== hash(bytes) || state.phase !== 'rolled_back'
    || ['schema_version', 'id', 'module_id', 'data_root', 'from', 'to'].some(key => saved[key] !== description[key])) {
    throw new Error('Migration code or instance changed; preserve original recovery scope')
  }
  const backup = path.join(description.data_root, '.upgrade-migrations', description.id, 'backup')
  await verifyBackup(backup, saved.scope.writes, plan.original)
  if (!sameSnapshot(plan.original, await snapshot(description.data_root, saved.scope.writes))
    || !sameSnapshot(plan.inputs, await snapshot(description.data_root, saved.scope.reads))) throw new Error('Migration inputs changed; recovery review required')
}

export async function assertNoInterruptedMigrations(dataRoot) {
  const directory = path.join(dataRoot, '.upgrade-migrations')
  let entries
  try { entries = await fs.readdir(directory) } catch (error) { if (error.code === 'ENOENT') return; throw error }
  for (const name of entries) {
    const bytes = await optional(path.join(directory, name, 'state.json'))
    if (!bytes) throw new Error('Incomplete migration backup; preserve evidence before retry')
    const state = JSON.parse(bytes)
    if (state.schema_version !== 1 || !/^[a-f0-9]{64}$/.test(state.plan_sha256) || !['prepared', 'rolled_back', 'converted', 'completed'].includes(state.phase)) throw new Error('Interrupted migration requires scoped recovery; startup blocked')
  }
}

/** A version chain owns one verified backup. No product preparation or business execution here. */
export async function executeMigration(description, runScript, options = {}) {
  const { data_root: root, id, scope } = description
  let lock
  if (!options.lockHeld) { await fs.mkdir(root, { recursive: true }); lock = await acquireCliLock(root, 'data-migration') }
  try {
    await assertStopped(root)
    const directory = path.join(root, '.upgrade-migrations', id), planFile = path.join(directory, 'plan.json'), stateFile = path.join(directory, 'state.json'), backup = path.join(directory, 'backup')
    let bytes = await optional(planFile), state
    if (bytes) {
      state = JSON.parse(await fs.readFile(stateFile, 'utf8'))
      if (state.schema_version !== 1 || state.plan_sha256 !== hash(bytes)) throw new Error('Migration plan verification failed')
      const plan = JSON.parse(bytes)
      if (JSON.stringify(plan.description) !== JSON.stringify(description)) {
        await verifyRolledBack(bytes, state, description)
        const history = path.join(root, '.upgrade-migrations-history')
        await fs.mkdir(history, { recursive: true, mode: 0o700 })
        await fs.rename(directory, path.join(history, `${id}-${randomUUID()}`))
        bytes = null
      }
    }
    if (bytes) {
      const plan = JSON.parse(bytes)
      if (state.phase === 'completed') {
        const version = await optional(path.join(root, description.module_id.slice(7), 'SCHEMA_VERSION'))
        if (version?.toString().trim() !== description.to) throw new Error('Completed migration version changed; startup blocked')
        return { ok: true, backupPath: backup }
      }
      if (!['prepared', 'rolled_back', 'converted'].includes(state.phase)) throw new Error('Interrupted migration requires scoped recovery; startup blocked')
      await verifyBackup(backup, scope.writes, plan.original)
      if (state.phase === 'converted') {
        const schemaName = path.join(description.module_id.slice(7), 'SCHEMA_VERSION')
        const currentSchema = await snapshot(root, [schemaName])
        const originalSchema = plan.original.filter(entry => entry.name === schemaName)
        if (!sameSnapshot(currentSchema, originalSchema) && currentSchema[0]?.sha256 !== hash(`${description.to}\n`)) throw new Error('Converted migration version changed; startup blocked')
        const names = scope.writes.filter(name => !name.endsWith(`${path.sep}SCHEMA_VERSION`))
        if (!sameSnapshot(state.converted_manifest, await snapshot(root, names)) || !sameSnapshot(plan.inputs, await snapshot(root, scope.reads))) throw new Error('Converted migration data changed; startup blocked')
        for (const script of description.scripts) if (await fileDigest(script.path) !== script.sha256) throw new Error('Migration script changed')
        if (options.advanceVersion !== false) {
          await writeAtomic(path.join(root, description.module_id.slice(7), 'SCHEMA_VERSION'), `${description.to}\n`)
          await writeAtomic(stateFile, JSON.stringify({ ...state, phase: 'completed' }))
        }
        return { ok: true, backupPath: backup, backup_bytes: backupBytes(plan.original) }
      }
      if (!sameSnapshot(plan.original, await snapshot(root, scope.writes)) || !sameSnapshot(plan.inputs, await snapshot(root, scope.reads))) throw new Error('Migration inputs changed; recovery review required')
    } else {
      try { await fs.mkdir(directory, { recursive: false, mode: 0o700 }) }
      catch (error) {
        if (error.code === 'EEXIST') throw new Error('Incomplete migration backup; preserve evidence before retry')
        if (error.code !== 'ENOENT') throw error
        await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 }); await fs.mkdir(directory, { mode: 0o700 })
      }
      const before = await snapshot(root, scope.writes), inputs = await snapshot(root, scope.reads)
      const space = await fs.statfs(root)
      if (Number(space.bavail) * Number(space.bsize) < backupBytes(before) * 3) throw new Error('Insufficient space for scoped migration backup and conversion')
      const original = await createBackup(root, backup, scope.writes)
      if (!sameSnapshot(before, original) || !sameSnapshot(inputs, await snapshot(root, scope.reads))) throw new Error('Migration input changed during backup')
      bytes = Buffer.from(JSON.stringify({ schema_version: 1, description, original, inputs }, null, 2))
      await writeAtomic(planFile, bytes)
    }
    const plan = JSON.parse(bytes), stateBase = { schema_version: 1, plan_sha256: hash(bytes) }
    await writeAtomic(stateFile, JSON.stringify({ ...stateBase, phase: 'running' }))
    let failedAt = 'validation'
    try {
      for (const script of description.scripts) {
        failedAt = path.basename(script.path)
        if (await fileDigest(script.path) !== script.sha256) throw new Error('Migration script changed')
        const result = await runScript(script.path, path.join(root, description.module_id.slice(7)), {
          plan: planFile, planSha256: hash(bytes), environment: scope.environment ?? {},
        })
        if (result.exitCode !== 0) throw new Error(`Migration failed at ${failedAt}`)
      }
      if (!sameSnapshot(plan.inputs, await snapshot(root, scope.reads))) throw new Error('Read-only migration input changed')
      // Record the complete converted scope before committing the final version.
      const converted = { ...stateBase, phase: 'converted', converted_manifest: await snapshot(root, scope.writes.filter(name => !name.endsWith(`${path.sep}SCHEMA_VERSION`))) }
      await writeAtomic(stateFile, JSON.stringify(converted))
      if (options.advanceVersion === false) return { ok: true, backupPath: backup, backup_bytes: backupBytes(plan.original) }
      await options.beforeVersionCommit?.()
      await writeAtomic(path.join(root, description.module_id.slice(7), 'SCHEMA_VERSION'), `${description.to}\n`)
      await writeAtomic(stateFile, JSON.stringify({ ...stateBase, phase: 'completed' }))
      return { ok: true, backupPath: backup, backup_bytes: backupBytes(plan.original) }
    } catch (error) {
      await restoreBackup(root, backup, scope.writes, plan.original)
      await writeAtomic(stateFile, JSON.stringify({ ...stateBase, phase: 'rolled_back' }))
      if (options.throwOnFailure) throw error
      return { ok: false, failedAt, backupPath: backup }
    }
  } finally { releaseCliLock(lock) }
}

/** Finish only a proven conversion; standalone scripts retain their original marker ownership. */
export async function commitConvertedMigrations(home, root, runScript) {
  let committed = false
  const directory = path.join(root, '.upgrade-migrations')
  const names = await fs.readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  for (const name of names) {
    const state = JSON.parse(await fs.readFile(path.join(directory, name, 'state.json'), 'utf8'))
    if (state.phase !== 'converted') continue
    const bytes = await fs.readFile(path.join(directory, name, 'plan.json'))
    if (state.plan_sha256 !== hash(bytes)) throw new Error('Migration plan verification failed')
    const { description } = JSON.parse(bytes)
    if (path.resolve(description.data_root) !== path.resolve(root)) throw new Error('Converted migration belongs to another instance')
    const expected = await describeMigration(path.join(home, description.module_id), path.join(root, description.module_id.slice(7)), description.from, description.to)
    if (JSON.stringify(expected) !== JSON.stringify(description)) throw new Error('Converted migration target changed; startup blocked')
    await executeMigration(description, runScript, { lockHeld: true })
    committed = true
  }
  return committed
}
