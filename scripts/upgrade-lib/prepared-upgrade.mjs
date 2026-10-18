import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { fileDigest, optional, writeAtomic, hash, assertStopped } from './scoped-data.mjs'
import { acquireCliLock, releaseCliLock, inheritedCliLock } from '../lib/cli-lock.mjs'
import { runSourceUpgrade, syncPythonDeps } from './source.mjs'
import { downloadRelease, getReleaseUrls, unpackRelease } from './release.mjs'
import { verifyReleasePackage } from '../lib/release-package.mjs'
import { previewMigrations } from './migrate.mjs'
import { preparedMemoryPython } from '../lib/memory-deps.mjs'
import { runBounded } from '../lib/run-bounded.mjs'
const exec = promisify(execFile)
const protectedNames = new Set(['.git', '.env', 'data', 'instance.json', 'agent-venv', 'VERSION'])
const environment = () => ({ platform: process.platform, arch: process.arch, node: process.version, executable: process.execPath, uid: process.getuid?.() ?? null })
const directoryFor = home => path.join(path.dirname(home), `.${path.basename(home)}-upgrade-prepared`)

async function git(home, args) { return (await exec('git', args, { cwd: home, maxBuffer: 16 * 1024 * 1024 })).stdout }
export async function sourceIdentity(home) {
  if ((await git(home, ['status', '--porcelain=v1', '--untracked-files=normal'])).trim()) throw new Error('Source checkout has uncommitted changes; prepare only a clean revision')
  return (await git(home, ['rev-parse', 'HEAD'])).trim()
}
async function copySource(home, stage, revision) {
  const files = (await git(home, ['ls-files', '-z'])).split('\0').filter(Boolean)
  for (const name of files) {
    if (protectedNames.has(name.split('/')[0]) || ['crabot-docs', 'crabot-voice-android'].includes(name.split('/')[0])) throw new Error('Source preparation cannot include data or nested projects')
    const source = path.join(home, name), destination = path.join(stage, name), stat = await fs.lstat(source)
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('Unsupported tracked build input')
    await fs.mkdir(path.dirname(destination), { recursive: true })
    if (stat.isSymbolicLink()) await fs.symlink(await fs.readlink(source), destination)
    else { await fs.copyFile(source, destination); await fs.chmod(destination, stat.mode & 0o777) }
  }
  if (await sourceIdentity(home) !== revision) throw new Error('Source revision changed during preparation')
}
/** Reuse only pinned product resources that the target's own checker accepts. */
async function seedRuntimes(home, stage, logger) {
  const require = createRequire(path.join(stage, 'package.json'))
  const scrapling = require(path.join(stage, 'scripts/lib/scrapling-runtime.cjs'))
  let cachedScrapling
  try {
    const pointer = JSON.parse(await fs.readFile(path.join(home, 'scrapling-runtime.json'), 'utf8'))
    if (typeof pointer.directory !== 'string' || !pointer.directory.startsWith('.scrapling-runtime-') || path.basename(pointer.directory) !== pointer.directory) throw new Error('Invalid cached resource path')
    cachedScrapling = { name: pointer.directory, ...scrapling.validateDirectory(stage, path.join(home, pointer.directory), { full: true }) }
  } catch { /* Missing or another generation: the existing preparer downloads its pinned resources. */ }
  if (cachedScrapling) {
    await fs.cp(cachedScrapling.directory, path.join(stage, cachedScrapling.name), { recursive: true, verbatimSymlinks: true })
    await fs.writeFile(path.join(stage, 'scrapling-runtime.json'), JSON.stringify({ directory: cachedScrapling.name }))
    scrapling.loadRuntime(stage, { full: true })
    logger.info('Reused verified Scrapling runtime for target generation')
  }
  const computer = require(path.join(stage, 'scripts/lib/computer-use-runtime.cjs'))
  let cachedComputer
  try { cachedComputer = computer.loadRuntime(home, { full: true }) } catch { /* Existing preparer owns missing generations. */ }
  if (cachedComputer) {
    const relative = path.relative(home, cachedComputer.directory)
    if (!relative.startsWith(`.computer-use-runtime${path.sep}`)) throw new Error('Invalid cached Cua resource path')
    await fs.cp(cachedComputer.directory, path.join(stage, relative), { recursive: true, verbatimSymlinks: true })
    computer.loadRuntime(stage, { full: true })
    logger.info('Reused verified Cua runtime for target generation')
  }
}
async function inventory(root, names) {
  const entries = []
  async function visit(name) {
    const filename = path.join(root, name), stat = await fs.lstat(filename)
    if (stat.isDirectory()) for (const child of (await fs.readdir(filename)).sort()) await visit(path.join(name, child))
    else if (stat.isSymbolicLink()) entries.push({ name, link: await fs.readlink(filename) })
    else if (stat.isFile()) entries.push({ name, size: stat.size, mode: stat.mode & 0o777, mtime_ms: stat.mtimeMs, sha256: await fileDigest(filename) })
    else throw new Error('Unsupported prepared product entry')
  }
  for (const name of names.sort()) await visit(name)
  return entries
}
async function artifactNames(stage, mode, home) {
  if (mode === 'release') {
    const names = (await fs.readdir(stage)).filter(name => !protectedNames.has(name))
    if (await fs.lstat(path.join(home, 'crabot.cmd')).then(() => true, () => false)) return expandRuntimePool(stage, names.filter(name => name !== 'crabot.cmd'))
    return expandRuntimePool(stage, names)
  }
  const candidates = ['dist', 'node_modules', 'scripts/lib/node_modules', '.computer-use-runtime', 'scrapling-runtime.json']
  for (const entry of await fs.readdir(stage, { withFileTypes: true })) {
    if (entry.name.startsWith('.scrapling-runtime-')) candidates.push(entry.name)
    if (entry.isDirectory() && entry.name.startsWith('crabot-')) {
      if (entry.name === 'crabot-memory') candidates.push('crabot-memory/.venv', 'crabot-memory/prepared-environment.json')
      else candidates.push(`${entry.name}/dist`, `${entry.name}/node_modules`)
    }
  }
  candidates.push('crabot-admin/web/node_modules')
  const existing = []
  for (const name of candidates) if (await fs.lstat(path.join(stage, name)).then(() => true, () => false)) existing.push(name)
  return expandRuntimePool(stage, existing)
}
async function expandRuntimePool(stage, names) {
  const result = names.filter(name => name !== '.computer-use-runtime')
  if (names.includes('.computer-use-runtime')) {
    for (const name of await fs.readdir(path.join(stage, '.computer-use-runtime'))) result.push(path.join('.computer-use-runtime', name))
  }
  return result
}
async function validateEnvironment(stage) {
  const python = await preparedMemoryPython(path.join(stage, 'crabot-memory'))
  if (!python) throw new Error('Target Memory dependencies were not prepared as relocatable')
  await runBounded(python, ['-I', '-B', '-c', 'import src.main'], { cwd: stage, timeout: 30000 })
}

