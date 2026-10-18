import fs from 'node:fs/promises'
import path from 'node:path'
import { scopedPath } from '../../scripts/upgrade-lib/scoped-data.mjs'

async function children(root, name) {
  await scopedPath(root, name + '/.scope-probe')
  try { return await fs.readdir(path.join(root, name), { withFileTypes: true }) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
}
async function markdown(root, directory) {
  const result = []
  for (const entry of await children(root, directory)) {
    const name = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error('Memory migration cannot follow symlinks')
    if (entry.isDirectory()) result.push(...await markdown(root, name))
    else if (entry.isFile() && entry.name.endsWith('.md')) result.push(name)
  }
  return result
}
const database = name => [name, `${name}-wal`, `${name}-shm`, `${name}-journal`]

/** Complete write scope for the supported version chain, including cross-module cleanup. */
export async function migrationScope({ dataRoot, from, to, transactionId }) {
  if (!Number.isInteger(from) || from < 0 || to > 5 || to <= from) throw new Error('Unsupported Memory migration range')
  const reads = [], writes = [], retired = `memory/lancedb.deprecated.${transactionId}`
  for (let n = from; n < to; n++) {
    if (n === 1) writes.push('memory/lancedb', 'memory/long_term', ...database('memory/long_term_v2.db'))
    if (n === 2) {
      const lancedb = await fs.lstat(path.join(dataRoot, 'memory/lancedb')).catch(error => { if (error.code === 'ENOENT') return null; throw error })
      if (lancedb) {
        if (await fs.lstat(path.join(dataRoot, retired)).then(() => true, () => false)) throw new Error('Declared retired LanceDB target already exists')
        writes.push('memory/lancedb', retired)
      }
      writes.push(...database('memory/long_term_v2.db'), 'memory/upgrade-v2-to-v3.log', 'admin/global-config.json')
      for (const entry of await children(dataRoot, 'admin/module-configs')) {
        if (entry.name.startsWith('memory-') && entry.name.endsWith('.json')) writes.push(path.join('admin/module-configs', entry.name))
      }
    }
    if (n === 3) writes.push(...database('memory/short_term.db'), 'memory/upgrade-v3-to-v4.log')
    if (n === 4) {
      reads.push('memory/short_term.db', 'memory/short_term.db-wal', 'memory/short_term.db-journal')
      // SQLite's read-only WAL reader may update read marks in an existing SHM file.
      writes.push('memory/short_term.db-shm')
      writes.push(...await markdown(dataRoot, 'memory/long_term'), ...database('memory/long_term_v2.db'))
    }
  }
  return { reads, writes, environment: { CRABOT_MIGRATION_RETIRED_LANCEDB: retired } }
}
