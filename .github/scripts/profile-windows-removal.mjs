// One-off isolated performance evidence. Wrap observations without changing any
// returned result or deletion rule; no GUI/Core or business service is started.
import assert from 'node:assert/strict'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import physical from '../../scripts/lib/physical-fs.cjs'
import identity from '../../scripts/lib/process-identity.cjs'
import installation from '../../scripts/lib/desktop-installation.cjs'
import management from '../../scripts/lib/desktop-management.cjs'
import { prepareDesktopInstallation, commitDesktopInstallation } from '../../scripts/lib/desktop-payload.mjs'
import { acquireExistingCliLock, releaseCliLock } from '../../scripts/lib/cli-lock.mjs'
import { captureDesktopRemovalProof } from '../../scripts/lib/desktop-removal-proof.mjs'
import { privateJson } from '../../scripts/lib/desktop-preparation-files.mjs'
import { removeDesktopRemovalPrograms } from '../../scripts/lib/desktop-removal-delete.mjs'
assert.equal(process.platform, 'win32'); assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
const execute = promisify(execFile), project = path.resolve('.desktop-build/removal-profile')
await fs.mkdir(project, { recursive: true })
async function find(directory, suffix) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) { const found = await find(file, suffix); if (found) return found }
    else if (entry.name.endsWith(suffix)) return file
  }
}
const candidate = await find(path.resolve(process.argv[2]), '-offline-candidate.exe'); assert.ok(candidate)
const wrapper = path.join(project, 'wrapper'), host = path.join(project, 'host')
await execute('7z.exe', ['x', candidate, '-o' + wrapper, '-y'], { timeout: 180000, maxBuffer: 1024 * 1024 })
const archive = await find(wrapper, 'app-64.7z'); assert.ok(archive)
await execute('7z.exe', ['x', archive, '-o' + host, '-y'], { timeout: 180000, maxBuffer: 1024 * 1024 })
const payload = path.join(host, 'resources/offline')
const root = await fs.mkdtemp(path.join(tmpdir(), 'Crabot removal profile ')), installRoot = path.join(root, 'programs')
const prepared = await prepareDesktopInstallation({ payload, installRoot })
await commitDesktopInstallation(prepared)
const own = installation.readDesktopSelection(installRoot), id = randomUUID(), sentinel = path.join(own.dataDir, 'keep.txt')
await fs.writeFile(sentinel, 'data retained\n')
const rootLock = await acquireExistingCliLock(own.root, 'ci-removal-profile')
let dataLock
const counters = new Map(), restores = []
function category(file) {
  if (typeof file !== 'string') return 'other'
  const relative = path.relative(own.root, file).split(path.sep).join('/')
  if (relative.endsWith('cli.lock')) return 'lock'
  if (relative.startsWith('app/removals/')) return 'proof'
  if (relative.startsWith('data/')) return 'data'
  if (relative.startsWith('releases/') || relative.startsWith('app/releases/')) return 'program'
  return 'base'
}
function account(name, file, start) {
  const key = name + ':' + category(file), value = counters.get(key) || { calls: 0, milliseconds: 0 }
  value.calls++; value.milliseconds += performance.now() - start; counters.set(key, value)
}
function wrap(object, key, name, asynchronous = false) {
  const original = object[key]; assert.equal(typeof original, 'function')
  const wrapped = asynchronous ? async function (...args) {
    const start = performance.now(); try { return await original.apply(this, args) } finally { account(name, args[0], start) }
  } : function (...args) {
    const start = performance.now(); try { return original.apply(this, args) } finally { account(name, args[0], start) }
  }
  Object.assign(wrapped, original); object[key] = wrapped; restores.push(() => { object[key] = original })
}
let result, elapsed
try {
  dataLock = await acquireExistingCliLock(own.dataDir, 'ci-removal-profile')
  const proof = await captureDesktopRemovalProof(own.root, id)
  const directory = management.ensurePrivateDataRoot(path.join(management.ensurePrivateDataRoot(path.join(own.root, 'app/removals')), id))
  await privateJson(path.join(directory, 'proof.json'), proof)
  await privateJson(path.join(own.root, '.desktop-removal.json'), { schema_version: 1, installation_id: own.record.installation_id,
    operation_id: id, source_selection: own.selection, phase: 'removing', proof_sha256: createHash('sha256').update(JSON.stringify(proof) + '\n').digest('hex') })
  for (const key of ['lstatSync', 'readFileSync', 'readdirSync', 'realpathSync', 'unlinkSync', 'rmdirSync']) wrap(physical, key, 'fs.' + key)
  wrap(physical.realpathSync, 'native', 'fs.realpathSync.native')
  for (const key of ['lstat', 'readFile', 'readdir', 'realpath', 'open']) wrap(physical.promises, key, 'fs.promises.' + key, true)
  for (const key of ['isOwnedDirectory', 'isOwnedFile', 'isExistingDataDirectory', 'isPrivateFile', 'inspectProcess', 'inspectProgramReferences'])
    wrap(identity, key, 'native.' + key, key === 'inspectProgramReferences')
  const start = performance.now(); console.log('CRABOT_REMOVAL_PROFILE_BEGIN')
  result = await removeDesktopRemovalPrograms({ installRoot: own.root, operationId: id })
  elapsed = performance.now() - start
} finally {
  for (const restore of restores.reverse()) restore()
  if (dataLock) releaseCliLock(dataLock); releaseCliLock(rootLock)
  const report = { elapsed_ms: elapsed, counters: Object.fromEntries([...counters.entries()].sort((a, b) => b[1].milliseconds - a[1].milliseconds)),
    removed: result?.removed.length, retained: result?.retained.length, data_retained: await fs.readFile(sentinel, 'utf8') === 'data retained\n', business_started: false }
  await fs.writeFile(path.resolve('.desktop-build/windows-removal-profile.json'), JSON.stringify(report, null, 2) + '\n')
  console.log('CRABOT_REMOVAL_PROFILE_RESULT ' + JSON.stringify(report))
}
assert.equal(result.retained.length, 0)
assert.equal(await fs.readFile(sentinel, 'utf8'), 'data retained\n')
await fs.rm(root, { recursive: true, force: true })