/** All downloads, installs, builds, hashes and read-only data previews happen here. No stop. */
export async function prepareUpgrade(home, dataRoot, { mode, version, logger = console, build = runSourceUpgrade, download = downloadRelease, unpack = unpackRelease, sync = syncPythonDeps, verify = verifyReleasePackage, audit = validateEnvironment } = {}) {
  home = await fs.realpath(home)
  if (mode === 'release' && await fs.lstat(path.join(home, '.git')).then(() => true, () => false)) throw new Error('A release must not replace a source checkout')
  const target = mode === 'source' ? await sourceIdentity(home) : version
  if (!target || !['source', 'release'].includes(mode)) throw new Error('Missing upgrade target')
  const parent = directoryFor(home), readyFile = path.join(parent, 'prepared.json')
  await fs.mkdir(parent, { recursive: true, mode: 0o700 })
  const lock = await acquireCliLock(parent, 'prepare-upgrade', 0)
  let stage, artifact
  try {
    const identity = { schema_version: 1, home, mode, target, environment: environment() }
    const existing = await optional(readyFile)
    if (existing) {
      const ready = JSON.parse(existing)
      if (ready.phase === 'switching') throw new Error('Interrupted product switch; preserve recovery materials')
      if (ready.phase === 'prepared' && JSON.stringify(ready.identity) === JSON.stringify(identity)) {
        const manifest = await fs.readFile(ready.manifest)
        if (hash(manifest) !== ready.payload_sha256) throw new Error('Prepared manifest changed')
        const entries = await inventory(ready.stage, ready.artifacts)
        if (hash(JSON.stringify(entries)) !== ready.payload_sha256) throw new Error('Prepared product changed; prepare a fresh target')
        await audit(ready.stage)
        return { ...ready, entries, preview: await previewMigrations(ready.stage, dataRoot), reused: true }
      }
    }
    stage = path.join(parent, `stage-${randomUUID()}`)
    await fs.mkdir(stage, { mode: 0o700 })
    const started = performance.now()
    if (mode === 'source') {
      await copySource(home, stage, target)
      if (build === runSourceUpgrade) await seedRuntimes(home, stage, logger)
      await build(stage, logger)
    }
    else {
      artifact = await download({ ...getReleaseUrls(target), logger })
      stage = await unpack({ ...artifact, stage, logger })
      await sync(stage, logger)
    }
    await verify(stage, target)
    await audit(stage)
    const artifacts = await artifactNames(stage, mode, home), entries = await inventory(stage, artifacts)
    const bytes = entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0)
    const preview = await previewMigrations(stage, dataRoot)
    const controlBytes = Buffer.byteLength(JSON.stringify(entries)) * 2 + 1024 * 1024
    const space = await fs.statfs(home)
    if (Number(space.bavail) * Number(space.bsize) < controlBytes) throw new Error('Insufficient space for upgrade control records')
    if (preview.backup_bytes > 0) {
      const dataSpace = await fs.statfs(dataRoot)
      if (Number(dataSpace.bavail) * Number(dataSpace.bsize) < preview.backup_bytes * 3) throw new Error('Insufficient space for scoped data backup and conversion')
    }
    const manifest = `${stage}.manifest.json`
    const manifestBytes = Buffer.from(JSON.stringify(entries))
    await writeAtomic(manifest, manifestBytes)
    const ready = { identity, phase: 'prepared', stage, artifacts, manifest, payload_sha256: hash(manifestBytes), payload_bytes: bytes, preparation_ms: performance.now() - started }
    await writeAtomic(readyFile, JSON.stringify(ready))
    return { ...ready, entries, preview, reused: false }
  } catch (error) {
    if (stage && stage.startsWith(parent + path.sep)) await fs.rm(stage, { recursive: true, force: true })
    throw error
  } finally {
    if (artifact?.tmp) await fs.rm(artifact.tmp, { recursive: true, force: true })
    releaseCliLock(lock)
  }
}

