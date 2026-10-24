// Isolated CI component-to-product acceptance. The source actor loads the real
// ASAR without enabling its candidate channel; the target runs ordinary main.
import assert from 'node:assert/strict'
import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { randomUUID, generateKeyPairSync } from 'node:crypto'
import { runBounded } from '../../scripts/lib/run-bounded.mjs'
import { verifyCoreRelease, writeCoreRelease } from '../../scripts/lib/core-release.mjs'
import { verifyDesktopPayload, prepareDesktopInstallation, commitDesktopInstallation } from '../../scripts/lib/desktop-payload.mjs'
import { writeSignedDesktopPayload } from '../../scripts/desktop/sign-release.mjs'
import { inspectInstance, identity } from '../../scripts/lib/instance-runtime.mjs'
import { stopInstance } from '../../scripts/lib/instance-controller.mjs'
import product from '../../scripts/lib/product-runtime.cjs'

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
const needed = verified.bytes * 5n + 1024n ** 3n, space = await fs.statfs(repository, { bigint: true })
const temporarySpace = await fs.statfs(tmpdir(), { bigint: true })
if (space.bavail * space.bsize < needed || temporarySpace.bavail * temporarySpace.bsize < verified.bytes * 4n + 1024n ** 3n) throw Object.assign(new Error('Whole update fixture needs bounded program-copy space'), { code: 'CRABOT_UPDATE_SPACE' })
const job = path.join(repository, '.desktop-build', 'paired-update-' + randomUUID()), temporary = await fs.mkdtemp(path.join(tmpdir(), 'Crabot 更新 '))
await fs.mkdir(job, { mode: 0o700 }); const control = path.join(temporary, 'control'), home = path.join(temporary, 'home')
await fs.mkdir(control, { mode: 0o700 }); await fs.mkdir(home, { mode: 0o700 })
let selected, child, browser, page, targetIdentity, sourceIdentity, expectedTargetGuiRoot, phase = 'prepare-target', success = false, sourceOutput = ''
const report = { platform: process.platform, arch: process.arch, candidate_channel_enabled: false, remote_model_called: false,
  source_gui: 'real-asar-component-actor', target_gui: 'ordinary-packaged-main', fixture_debugger: true, real_login_session_verified: false }
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
async function cdp(url) {
  const endpoint = new URL(url); assert.equal(endpoint.protocol, 'ws:'); assert.equal(endpoint.hostname, '127.0.0.1')
  const socket = new WebSocket(url), pending = new Map(); let id = 0
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('Debugger connection timed out')) }, 5000)
    socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Debugger connection failed')) }, { once: true })
  })
  socket.addEventListener('message', event => { const value = JSON.parse(String(event.data)), call = pending.get(value.id); if (!call) return
    pending.delete(value.id); clearTimeout(call.timer); value.error ? call.reject(new Error('Debugger command failed')) : call.resolve(value.result) })
  socket.addEventListener('close', () => { for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('Debugger closed')) }; pending.clear() })
  return { send: (method, params = {}) => new Promise((resolve, reject) => { const next = ++id, timer = setTimeout(() => { pending.delete(next); reject(new Error('Debugger command timed out')) }, 5000); pending.set(next, { resolve, reject, timer }); socket.send(JSON.stringify({ id: next, method, params })) }),
    close: () => socket.close() }
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
  phase = 'prepare-source'
  selected = await commitDesktopInstallation(await prepareDesktopInstallation({ payload, installRoot: path.join(temporary, '整体 安装') }))
  expectedTargetGuiRoot = path.join(selected.root, 'app/releases', target.record.selection.gui_id)
  const sentinel = path.join(selected.dataDir, 'update-fixture-preserved.txt'); await fs.writeFile(sentinel, 'preserved across the actual pair handoff\n')
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const debugPort = server.address().port; await new Promise(resolve => server.close(resolve))
  const metadata = { source: selected, home, control, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), publication,
    manifestName: path.basename(signed.manifestFile), signaturesName: path.basename(signed.signaturesFile), artifactName: path.basename(signed.artifact), targetVersion, debugPort }
  const config = path.join(control, 'config.json'); await fs.writeFile(config, JSON.stringify(metadata) + '\n', { mode: 0o600 })
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'Roaming'), LOCALAPPDATA: path.join(home, 'Local'), DATA_DIR: selected.dataDir, GIT_ALLOW_PROTOCOL: 'file' }
  for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'CRABOT_DEV', 'CRABOT_PORT_OFFSET']) delete env[name]
  phase = 'source-start-and-update'
  const require = createRequire(path.join(repository, 'crabot-desktop/package.json'))
  child = spawn(require('electron'), [path.join(repository, 'crabot-desktop/tests/fixtures/paired-update-source.cjs'), config], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { sourceOutput = (sourceOutput + bytes.toString()).slice(-128000) })
  child.on('error', error => { sourceOutput += String(error) })
  sourceIdentity = await poll('source actor identity', async () => identity.inspectProcess(child.pid), 10000)
  const before = await poll('source ready', () => readControl('source-ready'))
  const handoff = await poll('committed target handoff', () => readControl('handoff'), 420000)
  assert.deepEqual(handoff.target, target.record.selection); assert.equal(handoff.ordinary_exits, 0); assert.equal(handoff.requests, 3)
  phase = 'target-start-and-health'
  const version = await poll('target debugger', async () => { try { return await (await fetch('http://127.0.0.1:' + debugPort + '/json/version', { signal: AbortSignal.timeout(2000) })).json() } catch { return null } })
  browser = await cdp(version.webSocketDebuggerUrl)
  const processes = await browser.send('SystemInfo.getProcessInfo'), gui = processes.processInfo.find(value => value.type === 'browser')
  assert.ok(gui); targetIdentity = identity.inspectProcess(gui.id); assert.ok(targetIdentity)
  const installation = createRequire(import.meta.url)('../../scripts/lib/desktop-installation.cjs'), current = installation.readDesktopSelection(selected.root)
  assert.equal(await fs.realpath(targetIdentity.executable), await fs.realpath(current.executable))
  assert.equal(identity.sameProcess(sourceIdentity, identity.inspectProcess(sourceIdentity.pid)), false)
  const pages = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list', { signal: AbortSignal.timeout(5000) })).json(), targetPage = pages.find(value => value.type === 'page' && value.url.startsWith('app://crabot/'))
  assert.ok(targetPage); page = await cdp(targetPage.webSocketDebuggerUrl)
  const ready = await poll('ordinary target main ready', async () => {
    const value = await page.send('Runtime.evaluate', { expression: '(async()=>({state:await window.crabotDesktop.getState(),node:typeof require,token:window.crabotDesktop.token??null}))()', awaitPromise: true, returnByValue: true })
    if (value.exceptionDetails) return null
    const result = value.result.value
    if (['error', 'migration_required'].includes(result.state.phase)) throw new Error('Target main refused startup: ' + result.state.code)
    return result.state.phase === 'ready' ? result : null
  })
  assert.equal(ready.node, 'undefined'); assert.equal(ready.token, null); assert.equal(ready.state.app_version, targetVersion)
  assert.equal(ready.state.instance_id, before.instance_id); assert.notEqual(ready.state.generation, before.generation)
  const after = inspectInstance(selected.dataDir)
  assert.equal(after.state, 'running'); assert.equal(after.record.install_root, current.coreRoot); assert.equal(after.record.generation, ready.state.generation)
  for (const process of [before.controller, before.mm]) assert.equal(identity.sameProcess(process, identity.inspectProcess(process.pid)), false)
  await poll('post-health maintenance completion', async () => {
    try { await fs.stat(path.join(selected.dataDir, 'desktop-maintenance.json')); return false }
    catch (error) { if (error.code === 'ENOENT') return true; throw error }
  })
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'preserved across the actual pair handoff\n')
  Object.assign(report, { source_version: original.version, target_version: targetVersion, selected_pair: current.selection,
    source_exited: true, old_mm_stopped: true, target_executable_verified: true, target_main_ready: true,
    same_instance_new_generation: true, maintenance_cleared_after_real_health: true, data_preserved: true, renderer_token_absent: true,
    historical_migration_tested: false, os_login_tested: false })
  success = true
} catch (error) {
  Object.assign(report, { failure_phase: phase, failure_code: error.code || 'PAIRED_HOST_ACCEPTANCE_FAILED', failure_message: String(error.message).slice(0, 512) })
  process.exitCode = 1
} finally {
  page?.close(); browser?.close()
  if (sourceIdentity && identity.sameProcess(sourceIdentity, identity.inspectProcess(sourceIdentity.pid))) {
    try { identity.terminateKnownProcess(sourceIdentity) } catch { process.exitCode = 1 }
  }
  if (child) { try { if (child.exitCode === null && child.signalCode === null) await once(child, 'exit', { signal: AbortSignal.timeout(10000) }) } catch { process.exitCode = 1 } }
  // Exact fresh private GUI tree only; never use names, ports or a broad kill.
  const guiProcesses = () => {
    const found = [], owner = identity.inspectProcess(process.pid).owner
    if (!expectedTargetGuiRoot) return found
    const normalize = file => process.platform === 'win32' ? path.normalize(file).toLowerCase() : path.normalize(file)
    for (const pid of identity.listProcessIds()) {
      try {
        const value = identity.inspectProcess(pid)
        if (value?.owner === owner && normalize(value.executable).startsWith(normalize(expectedTargetGuiRoot) + path.sep)) found.push(value)
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
