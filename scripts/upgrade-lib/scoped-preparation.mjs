// Read-only declaration preflight for shared switching. This is not a stopped
// snapshot, file permission proof, backup receipt, or permission to run scripts.
import fs from 'node:fs/promises'
import path from 'node:path'
import { previewMigrations } from './migrate.mjs'
import { describeMigration } from './migration-transaction.mjs'
import { ledgerValue } from './shared-requests-v1.mjs'

const canonical = name => process.platform === 'win32' ? path.normalize(name).toLowerCase() : path.normalize(name)
const overlaps = (a, b) => {
  a = canonical(a); b = canonical(b)
  return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)
}
const conflict = () => { throw Object.assign(new Error('Shared preparation has interdependent migration scopes'), { code: 'CRABOT_SCOPED_PREPARATION_UNSUPPORTED' }) }
export async function describeScopedPreparation(home, dataRoot) {
  const preview = await previewMigrations(home, dataRoot)
  if (preview.shared.status === 'legacy_pending') throw Object.assign(new Error('Legacy request recovery requires its original preparation path'), { code: 'CRABOT_SCOPED_PREPARATION_UNSUPPORTED' })
  const modules = []
  for (const target of preview.modules) modules.push(await describeMigration(path.join(home, target.moduleId), target.dataDir, target.dataVersion, target.codeVersion))
  const shared_writes = []
  if (preview.shared.status === 'pending') {
    shared_writes.push(path.join('agent', 'shared-request-upgrade.json'))
    const prefix = path.join('agent', 'worker-ledgers') + path.sep
    for (const entry of preview.shared.entries) {
      if (entry.type === 'file' && entry.name.startsWith(prefix)
        && !ledgerValue(await fs.readFile(path.join(dataRoot, entry.name)), entry.name).wrapped) shared_writes.push(entry.name)
    }
  }
  for (let index = 0; index < modules.length; index++) {
    const scope = modules[index].scope
    if (shared_writes.some(name => [...scope.reads, ...scope.writes].some(other => overlaps(name, other)))) conflict()
    for (const other of modules.slice(index + 1).map(module => module.scope)) {
      if (scope.writes.some(name => [...other.reads, ...other.writes].some(value => overlaps(name, value)))
        || other.writes.some(name => scope.reads.some(value => overlaps(name, value)))) conflict()
    }
  }
  return { modules, shared: preview.shared, shared_writes, backup_bytes: preview.backup_bytes }
}