/** Called only after the owning entry explicitly stopped this instance, under its operation lock. */
export async function installPreparedUpgrade(prepared, home, dataRoot) {
  home = await fs.realpath(home)
  await assertStopped(dataRoot)
  if (!inheritedCliLock(dataRoot, { CRABOT_CLI_LOCK_HELD: '1', CRABOT_CLI_LOCK_OWNER: String(process.pid) })) throw new Error('Product switch requires the owning instance operation lock')
  if (prepared.phase !== 'prepared' || prepared.identity.home !== home || JSON.stringify(prepared.identity.environment) !== JSON.stringify(environment())) throw new Error('Prepared upgrade belongs to a different target or environment')
  if (prepared.identity.mode === 'source' && await sourceIdentity(home) !== prepared.identity.target) throw new Error('Source target changed after preparation')
  // The expensive digest audit ran immediately before stop. Verify the sealed payload's identity
  // again without putting a second full product hash into the downtime window.
  for (const entry of prepared.entries) {
    const filename = path.join(prepared.stage, entry.name), stat = await fs.lstat(filename)
    let changed
    if (entry.link !== undefined) changed = !stat.isSymbolicLink() || await fs.readlink(filename) !== entry.link
    else changed = !stat.isFile() || stat.size !== entry.size || stat.mtimeMs !== entry.mtime_ms || (stat.mode & 0o777) !== entry.mode
    if (changed) throw new Error('Prepared payload changed before switch')
  }
  const parent = directoryFor(home), readyFile = path.join(parent, 'prepared.json'), rollback = path.join(parent, `rollback-${randomUUID()}`)
  await fs.mkdir(rollback, { mode: 0o700 })
  const moved = []
  const { entries: _entries, preview: _preview, ...record } = prepared
  const recordSwitch = phase => writeAtomic(readyFile, JSON.stringify({ ...record, phase, rollback, moved }))
  await recordSwitch('switching')
  try {
    for (const name of prepared.artifacts) {
      if (protectedNames.has(name.split(path.sep)[0])) throw new Error('Protected install path in prepared payload')
      const old = path.join(home, name), saved = path.join(rollback, name), target = path.join(prepared.stage, name)
      const existed = await fs.lstat(old).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
      const entry = { name, existed, saved: false, installed: false }; moved.push(entry)
      await recordSwitch('switching')
      await fs.mkdir(path.dirname(old), { recursive: true })
      if (existed) { await fs.mkdir(path.dirname(saved), { recursive: true }); await fs.rename(old, saved); entry.saved = true }
      await fs.rename(target, old); entry.installed = true
    }
    await recordSwitch('installed')
    return { rollback }
  } catch (error) {
    for (const entry of [...moved].reverse()) {
      if (entry.installed) { await fs.mkdir(path.dirname(path.join(prepared.stage, entry.name)), { recursive: true }); await fs.rename(path.join(home, entry.name), path.join(prepared.stage, entry.name)) }
      if (entry.saved) await fs.rename(path.join(rollback, entry.name), path.join(home, entry.name))
    }
    await writeAtomic(readyFile, JSON.stringify({ ...record, phase: 'prepared' }))
    throw error
  }
}
