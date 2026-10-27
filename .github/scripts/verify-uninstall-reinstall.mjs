// CI-only ordinary Main/Core lifecycle. Only native confirmation/menu input is
// driven by a fixture; no job, stop, proof, deletion or health result is forged.
import assert from 'node:assert/strict'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { buildDesktopComponentSource } from './build-desktop-component-source.mjs'
import { verifyDesktopPayload, prepareDesktopInstallation, commitDesktopInstallation } from '../../scripts/lib/desktop-payload.mjs'
import { prepareDesktopRemovalReinstall } from '../../scripts/lib/desktop-reinstall.mjs'
import { runPreparedDesktopReinstallHandoff } from '../../scripts/lib/desktop-reinstall-data.mjs'
import { inspectInstance, identity } from '../../scripts/lib/instance-runtime.mjs'
import { stopInstance } from '../../scripts/lib/instance-controller.mjs'
import { probeKnownProcessExit } from '../../scripts/lib/known-process-exit.cjs'
import product from '../../scripts/lib/product-runtime.cjs'
import management from '../../scripts/lib/desktop-management.cjs'

if (process.env.GITHUB_ACTIONS !== 'true' || !['darwin', 'win32'].includes(process.platform)) throw new Error('Isolated macOS/Windows CI only')
const repository = path.resolve('.'), project = await fs.realpath(process.argv[2])
const location = JSON.parse(await fs.readFile(path.join(project, 'packaged-location.json'), 'utf8'))
assert.equal(location.schema_version, 2)
const payload = path.resolve(project, location.payload), target = await verifyDesktopPayload(payload)
assert.ok(path.relative(project, payload) && !path.relative(project, payload).startsWith('..'))
const needed = target.bytes * 9n + 2n * 1024n ** 3n
for (const parent of [repository, tmpdir()]) { const space = await fs.statfs(parent, { bigint: true }); assert.ok(space.bavail * space.bsize > needed) }
const temporary = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'Crabot 卸载重装 ')))
const job = path.join(repository, '.desktop-build', 'uninstall-reinstall-' + randomBytes(8).toString('hex'))
const control = management.ensurePrivateDataRoot(path.join(temporary, 'control')), home = management.ensurePrivateDataRoot(path.join(temporary, 'home'))
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'Roaming'), LOCALAPPDATA: path.join(home, 'Local') }
for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'CRABOT_DEV', 'CRABOT_PORT_OFFSET', 'WORKER_WORKSPACES_DIR']) delete env[name]
const started = performance.now(), children = []
let selected, host, registrationExecutable, targetPrepared, report, success = false, sourceOutput = ''
const stage = name => console.log('CRABOT_UNINSTALL_REINSTALL_STAGE ' + JSON.stringify({ stage: name, elapsed_ms: Math.round(performance.now() - started) }))
async function read(name) { try { return JSON.parse(await fs.readFile(path.join(control, name + '.json'), 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
async function wait(name, check, timeout = 180000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await read('driver-failed')) throw new Error('Ordinary Main driver reported an unexpected dialog')
    for (const record of children) if (record.failed || !record.ready && record.child.exitCode !== null) throw new Error('Ordinary GUI exited before ready')
    const result = await check(); if (result) return result
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Timed out: ' + name)
}
function launch(executable, launchEnv) {
  const child = spawn(executable, ['--background'], { env: launchEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  const record = { child, identity: identity.inspectProcess(child.pid), exited: once(child, 'exit'), ready: false }
  children.push(record); void record.exited.catch(() => {})
  let buffered = ''
  child.on('error', () => { record.failed = true })
  child.stderr.on('data', bytes => { sourceOutput = (sourceOutput + bytes.toString()).slice(-64000) })
  child.stdout.on('data', bytes => {
    buffered += bytes.toString(); sourceOutput = (sourceOutput + bytes.toString()).slice(-64000)
    let end
    while ((end = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, end); buffered = buffered.slice(end + 1)
      try { const event = JSON.parse(line); if (event.component === 'desktop' && event.phase === 'ready') record.ready = true } catch {}
    }
  })
  return record
}
async function absent(file) { try { await fs.lstat(file); return false } catch (error) { if (error.code === 'ENOENT') return true; throw error } }
async function register(prepared, action) {
  const file = path.join(control, 'registration-' + action + '.json')
  await fs.writeFile(file, JSON.stringify({ control, prepared, registration: action }) + '\n', { flag: 'wx', mode: 0o600 })
  await promisify(execFile)(registrationExecutable, [], { env: { ...env, CRABOT_UNINSTALL_MAIN_DRIVER: file }, timeout: 90000, maxBuffer: 128000 })
  assert.ok(await read(action === 'remove' ? 'entries-cleaned' : 'entries-restored'))
}
const shortcut = process.platform === 'darwin' ? path.join(home, 'Applications/Crabot.app') : path.join(env.APPDATA, 'Microsoft/Windows/Start Menu/Programs/Crabot.lnk')
try {
  stage('building-confirmation-driver')
  const sourcePayload = await buildDesktopComponentSource({ repository, project, destination: job, entryFixture: 'uninstall-main-driver.cjs' })
  registrationExecutable = path.join(sourcePayload, process.platform === 'darwin' ? 'gui/Crabot.app/Contents/MacOS/Crabot' : 'gui/Crabot.exe')
  const prepared = await prepareDesktopInstallation({ payload: sourcePayload, installRoot: path.join(temporary, '整体 安装') })
  selected = await commitDesktopInstallation(prepared)
  const configFile = path.join(control, 'config.json')
  await fs.writeFile(configFile, JSON.stringify({ control, prepared }) + '\n', { flag: 'wx', mode: 0o600 })
  env.DATA_DIR = selected.dataDir; env.CRABOT_UNINSTALL_MAIN_DRIVER = configFile
  stage('ordinary-source-start')
  const source = launch(selected.executable, env)
  await wait('ordinary source ready', () => source.ready)
  const first = inspectInstance(selected.dataDir); assert.equal(first.state, 'running')
  const { WorkspaceCatalog } = await import(pathToFileURL(path.join(selected.coreRoot, 'crabot-shared/dist/workspace-catalog.js')))
  const catalog = new WorkspaceCatalog({ files: identity, dataRoot: selected.dataDir }); await catalog.initialize()
  const workspace = (await catalog.snapshot()).workspaces.find(item => item.kind === 'default'); assert.ok(workspace)
  const files = [path.join(selected.dataDir, 'uninstall-acceptance.txt'), path.join(workspace.root, 'uninstall-acceptance.txt')]
  for (const file of files) await fs.writeFile(file, 'retained ordinary Main acceptance\n', { flag: 'wx', mode: 0o600 })
  await fs.writeFile(path.join(control, 'allow-remove'), '', { flag: 'wx', mode: 0o600 })
  await wait('native entries registered', () => read('entries-registered'))
  assert.equal(await absent(shortcut), false)
  stage('normal-menu-confirmed')
  host = await wait('independent maintenance role', () => read('maintenance-started'))
  assert.ok(host.identity); assert.match(path.basename(host.directory), /^crabot-removal-host-[a-f0-9-]{36}$/)
  await wait('completed native dialog', () => read('completed-dialog'), 900000)
  await source.exited
  await wait('maintenance kernel exit', () => probeKnownProcessExit([host.identity]).state === 'stopped', 30000)
  await wait('private GUI copy cleanup', () => absent(path.join(host.directory, 'gui')), 30000)
  assert.equal(inspectInstance(selected.dataDir).state, 'stopped')
  for (const file of [selected.coreRoot, selected.guiRoot, shortcut]) assert.equal(await absent(file), true)
  for (const file of files) assert.equal(await fs.readFile(file, 'utf8'), 'retained ordinary Main acceptance\n')
  const removal = JSON.parse(await fs.readFile(path.join(selected.root, '.desktop-removal.json'), 'utf8'))
  assert.equal(removal.phase, 'completed')
  stage('complete-uninstall-verified')
  await prepareDesktopRemovalReinstall({ payload, installRoot: selected.root, operationId: removal.operation_id, verifyStopped: async () => assert.equal(inspectInstance(selected.dataDir).state, 'stopped') })
  const handoff = await runPreparedDesktopReinstallHandoff({ payload, installRoot: selected.root, operationId: removal.operation_id,
    registerEntries: async prepared => { targetPrepared = prepared; await register(prepared, 'restore') } })
  stage('ordinary-target-start')
  const restored = launch(handoff.executable, env)
  await wait('ordinary retained target ready', () => restored.ready)
  await wait('actual maintenance cleared', () => absent(path.join(selected.dataDir, 'desktop-maintenance.json')))
  const after = inspectInstance(selected.dataDir)
  assert.equal(after.state, 'running'); assert.equal(after.record.instance_id, first.record.instance_id); assert.notEqual(after.record.generation, first.record.generation)
  const command = path.join(selected.root, 'bin', process.platform === 'win32' ? 'crabot.exe' : 'crabot')
  const cliVersion = await promisify(execFile)(command, ['--version'], { env, timeout: 30000, maxBuffer: 128000 })
  assert.equal(cliVersion.stdout.trim(), target.record.selection.version)
  const cliStatus = await promisify(execFile)(command, ['status', '--json'], { env, timeout: 30000, maxBuffer: 128000 })
  assert.equal(JSON.parse(cliStatus.stdout).running, true)
  const current = (await catalog.snapshot()).workspaces.find(item => item.workspace_id === workspace.workspace_id)
  assert.equal(current.root, workspace.root); assert.equal(await absent(shortcut), false)
  for (const file of files) assert.equal(await fs.readFile(file, 'utf8'), 'retained ordinary Main acceptance\n')
  const runtime = product.loadProductRuntime(path.join(selected.root, 'releases', target.record.selection.core_id), { required: true, full: true })
  const scriptFile = path.join(workspace.root, 'bundled-node-after-reinstall.txt'), pythonFile = path.join(workspace.root, 'bundled-python-after-reinstall.txt')
  await promisify(execFile)(runtime.executables.node, ['-e', 'require("node:fs").writeFileSync(process.argv[1],"bundled Node ready")', scriptFile], { env, cwd: workspace.root, timeout: 10000 })
  await promisify(execFile)(runtime.executables.python, ['-c', 'import pathlib,sys;pathlib.Path(sys.argv[1]).write_text("bundled Python ready")', pythonFile], { env, cwd: workspace.root, timeout: 10000 })
  assert.equal(await fs.readFile(scriptFile, 'utf8'), 'bundled Node ready'); assert.equal(await fs.readFile(pythonFile, 'utf8'), 'bundled Python ready')
  report = { platform: process.platform, arch: process.arch, ordinary_main_loaded: true, native_dialog_input_substituted: true, actual_core_started: true,
    complete_uninstall_lifecycle_tested: true, original_gui_and_core_removed: true, original_os_entries_removed: true, private_gui_copy_removed: true,
    retained_data_and_workspace_verified: true, ordinary_target_real_health: true, same_instance_new_generation: true, restored_os_entries: true,
    registered_native_cli_compatible: true, bundled_node_python_files_verified: true, agent_model_generation_tested: false, real_login_session_verified: false }
  success = true
} finally {
  try { if (selected && inspectInstance(selected.dataDir).state === 'running') await stopInstance(selected.dataDir) } finally {
    if (host?.identity && identity.sameProcess(host.identity, identity.inspectProcess(host.identity.pid))) process.kill(host.identity.pid, 'SIGKILL')
    for (const record of children) if (record.identity && identity.sameProcess(record.identity, identity.inspectProcess(record.identity.pid))) process.kill(record.identity.pid, 'SIGKILL')
    await Promise.allSettled(children.map(record => record.exited))
    await fs.mkdir(path.join(repository, '.desktop-build'), { recursive: true }); await fs.writeFile(path.join(repository, '.desktop-build/uninstall-reinstall.log'), sourceOutput)
    if (success) {
      await register(targetPrepared, 'remove'); assert.equal(await absent(shortcut), true)
      await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); await fs.rm(job, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      report.fixture_cleanup_verified = true
      await fs.writeFile(path.join(repository, '.desktop-build/uninstall-reinstall.json'), JSON.stringify(report) + '\n')
      console.log('CRABOT_UNINSTALL_REINSTALL ' + JSON.stringify(report))
    }
  }
}
