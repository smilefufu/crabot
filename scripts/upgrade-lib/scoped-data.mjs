import fs from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import { createHash, randomUUID } from 'node:crypto'

export const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export async function optional(filename) {
  try { return await fs.readFile(filename) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
export async function writeAtomic(filename, bytes, mode = 0o600) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
  const temporary = `${filename}.${randomUUID()}.tmp`
  try {
    const file = await fs.open(temporary, 'wx', mode)
    try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
    await fs.rename(temporary, filename)
  } finally { await fs.rm(temporary, { force: true }) }
}

/** Resolve only declared DATA_DIR-relative paths; never follow an authority symlink. */
export async function scopedPath(root, name) {
  if (typeof name !== 'string' || !name || path.isAbsolute(name) || name.split(/[\\/]/).some(p => !p || p === '.' || p === '..')) throw new Error('Invalid migration path')
  const parts = name.split(/[\\/]/)
  if (parts.length < 2) throw new Error('Migration scope must not contain a whole module')
  let current = path.resolve(root)
  for (const part of parts) {
    current = path.join(current, part)
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Authority data symlink cannot be verified')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return current
}

export async function fileDigest(filename) {
  const file = await fs.open(filename, 'r')
  try {
    const before = await file.stat(), digest = createHash('sha256')
    for await (const chunk of file.createReadStream({ autoClose: false })) digest.update(chunk)
    const after = await file.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error('Data changed while hashing migration input')
    return digest.digest('hex')
  } finally { await file.close() }
}

export async function snapshot(root, names) {
  const entries = new Map()
  async function visit(name) {
    if (entries.has(name)) return
    const filename = await scopedPath(root, name)
    let stat
    try { stat = await fs.lstat(filename) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      entries.set(name, { name, type: 'absent' }); return
    }
    if (stat.isDirectory()) {
      entries.set(name, { name, type: 'directory', mode: stat.mode & 0o777 })
      for (const child of (await fs.readdir(filename)).sort()) await visit(path.join(name, child))
    } else if (stat.isFile()) {
      entries.set(name, { name, type: 'file', size: stat.size, mode: stat.mode & 0o777, mtime_ms: stat.mtimeMs, sha256: await fileDigest(filename) })
    } else throw new Error('Unsupported migration entry')
  }
  for (const name of [...new Set(names.map(name => name.split(/[\\/]/).join(path.sep)))].sort()) await visit(name)
  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name))
}
export const sameSnapshot = (a, b) => JSON.stringify(a.map(({ mtime_ms, ...entry }) => entry)) === JSON.stringify(b.map(({ mtime_ms, ...entry }) => entry))
export const backupBytes = entries => entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0)

export async function copySnapshot(source, destination, entries) {
  for (const entry of entries) {
    const target = await scopedPath(destination, entry.name)
    if (entry.type === 'directory') {
      await fs.mkdir(target, { recursive: true, mode: entry.mode })
      await fs.chmod(target, entry.mode)
    }
    else if (entry.type === 'file') {
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
      await fs.copyFile(await scopedPath(source, entry.name), target)
      await fs.chmod(target, entry.mode)
      await fs.utimes(target, entry.mtime_ms / 1000, entry.mtime_ms / 1000)
    }
  }
}
export async function createBackup(root, backup, names) {
  const before = await snapshot(root, names)
  await fs.mkdir(backup, { recursive: true, mode: 0o700 })
  await copySnapshot(root, backup, before)
  if (!sameSnapshot(before, await snapshot(backup, names)) || !sameSnapshot(before, await snapshot(root, names))) throw new Error('Migration backup verification failed')
  return before
}
export async function verifyBackup(backup, names, original) {
  if (!sameSnapshot(original, await snapshot(backup, names))) throw new Error('Migration backup verification failed')
}
export async function restoreBackup(root, backup, names, original) {
  await verifyBackup(backup, names, original)
  // Only declared roots may be removed. In particular this never replaces DATA_DIR or a module.
  const roots = [...new Set(names)].filter(name => !names.some(other => other !== name && name.startsWith(other + path.sep)))
  for (const name of roots) await fs.rm(await scopedPath(root, name), { recursive: true, force: true })
  await copySnapshot(backup, root, original)
  if (!sameSnapshot(original, await snapshot(root, names))) throw new Error('Migration rollback verification failed; startup blocked')
}

export async function assertStopped(dataRoot) {
  const stat = await fs.stat(dataRoot).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (stat && process.getuid && process.getuid() !== 0 && stat.uid !== process.getuid()) throw new Error('Migration instance directory belongs to another user')
  for (const name of ['mm.pid', 'agent/agent.pid', 'admin/admin.pid', 'memory/memory.pid']) {
    const bytes = await optional(path.join(dataRoot, name))
    if (!bytes) continue
    const pid = Number(bytes.toString().trim())
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid runtime PID; cannot prepare migration')
    try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') continue; throw error }
    throw new Error('Stop Crabot before preparing request upgrade or data migration')
  }
  const records = path.join(dataRoot, 'module-runtime-registry/records')
  const names = await fs.readdir(records).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  for (const name of names.filter(name => name.endsWith('.json'))) {
    const record = JSON.parse(await fs.readFile(path.join(records, name), 'utf8'))
    if (record.schema_version !== 1 || !Number.isSafeInteger(record.root_pid) || record.root_pid < 1 || !Number.isSafeInteger(record.module_port) || record.module_port < 1 || record.module_port > 65535) throw new Error('Invalid module runtime record; cannot prove migration is offline')
    let alive = true
    try { process.kill(record.root_pid, 0) } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error }
    if (alive || await listenerPresent(record.module_port)) throw new Error('Stop Crabot before preparing request upgrade or data migration; a recorded module is still running')
  }

}

async function listenerPresent(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    socket.setTimeout(250)
    const finish = result => { socket.destroy(); resolve(result) }
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => { socket.destroy(); reject(new Error('Cannot verify recorded module listener is stopped')) })
    socket.once('error', error => error.code === 'ECONNREFUSED' ? finish(false) : (socket.destroy(), reject(error)))
  })
}
