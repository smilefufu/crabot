// Temporary fencing of recognized legacy entry files during explicit takeover.
// Never executes old code, stops processes, migrates data or grants authentication.
import { promises as fs, realpathSync } from 'node:fs'
import path from 'node:path'
import { legacyReleaseFiles, legacyReleaseEntryHashes } from './legacy-release-files.mjs'
import { randomUUID } from 'node:crypto'
import identity from './process-identity.cjs'
import management from './desktop-management.cjs'
import { acquireCliLock, releaseCliLock } from './cli-lock.mjs'
import { discoverLegacyUserInstall } from './legacy-desktop.mjs'
import { legacyEntryFiles as entries, hashEntry as hash, failEntryFence as fail, entryFenceBytes as fence, pairedCliFenceBytes, readEntry as regular, replaceEntry as replace, syncEntryDirectory } from './legacy-entry-files.mjs'

function knownFence(file, bytes) {
  const forward = pairedCliFenceBytes(file), digest = hash(bytes)
  return digest === hash(fence(file)) || forward !== null && digest === hash(forward)
}

const catalog = JSON.parse(await fs.readFile(new URL('../desktop/legacy-releases.json', import.meta.url), 'utf8'))
async function control(root, create = false) {
  root = realpathSync(root)
  if (!identity.isOwnedDirectory(root)) fail()
  const directory = path.join(root, '.desktop-takeover')
  try { await fs.lstat(directory) } catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error
    management.ensurePrivateDataRoot(directory)
  }
  if (create) await syncEntryDirectory(root)
  const stat = await fs.lstat(directory)
  if (!identity.isOwnedDirectory(directory) || realpathSync(directory) !== directory
    || (process.platform === 'win32' ? !identity.isPrivateDirectory(directory) : (stat.mode & 0o777) !== 0o700)) fail()
  return directory
}
async function write(directory, record) {
  await replace(path.join(directory, 'transaction.json'), Buffer.from(JSON.stringify(record) + '\n'), 0o600)
}
async function read(root, directory) {
  const file = path.join(directory, 'transaction.json'), stat = await fs.lstat(file)
  if (process.platform === 'win32' ? !identity.isPrivateFile(file) : String(stat.uid) !== identity.inspectProcess(process.pid).owner || (stat.mode & 0o777) !== 0o600) fail()
  const { bytes } = await regular(file, 2 * 1024 * 1024)
  let record
  try { record = JSON.parse(bytes) } catch { fail() }
  if (record?.schema_version !== 1 || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(record.id)
    || record.installation?.installRoot !== realpathSync(root) || !catalog.versions.includes(record.installation?.version)
    || !/^[a-f0-9]{64}$/.test(record.installation?.fingerprint) || typeof record.installation?.dataRoot !== 'string' || !path.isAbsolute(record.installation.dataRoot)
    || !['fencing', 'fenced', 'restoring', 'restored', 'data_changing'].includes(record.phase)
    || !record.originals || JSON.stringify(Object.keys(record.originals)) !== JSON.stringify(entries)) fail()
  const files = legacyReleaseFiles(catalog, record.installation.version)
  for (const file of entries) {
    const original = record.originals[file]
    if (!original || typeof original.bytes !== 'string' || !Number.isInteger(original.mode) || original.mode < 0 || original.mode > 0o777) fail()
    const bytes = Buffer.from(original.bytes, 'base64')
    if (bytes.toString('base64') !== original.bytes || !legacyReleaseEntryHashes(catalog, record.installation.version, file).includes(hash(bytes))) fail()
    files[file] = hash(bytes)
  }
  if (!identity.isOwnedDirectory(record.installation.dataRoot) || realpathSync(record.installation.dataRoot) !== record.installation.dataRoot) fail()
  if (record.installation.fingerprint !== hash(JSON.stringify({ version: record.installation.version, root: realpathSync(root), dataDir: record.installation.dataRoot, files }))) fail()
  return record
}
async function current(root, record) {
  if ((await regular(path.join(root, 'VERSION'))).bytes.toString('utf8').trim() !== record.installation.version) fail()
  for (const [file, expected] of Object.entries(legacyReleaseFiles(catalog, record.installation.version))) {
    if (!entries.includes(file) && hash((await regular(path.join(root, file))).bytes) !== expected) fail()
  }
  const states = new Map()
  for (const file of entries) {
    const bytes = (await regular(path.join(root, file))).bytes, digest = hash(bytes)
    const original = Buffer.from(record.originals[file].bytes, 'base64')
    if (digest !== hash(original) && !knownFence(file, bytes)) fail()
    states.set(file, digest === hash(original) ? 'original' : 'fenced')
  }
  return states
}

