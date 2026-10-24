// Isolated CI component-to-product acceptance. The source packages unchanged
// production modules with a finite actor; the target runs ordinary main.
import assert from 'node:assert/strict'
import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { randomBytes, generateKeyPairSync } from 'node:crypto'
import { runBounded } from '../../scripts/lib/run-bounded.mjs'
import { verifyCoreRelease, writeCoreRelease } from '../../scripts/lib/core-release.mjs'
import { verifyDesktopPayload, prepareDesktopInstallation, commitDesktopInstallation } from '../../scripts/lib/desktop-payload.mjs'
import { writeSignedDesktopPayload } from '../../scripts/desktop/sign-release.mjs'
import { inspectInstance, identity } from '../../scripts/lib/instance-runtime.mjs'
import { stopInstance } from '../../scripts/lib/instance-controller.mjs'
import product from '../../scripts/lib/product-runtime.cjs'
import { buildPairedUpdateSource } from './build-paired-update-source.mjs'

if (process.env.GITHUB_ACTIONS !== 'true' || !['darwin', 'win32'].includes(process.platform)) throw new Error('Requires an isolated macOS/Windows CI user; never run against a developer MM')
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const project = await fs.realpath(path.resolve(process.argv[2])), location = JSON.parse(await fs.readFile(path.join(project, 'packaged-location.json'), 'utf8'))
assert.equal(location.schema_version, 2)
const inside = relative => {
  assert.equal(typeof relative, 'string'); assert.equal(path.isAbsolute(relative), false)
  const file = path.resolve(project, relative), from = path.relative(project, file)
  assert.ok(from && from !== '..' && !from.startsWith('..' + path.sep) && !path.isAbsolute(from)); return file
}
const payload = inside(location.payload), originalCore = inside(location.core)
const original = await verifyCoreRelease(originalCore), verified = await verifyDesktopPayload(payload)
assert.equal(original.source_dirty, false); assert.equal(verified.record.selection.core_id, original.inventory_sha256)
const runtime = product.loadProductRuntime(originalCore, { required: true, full: true })
const needed = verified.bytes * 9n + 2n * 1024n ** 3n, space = await fs.statfs(repository, { bigint: true })
const temporarySpace = await fs.statfs(tmpdir(), { bigint: true })
if (space.bavail * space.bsize < needed || temporarySpace.bavail * temporarySpace.bsize < needed) throw Object.assign(new Error('Whole update fixture needs bounded program-copy space'), { code: 'CRABOT_UPDATE_SPACE' })
// npm redacts UUID-shaped dependency paths; build directories use random hex.
const job = path.join(repository, '.desktop-build', 'paired-update-' + randomBytes(12).toString('hex')), temporary = await fs.mkdtemp(path.join(tmpdir(), 'Crabot 更新 '))
await fs.mkdir(job, { mode: 0o700 }); const control = path.join(temporary, 'control'), home = path.join(temporary, 'home')
await fs.mkdir(control, { mode: 0o700 }); await fs.mkdir(home, { mode: 0o700 })
let selected, child, targetIdentity, sourceIdentity, expectedTargetGuiRoot, phase = 'prepare-target', success = false, sourceOutput = ''
const report = { platform: process.platform, arch: process.arch, candidate_channel_enabled: false, remote_model_called: false,
  source_gui: 'fixture-packaged-component-actor', target_gui: 'ordinary-packaged-main', fixture_debugger: false, real_login_session_verified: false }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function readControl(name) {
  try { return JSON.parse(await fs.readFile(path.join(control, name + '.json'), 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
async function poll(label, check, timeout = 180000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const failure = await readControl('failure')
    if (failure) throw new Error('Source fixture failure: ' + failure.code + ': ' + failure.message)
    const value = await check(); if (value) return value
    if (child && child.exitCode !== null && child.exitCode !== 0) throw new Error('Source actor exited before ' + label)
    await sleep(250)
  }
  throw new Error('Timed out: ' + label)
}

try {
  // A synthetic higher version with unchanged feature code; both are full real
  // runtime packages. This does not claim a historical-release migration.
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-.*)?$/.exec(original.version); assert.ok(match)
  const targetVersion = `${match[1]}.${match[2]}.${Number(match[3]) + 1}-desktop-fixture.1`, targetCore = path.join(job, 'core')
  await fs.cp(originalCore, targetCore, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
  for (const file of ['package.json', 'product-runtime.json']) {
    const value = JSON.parse(await fs.readFile(path.join(targetCore, file), 'utf8')); value.version = targetVersion
    await fs.writeFile(path.join(targetCore, file), JSON.stringify(value) + '\n')
  }
  await writeCoreRelease(targetCore, { schema_version: 1, version: targetVersion, platform: original.platform, arch: original.arch, commit: original.commit, source_dirty: false })
  const targetProject = path.join(job, 'paired')
  await runBounded(runtime.executables.node, [path.join(repository, 'scripts/desktop/package-application.mjs'), '--candidate=true', '--layout=paired', '--core=' + targetCore, '--out=' + targetProject], { cwd: repository, timeout: 240000 })
  const targetPayload = path.join(targetProject, 'offline'), target = await verifyDesktopPayload(targetPayload)
  const keys = generateKeyPairSync('ed25519'), publication = path.join(job, 'publication')
  const signed = await writeSignedDesktopPayload({ payload: targetPayload, python: runtime.executables.python,
    privateKeys: [keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()], output: publication })
  // The signed archive is self-contained. These exact producer trees were
  // never executed and are no longer needed; avoid retaining redundant cores.
  await fs.rm(targetProject, { recursive: true }); await fs.rm(targetCore, { recursive: true })
  phase = 'prepare-source'
  const sourcePayload = await buildPairedUpdateSource({ repository, project, destination: path.join(job, 'source-project') })
  selected = await commitDesktopInstallation(await prepareDesktopInstallation({ payload: sourcePayload, installRoot: path.join(temporary, '整体 安装') }))
  await fs.rm(path.join(job, 'source-project'), { recursive: true })
  expectedTargetGuiRoot = path.join(selected.root, 'app/releases', target.record.selection.gui_id)
  const sentinel = path.join(selected.dataDir, 'update-fixture-preserved.txt'); await fs.writeFile(sentinel, 'preserved across the actual pair handoff\n')
  const metadata = { source: selected, home, control, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), publication,
    manifestName: path.basename(signed.manifestFile), signaturesName: path.basename(signed.signaturesFile), artifactName: path.basename(signed.artifact), targetVersion }
  const config = path.join(control, 'config.json'); await fs.writeFile(config, JSON.stringify(metadata) + '\n', { mode: 0o600 })
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'Roaming'), LOCALAPPDATA: path.join(home, 'Local'), DATA_DIR: selected.dataDir, GIT_ALLOW_PROTOCOL: 'file', CRABOT_PAIRED_UPDATE_FIXTURE_CONFIG: config }
  for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'CRABOT_DEV', 'CRABOT_PORT_OFFSET']) delete env[name]
  phase = 'source-start-and-update'
  child = spawn(selected.executable, ['--background'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { sourceOutput = (sourceOutput + bytes.toString()).slice(-128000) })
  child.on('error', error => { sourceOutput += String(error) })
  sourceIdentity = await poll('source actor identity', async () => identity.inspectProcess(child.pid), 10000)
  const before = await poll('source ready', () => readControl('source-ready'))
  const handoff = await poll('committed target handoff', () => readControl('handoff'), 420000)
  assert.deepEqual(handoff.target, target.record.selection); assert.equal(handoff.ordinary_exits, 0); assert.equal(handoff.requests, 3)
  assert.match(handoff.maintenance_id, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/); assert.equal(handoff.production_peer_policy_verified, true)
  phase = 'target-start-and-health'
  const installation = createRequire(import.meta.url)('../../scripts/lib/desktop-installation.cjs'), current = installation.readDesktopSelection(selected.root)
  targetIdentity = await poll('ordinary target executable', async () => {
    for (const pid of identity.listProcessIds()) {
      try {
        const value = identity.inspectProcess(pid)
        if (value?.owner === sourceIdentity.owner && await fs.realpath(value.executable) === await fs.realpath(current.executable)) return value
      } catch { /* unrelated inaccessible or exited process */ }
    }
    return null
  })
  assert.equal(identity.sameProcess(sourceIdentity, identity.inspectProcess(sourceIdentity.pid)), false)
  // Only ordinary target main clears this job after data compatibility, an
  // authenticated desktop session and Core verification. Keep normal peer args.
  await poll('ordinary target main health completion', async () => {
    try { await fs.stat(path.join(selected.dataDir, 'desktop-maintenance.json')); return false }
    catch (error) { if (error.code === 'ENOENT') return true; throw error }
  })
  const entry = await import(new URL('../../scripts/lib/desktop-entry.cjs', import.meta.url))
  assert.equal(entry.default.verifyDesktopEntry(targetIdentity, entry.default.loadDesktopEntry(current.coreRoot)), true)
  const after = inspectInstance(selected.dataDir)
  assert.equal(after.state, 'running'); assert.equal(after.record.install_root, current.coreRoot); assert.equal(after.record.instance_id, before.instance_id); assert.notEqual(after.record.generation, before.generation)
  for (const process of [before.controller, before.mm]) assert.equal(identity.sameProcess(process, identity.inspectProcess(process.pid)), false)
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'preserved across the actual pair handoff\n')
  Object.assign(report, { source_version: original.version, target_version: targetVersion, selected_pair: current.selection,
    source_exited: true, old_mm_stopped: true, target_executable_verified: true, target_main_ready: true,
    same_instance_new_generation: true, maintenance_cleared_after_real_health: true, data_preserved: true, normal_peer_policy_verified: true,
    target_health_proof: 'ordinary-main-maintenance-completion', renderer_inspected: false,
    historical_migration_tested: false, os_login_tested: false })
  success = true
} catch (error) {
  Object.assign(report, { failure_phase: phase, failure_code: error.code || 'PAIRED_HOST_ACCEPTANCE_FAILED', failure_message: String(error.message).slice(0, 512) })
  process.exitCode = 1
} finally {
  if (sourceIdentity && identity.sameProcess(sourceIdentity, identity.inspectProcess(sourceIdentity.pid))) {
    try { identity.terminateKnownProcess(sourceIdentity) } catch { process.exitCode = 1 }
  }
  if (child) { try { if (child.exitCode === null && child.signalCode === null) await once(child, 'exit', { signal: AbortSignal.timeout(10000) }) } catch { process.exitCode = 1 } }
  // Exact fresh private source/target GUI trees only; never kill by name or port.
  const guiProcesses = () => {
    const found = [], owner = identity.inspectProcess(process.pid).owner
    const roots = [selected?.guiRoot, expectedTargetGuiRoot].filter(Boolean)
    if (!roots.length) return found
    const normalize = file => process.platform === 'win32' ? path.normalize(file).toLowerCase() : path.normalize(file)
    for (const pid of identity.listProcessIds()) {
      try {
        const value = identity.inspectProcess(pid)
        if (value?.owner === owner && roots.some(root => normalize(value.executable).startsWith(normalize(root) + path.sep))) found.push(value)
      } catch { /* unrelated inaccessible or already-exited process */ }
    }
    return found
  }
  const exitDeadline = Date.now() + 10000
  let remaining = guiProcesses()
  while (remaining.length && Date.now() < exitDeadline) {
    for (const value of remaining) {
      try { if (identity.sameProcess(value, identity.inspectProcess(value.pid))) identity.terminateKnownProcess(value) }
      catch { if (identity.sameProcess(value, identity.inspectProcess(value.pid))) process.exitCode = 1 }
    }
    await sleep(100); remaining = guiProcesses()
  }
  const guiStopped = remaining.length === 0
  if (!guiStopped) process.exitCode = 1
  let stopped = !selected
  if (selected) { try { await stopInstance(selected.dataDir); stopped = inspectInstance(selected.dataDir).state === 'stopped' } catch { stopped = false; process.exitCode = 1 } }
  if (process.platform === 'darwin' && selected) {
    for (const member of [selected.guiRoot, expectedTargetGuiRoot].filter(Boolean)) {
      const application = path.join(member, 'Crabot.app')
      if (!await fs.lstat(application).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })) continue
      await promisify(execFile)('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-u', application], { timeout: 30000 }).catch(() => { process.exitCode = 1 })
    }
  }
  const diagnostics = path.join(repository, '.desktop-build/fixture-diagnostics'); await fs.mkdir(diagnostics, { recursive: true })
  await fs.writeFile(path.join(diagnostics, 'paired-update-source.log'), sourceOutput)
  report.fixture_core_stopped = stopped; report.fixture_gui_stopped = guiStopped
  if (stopped && guiStopped && success && !process.exitCode) { await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); await fs.rm(job, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); report.temporary_program_copies_removed = true }
  else report.temporary_program_copies_removed = false
  await fs.writeFile(path.join(repository, '.desktop-build/paired-update-host.json'), JSON.stringify(report, null, 2) + '\n')
  console.log('CRABOT_PAIRED_UPDATE_HOST ' + JSON.stringify(report))
}
