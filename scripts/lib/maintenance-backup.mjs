// Snapshot only after verified shutdown under the common OS lifecycle lock.
// Workspaces, working dependencies and UI/log caches stay in place; they are
// explicitly outside this data rollback. External references are never followed.
import { promises as fs, constants, createReadStream, createWriteStream, realpathSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import management from './desktop-management.cjs'
import identity from './process-identity.cjs'
import { cliLockToken } from './cli-lock.mjs'
import { inspectInstance } from './instance-runtime.mjs'

const excluded = new Set(['workspaces', 'agent-venv', 'agent-tools', 'runtime-bases', 'mcp-envs', 'runtime-cache', 'logs', 'desktop-profile',
  'cli.lock', 'mm.pid', 'instance-runtime.json', 'desktop-maintenance.json', '.DS_Store'])
const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
const cancelled = signal => { if (signal?.aborted) fail('CRABOT_MAINTENANCE_CANCELLED', '已取消维护，原数据保留。') }
async function hash(file) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(file)) digest.update(chunk)
  return digest.digest('hex')
}
async function entries(directory) { return (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) }
async function syncDirectory(directory) {
  if (process.platform === 'win32') return // Node cannot fsync Windows directory handles.
  const handle = await fs.open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

export async function createMaintenanceBackup(dataDir, { signal } = {}) {
  cancelled(signal)
  // Match the canonical path used by desktop management and instance records.
  // Windows async realpath can expand a short TEMP path differently.
  dataDir = realpathSync(dataDir)
  if (!cliLockToken(path.join(dataDir, 'cli.lock')) || inspectInstance(dataDir).state !== 'stopped') {
    fail('CRABOT_BACKUP_REQUIRES_STOP', '必须持有操作锁并确认实例停止后才能备份。')
  }
  const records = await fs.readdir(path.join(dataDir, 'module-runtime-registry/records')).catch(error => {
    if (error.code === 'ENOENT') return []; throw error
  })
  if (records.some(name => name.endsWith('.json'))) fail('CRABOT_STOP_UNKNOWN', '仍有未收口模块记录，未开始备份。')
  const files = Object.create(null), references = []
  const scope = (await entries(dataDir)).filter(entry => !excluded.has(entry.name)).map(entry => entry.name)
  async function inspect(directory, prefix = '') {
    for (const entry of await entries(directory)) {
      const relative = prefix ? prefix + '/' + entry.name : entry.name
      if (!prefix && !scope.includes(entry.name)) continue
      cancelled(signal)
      const file = path.join(dataDir, relative), stat = await fs.lstat(file)
      if (entry.isSymbolicLink()) references.push({ path: relative, target: await fs.readlink(file) })
      else if (entry.isDirectory()) { files[relative] = { type: 'directory', mode: stat.mode & 0o777 }; await inspect(file, relative) }
      else if (entry.isFile()) files[relative] = { type: 'file', size: stat.size, mode: stat.mode & 0o777 }
      else fail('CRABOT_BACKUP_UNSUPPORTED', '数据中存在无法安全备份的特殊文件，原数据保留。')
    }
  }
  await inspect(dataDir)
  const total = Object.values(files).reduce((sum, file) => sum + (file.size ?? 0), 0)
  const parent = management.ensurePrivateDataRoot(dataDir + '.desktop-backups')
  const space = await fs.statfs(parent, { bigint: true })
  if (space.bavail * space.bsize < BigInt(total) + 64n * 1024n * 1024n) fail('CRABOT_BACKUP_SPACE', '备份空间不足，原数据保留；请释放空间后重试。')
  const id = randomUUID(), pending = path.join(parent, '.preparing-' + id), destination = path.join(parent, id)
  management.ensurePrivateDataRoot(pending)
  try {
    const payload = management.ensurePrivateDataRoot(path.join(pending, 'data'))
    for (const [relative, record] of Object.entries(files)) {
      cancelled(signal)
      const target = path.join(payload, relative)
      if (record.type === 'directory') management.ensurePrivateDataRoot(target)
      else {
        const source = path.join(dataDir, relative)
        if (process.platform === 'win32') {
          // CopyFile can preserve a legacy DACL. Create the destination with its
          // private ACL first, then stream bytes without inheriting source ACLs.
          identity.writePrivateFile(target, '')
          await pipeline(createReadStream(source), createWriteStream(target, { flags: 'r+' }), { signal })
        } else {
          await fs.copyFile(source, target, constants.COPYFILE_FICLONE)
          await fs.chmod(target, 0o600)
        }
        const handle = await fs.open(target, 'r+')
        try { await handle.sync() } finally { await handle.close() }
        record.sha256 = await hash(target)
        if (record.sha256 !== await hash(source) || (await fs.stat(source)).size !== record.size) {
          fail('CRABOT_BACKUP_CHANGED', '备份期间源数据发生变化，未提交备份；请确认其它写入已停止。')
        }
      }
    }
    cancelled(signal)
    const manifest = { schema_version: 1, id, created_at: new Date().toISOString(), source: dataDir,
      scope, excluded: [...excluded], references, bytes: total, files }
    const text = JSON.stringify(manifest) + '\n'
    const file = path.join(pending, 'backup.json')
    if (process.platform === 'win32') {
      identity.writePrivateFile(file, '')
      await fs.writeFile(file, text, { flush: true })
    } else await fs.writeFile(file, text, { flag: 'wx', mode: 0o600, flush: true })
    await verifyMaintenanceBackup(pending)
    for (const [relative, record] of Object.entries(files).reverse()) if (record.type === 'directory') await syncDirectory(path.join(payload, relative))
    await syncDirectory(payload); await syncDirectory(pending)
    await fs.rename(pending, destination)
    await syncDirectory(parent)
    return { id, directory: destination, sha256: createHash('sha256').update(text).digest('hex'), bytes: total,
      scope, excluded: [...excluded], references: references.map(reference => reference.path) }
  } catch (error) {
    await fs.rm(pending, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    throw error
  }
}

export async function verifyMaintenanceBackup(directory, expectedHash) {
  try {
    if (!(await fs.lstat(directory)).isDirectory() || !identity.isOwnedDirectory(directory)) throw new Error('Invalid snapshot directory')
    const file = path.join(directory, 'backup.json'), stat = await fs.lstat(file)
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error('Invalid snapshot manifest')
    const text = await fs.readFile(file, 'utf8')
    if (expectedHash && createHash('sha256').update(text).digest('hex') !== expectedHash) throw new Error('Snapshot manifest changed')
    const manifest = JSON.parse(text), actual = Object.create(null)
    if (manifest.schema_version !== 1 || !/^[a-f0-9-]{36}$/.test(manifest.id) || typeof manifest.source !== 'string'
      || !path.isAbsolute(manifest.source) || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)
      || !Array.isArray(manifest.scope) || !Array.isArray(manifest.references) || !Array.isArray(manifest.excluded)) throw new Error('Invalid snapshot manifest')
    async function inspect(root, prefix = '') {
      for (const entry of await entries(root)) {
        const relative = prefix ? prefix + '/' + entry.name : entry.name, target = path.join(root, entry.name)
        if (entry.isDirectory()) { actual[relative] = { type: 'directory' }; await inspect(target, relative) }
        else if (entry.isFile()) actual[relative] = { type: 'file', size: (await fs.stat(target)).size, sha256: await hash(target) }
        else throw new Error('Snapshot reference is not a copied file')
      }
    }
    const payload = path.join(directory, 'data')
    if (!(await fs.lstat(payload)).isDirectory()) throw new Error('Invalid snapshot payload')
    await inspect(payload)
    const expected = Object.fromEntries(Object.entries(manifest.files).map(([name, record]) => {
      const { mode, ...content } = record; return [name, content]
    }))
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Snapshot payload changed')
    return manifest
  } catch { fail('CRABOT_BACKUP_INVALID', '备份校验失败，不能用于恢复。') }
}

// Backup deliberately does not follow references. Only maintenance migrations use
// this stopped/locked preflight; normal source startup keeps its existing behavior.
export async function assertLocalMigrationData(dataDir, migrations) {
  if (!migrations.length) return
  dataDir = realpathSync(dataDir)
  if (!cliLockToken(path.join(dataDir, 'cli.lock')) || inspectInstance(dataDir).state !== 'stopped') {
    fail('CRABOT_BACKUP_REQUIRES_STOP', '迁移范围检查需要持有操作锁并确认实例停止。')
  }
  const unsupported = () => fail('CRABOT_BACKUP_SCOPE_UNVERIFIED', '迁移数据含无法由当前备份覆盖的链接或特殊文件；未继续迁移，请保留原部署。')
  async function inspect(file) {
    const stat = await fs.lstat(file)
    if (stat.isSymbolicLink()) unsupported()
    if (stat.isDirectory()) {
      for (const entry of await fs.readdir(file)) await inspect(path.join(file, entry))
    } else if (!stat.isFile() || stat.nlink > 1) unsupported()
  }
  for (const migration of migrations) {
    if (realpathSync(path.dirname(migration.dataDir)) !== dataDir) unsupported()
    await inspect(path.join(dataDir, path.basename(migration.dataDir)))
  }
}