export async function fenceLegacyEntries(installation) {
  const recognized = await discoverLegacyUserInstall({ root: installation.installRoot, dataDir: installation.dataRoot })
  if (recognized.fingerprint !== installation.fingerprint) fail()
  const directory = await control(recognized.installRoot, true)
  const lock = await acquireCliLock(directory, 'fence-legacy-entries')
  try {
    try {
      await fs.lstat(path.join(directory, 'transaction.json'))
      const prior = await read(recognized.installRoot, directory)
      if (prior.phase !== 'restored' || [...(await current(recognized.installRoot, prior)).values()].some(state => state !== 'original')) fail()
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    const checked = await discoverLegacyUserInstall({ root: recognized.installRoot, dataDir: recognized.dataRoot })
    if (checked.fingerprint !== recognized.fingerprint) fail()
    const originals = Object.create(null), files = legacyReleaseFiles(catalog, checked.version)
    for (const file of entries) {
      const { bytes, mode } = await regular(path.join(checked.installRoot, file))
      if (!legacyReleaseEntryHashes(catalog, checked.version, file).includes(hash(bytes))) fail()
      files[file] = hash(bytes)
      originals[file] = { bytes: bytes.toString('base64'), mode }
    }
    if (checked.fingerprint !== hash(JSON.stringify({ version: checked.version, root: checked.installRoot, dataDir: checked.dataRoot, files }))) fail()
    const record = { schema_version: 1, id: randomUUID(), installation: checked, phase: 'fencing', originals }
    await write(directory, record) // Durable originals before the first entry is changed.
    for (const file of entries) {
      if (hash((await regular(path.join(checked.installRoot, file))).bytes) !== hash(Buffer.from(originals[file].bytes, 'base64'))) fail()
      await replace(path.join(checked.installRoot, file), fence(file), originals[file].mode)
    }
    record.phase = 'fenced'; await write(directory, record)
    return { id: record.id, phase: record.phase, installation: record.installation }
  } finally { releaseCliLock(lock) }
}

export async function inspectLegacyEntryFence(root) {
  root = realpathSync(root)
  const directory = await control(root), record = await read(root, directory)
  const states = await current(root, record)
  return { id: record.id, phase: record.phase, entries_fenced: [...states.values()].every(state => state === 'fenced'), installation: record.installation }
}

// Continue only this initial entry publication, before any data maintenance.
// Original bytes are already durable; no stop or migration is replayed here.
export async function resumeLegacyEntryFence(root, id) {
  root = realpathSync(root)
  const directory = await control(root), lock = await acquireCliLock(directory, 'resume-legacy-entry-fence')
  try {
    const record = await read(root, directory)
    if (record.id !== id || !['fencing', 'fenced'].includes(record.phase)) fail()
    try { await fs.lstat(path.join(record.installation.dataRoot, 'desktop-maintenance.json')); fail() }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    const states = await current(root, record)
    for (const file of entries) if (states.get(file) === 'original') {
      if (hash((await regular(path.join(root, file))).bytes) !== hash(Buffer.from(record.originals[file].bytes, 'base64'))) fail()
      await replace(path.join(root, file), fence(file), record.originals[file].mode)
    }
    if (record.phase !== 'fenced') { record.phase = 'fenced'; await write(directory, record) }
    return { id: record.id, phase: record.phase, installation: record.installation }
  } finally { releaseCliLock(lock) }
}

export async function restoreLegacyEntries(root) {
  root = realpathSync(root)
  const directory = await control(root), lock = await acquireCliLock(directory, 'restore-legacy-entries')
  try {
    const record = await read(root, directory)
    if (!['fencing', 'fenced', 'restoring', 'restored'].includes(record.phase)) fail()
    const states = await current(root, record) // Check every entry before restoring any.
    record.phase = 'restoring'; await write(directory, record)
    for (const file of entries) if (states.get(file) !== 'original') {
      if (!knownFence(file, (await regular(path.join(root, file))).bytes)) fail()
      await replace(path.join(root, file), Buffer.from(record.originals[file].bytes, 'base64'), record.originals[file].mode)
    }
    record.phase = 'restored'; await write(directory, record)
    return { id: record.id, phase: record.phase, installation: record.installation }
  } finally { releaseCliLock(lock) }
}

// The surrounding takeover transaction must seal before its first data write.
// Restoring entry files alone is unsafe once schemas/data may have changed.
export async function sealLegacyEntryFence(root, id) {
  root = realpathSync(root)
  const directory = await control(root), lock = await acquireCliLock(directory, 'seal-legacy-entries')
  try {
    const record = await read(root, directory), states = await current(root, record)
    if (record.id !== id || record.phase !== 'fenced' || [...states.values()].some(state => state !== 'fenced')) fail()
    record.phase = 'data_changing'; await write(directory, record)
  } finally { releaseCliLock(lock) }
}


// The takeover coordinator separately verifies schema4, target programs and
// stopped conversion. Only these original command files gain the fixed handoff;
// the same durable originals and all old Core guards are kept.
export async function enableLegacyCliForwarding(root, id) {
  root = realpathSync(root)
  const directory = await control(root), lock = await acquireCliLock(directory, 'legacy-cli-forwarding')
  try {
    const record = await read(root, directory), states = await current(root, record)
    if (record.id !== id || !['fenced', 'data_changing'].includes(record.phase) || [...states.values()].some(state => state !== 'fenced')) fail()
    for (const file of ['cli.mjs', 'crabot.cmd']) {
      const bytes = (await regular(path.join(root, file))).bytes, target = pairedCliFenceBytes(file)
      if (hash(bytes) === hash(target)) continue
      if (!knownFence(file, bytes)) fail()
      await replace(path.join(root, file), target, record.originals[file].mode)
    }
  } finally { releaseCliLock(lock) }
}
