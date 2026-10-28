// Administrator code fencing only. No employee file/process/data access. The
// conversion coordinator owns startup-source proof, shutdown, backups and switch.
import { promises as fs, realpathSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { discoverLegacySystemRelease, verifyLegacySystemCodePaths } from './legacy-system-release.mjs'
import { legacyReleaseFiles } from './legacy-release-files.mjs'
import { verifyRootDirectory } from './system-user.mjs'
import { systemError } from './system-registry.mjs'
import management from './desktop-management.cjs'
import { acquireCliLock, releaseCliLock } from './cli-lock.mjs'
import { legacyEntryFiles as entries, hashEntry as hash, failEntryFence as fail, entryFenceBytes,
  readEntry as regular, replaceEntry as replace, syncEntryDirectory } from './legacy-entry-files.mjs'
const catalog = JSON.parse(await fs.readFile(new URL('../desktop/legacy-releases.json', import.meta.url), 'utf8'))
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
const fence = file => entryFenceBytes(file, 'system')
const sameRelease = (a, b) => a && b && Object.keys(a).length === 3 && Object.keys(b).length === 3
  && ['version', 'installRoot', 'code_fingerprint'].every(key => a[key] === b[key])

// ownerUid/checkRoot are owned temporary-tree fixtures, never CLI/env options.
export class LegacySystemEntryFence {
  constructor({ ownerUid = 0, checkRoot = verifyRootDirectory } = {}) { this.ownerUid = ownerUid; this.checkRoot = checkRoot }
  authority() {
    if (process.platform === 'win32' || process.getuid?.() !== this.ownerUid || this.ownerUid === 0 && process.platform !== 'linux') {
      throw systemError('旧共享入口仅Linux管理员可隔离或恢复。', 'CRABOT_SYSTEM_ADMIN_REQUIRED')
    }
  }
  async root(directory) {
    this.authority(); directory = path.resolve(directory)
    await this.checkRoot(directory)
    const stat = await fs.lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== this.ownerUid || stat.mode & 0o022) fail()
    directory = await fs.realpath(directory)
    for (const name of ['.git', 'core-release.json', 'cli-installation.json']) {
      if (await fs.lstat(path.join(directory, name)).catch(error => { if (error.code === 'ENOENT') return null; throw error })) fail()
    }
    return directory
  }
  async control(root, create = false) {
    const directory = path.join(root, '.system-takeover')
    if (create) { management.ensurePrivateDataRoot(directory); await syncEntryDirectory(root) }
    const stat = await fs.lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== this.ownerUid || (stat.mode & 0o777) !== 0o700 || realpathSync(directory) !== directory) fail()
    return directory
  }
  attributes(root, files) { return verifyLegacySystemCodePaths(root, ['VERSION', ...Object.keys(files)], this.ownerUid) }
  async read(root, directory) {
    const file = path.join(directory, 'transaction.json'), stat = await fs.lstat(file)
    if (stat.uid !== this.ownerUid || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) fail()
    const { bytes } = await regular(file, 2 * 1024 * 1024)
    let record
    try { record = JSON.parse(bytes) } catch { fail() }
    const installation = record?.installation
    if (record?.schema_version !== 1 || !uuid(record.id) || !uuid(record.operation_id)
      || !installation || Object.keys(installation).length !== 3 || installation.installRoot !== root || !catalog.versions.includes(installation.version)
      || !['fencing', 'fenced', 'restoring', 'restored', 'data_changing'].includes(record.phase)
      || !record.originals || JSON.stringify(Object.keys(record.originals)) !== JSON.stringify(entries)) fail()
    const files = legacyReleaseFiles(catalog, installation.version, 'linux')
    if (installation.code_fingerprint !== hash(JSON.stringify({ version: installation.version, root, files }))) fail()
    for (const name of entries) {
      const saved = record.originals[name]
      if (!saved || typeof saved.bytes !== 'string' || !Number.isInteger(saved.mode) || saved.mode < 0 || saved.mode > 0o777 || saved.mode & 0o022) fail()
      const original = Buffer.from(saved.bytes, 'base64')
      if (original.toString('base64') !== saved.bytes || hash(original) !== files[name]) fail()
    }
    return record
  }
  async states(root, record) {
    const files = legacyReleaseFiles(catalog, record.installation.version, 'linux')
    await this.attributes(root, files)
    if ((await regular(path.join(root, 'VERSION'))).bytes.toString('utf8').trim() !== record.installation.version) fail()
    for (const [name, expected] of Object.entries(files)) if (!entries.includes(name) && hash((await regular(path.join(root, name))).bytes) !== expected) fail()
    const states = new Map()
    for (const name of entries) {
      const digest = hash((await regular(path.join(root, name))).bytes)
      if (digest !== hash(fence(name)) && digest !== files[name]) fail()
      states.set(name, digest === files[name] ? 'original' : 'fenced')
    }
    return states
  }
  write(directory, record) { return replace(path.join(directory, 'transaction.json'), Buffer.from(JSON.stringify(record) + '\n'), 0o600) }
  summary(record, states) { return { id: record.id, operation_id: record.operation_id, phase: record.phase, installation: record.installation,
    ...(states ? { entries_fenced: [...states.values()].every(state => state === 'fenced') } : {}) } }
  async fence(installation, operationId) {
    const root = await this.root(installation.installRoot)
    if (!uuid(operationId)) fail()
    const directory = await this.control(root, true), lock = await acquireCliLock(directory, 'system-fence-legacy-entries')
    try {
      let record
      try { record = await this.read(root, directory) } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (record && record.phase !== 'restored') {
        if (record.operation_id !== operationId || !sameRelease(record.installation, installation) || !['fencing', 'fenced'].includes(record.phase)) fail()
      } else {
        const recognized = await discoverLegacySystemRelease({ root, platform: 'linux', ownerUid: this.ownerUid, checkRoot: this.checkRoot })
        if (!sameRelease(recognized, installation)) fail()
        const originals = Object.create(null)
        const files = legacyReleaseFiles(catalog, recognized.version, 'linux')
        for (const name of entries) {
          const { bytes, mode } = await regular(path.join(root, name))
          if (hash(bytes) !== files[name] || mode & 0o022) fail()
          originals[name] = { bytes: bytes.toString('base64'), mode }
        }
        record = { schema_version: 1, id: randomUUID(), operation_id: operationId, installation: recognized, phase: 'fencing', originals }
        await this.write(directory, record)
      }
      const states = await this.states(root, record)
      for (const name of entries) if (states.get(name) === 'original') {
        if (hash((await regular(path.join(root, name))).bytes) !== legacyReleaseFiles(catalog, record.installation.version, 'linux')[name]) fail()
        await replace(path.join(root, name), fence(name), record.originals[name].mode)
      }
      record.phase = 'fenced'; await this.write(directory, record)
      return this.summary(record)
    } finally { releaseCliLock(lock) }
  }
  async inspect(directory) {
    const root = await this.root(directory), control = await this.control(root), record = await this.read(root, control)
    return this.summary(record, await this.states(root, record))
  }
  async restore(directory, id, operationId) {
    const root = await this.root(directory), control = await this.control(root), lock = await acquireCliLock(control, 'system-restore-legacy-entries')
    try {
      const record = await this.read(root, control)
      if (record.id !== id || record.operation_id !== operationId || !['fencing', 'fenced', 'restoring', 'restored'].includes(record.phase)) fail()
      const states = await this.states(root, record)
      record.phase = 'restoring'; await this.write(control, record)
      for (const name of entries) if (states.get(name) !== 'original') {
        if (hash((await regular(path.join(root, name))).bytes) !== hash(fence(name))) fail()
        await replace(path.join(root, name), Buffer.from(record.originals[name].bytes, 'base64'), record.originals[name].mode)
      }
      record.phase = 'restored'; await this.write(control, record)
      return this.summary(record)
    } finally { releaseCliLock(lock) }
  }
  async seal(directory, id, operationId) {
    const root = await this.root(directory), control = await this.control(root), lock = await acquireCliLock(control, 'system-seal-legacy-entries')
    try {
      const record = await this.read(root, control), states = await this.states(root, record)
      if (record.id !== id || record.operation_id !== operationId || record.phase !== 'fenced' || [...states.values()].some(value => value !== 'fenced')) fail()
      record.phase = 'data_changing'; await this.write(control, record)
      return this.summary(record)
    } finally { releaseCliLock(lock) }
  }
}
