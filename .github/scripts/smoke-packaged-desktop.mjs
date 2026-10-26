// Actual packaged executable/ASAR/fuses and native bootstrap, no injected hooks.
// CI-only: the developer's live user may already own the single business MM.
import assert from 'node:assert/strict'
import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { once } from 'node:events'
if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Packaged core boot test requires an isolated CI user')
const started = performance.now()
const stage = name => console.log('CRABOT_PACKAGED_BOOT_STAGE ' + JSON.stringify({ stage: name, elapsed_ms: Math.round(performance.now() - started) }))
const project = await fs.realpath(path.resolve(process.argv[2]))
const location = JSON.parse(await fs.readFile(path.join(project, 'packaged-location.json'), 'utf8'))
function inside(relative) {
  assert.equal(typeof relative, 'string'); assert.equal(path.isAbsolute(relative), false)
  const result = path.resolve(project, relative), from = path.relative(project, result)
  assert.ok(from && from !== '..' && !from.startsWith('..' + path.sep) && !path.isAbsolute(from))
  return result
}
assert.ok([1, 2].includes(location.schema_version))
const retainedArgument = process.argv[3]
assert.ok(process.argv.length <= 4 && (retainedArgument === undefined || location.schema_version === 2 && retainedArgument.startsWith('--retained-payload=')))
const retainedPayload = retainedArgument === undefined ? undefined : await fs.realpath(retainedArgument.slice('--retained-payload='.length))
const originalExecutable = inside(location.executable), originalCore = inside(location.core)
// The native Ubuntu helper requires every installation ancestor to resist other-user writes.
const temporary = await fs.realpath(await fs.mkdtemp(path.join(process.platform === 'linux' ? homedir() : tmpdir(), 'Crabot 打包 ')))
let executable, core, data, installRoot
if (location.schema_version === 2) {
  // Programmatic backend acceptance; OS installer menus/registration are separate.
  const { prepareDesktopInstallation, commitDesktopInstallation } = await import('../../scripts/lib/desktop-payload.mjs')
  const prepared = await prepareDesktopInstallation({ payload: inside(location.payload), installRoot: path.join(temporary, '整体 安装'),
    progress: phase => console.log('CRABOT_INSTALL_PREPARATION ' + JSON.stringify({ phase })) })
  if (process.platform === 'linux') {
    const helper = path.resolve('.desktop-build/ubuntu-helper-source-probe')
    const { stdout } = await promisify(execFile)(helper, ['--inspect', prepared.installRoot], { timeout: 60_000, maxBuffer: 65536 })
    const runtime = JSON.parse(await fs.readFile(path.join(prepared.coreRoot, 'product-runtime.json'), 'utf8'))
    const headless = Object.keys(runtime.files).some(name => /\/browsers\/chromium_headless_shell-[0-9]+\/chrome-headless-shell-linux(?:64)?\/headless_shell$/.test(name))
    assert.equal(stdout.split('  userns,').length - 1, headless ? 3 : 2)
    assert.ok(stdout.endsWith('CRABOT_SANDBOX_VERIFIED\n'))
    console.log('CRABOT_PREPARED_NATIVE_ROLES_VERIFIED')
  }
  stage('pair-commit')
  const selected = await commitDesktopInstallation(prepared)
  stage('pair-committed')
  executable = selected.executable; core = selected.coreRoot; data = selected.dataDir; installRoot = selected.root
} else {
  // An app nested under the checkout can silently resolve missing dependencies.
  const platformRoot = path.dirname(process.platform === 'darwin' ? path.dirname(path.dirname(originalExecutable)) : originalExecutable)
  for (const file of [originalExecutable, originalCore]) {
    const relative = path.relative(platformRoot, file)
    assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
  }
  const relocated = path.join(temporary, path.basename(platformRoot))
  try { await fs.rename(platformRoot, relocated) }
  catch (error) {
    if (error.code !== 'EXDEV') throw error
    await fs.cp(platformRoot, relocated, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
  }
  executable = path.join(relocated, path.relative(platformRoot, originalExecutable))
  core = path.join(relocated, path.relative(platformRoot, originalCore)); data = path.join(temporary, '实例 数据')
}
const fromCheckout = path.relative(project, core)
assert.ok(path.isAbsolute(fromCheckout) || fromCheckout.startsWith('..' + path.sep))
const { verifyCoreRelease } = await import(pathToFileURL(path.join(core, 'scripts/lib/core-release.mjs')))
stage('core-verification')
await verifyCoreRelease(core)
stage('core-verified')
const env = { ...process.env, DATA_DIR: data }
delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.NODE_PATH; delete env.CRABOT_DEV; delete env.CRABOT_PORT_OFFSET
let node = path.join(core, process.platform === 'win32' ? '.product-runtime/node/node.exe' : '.product-runtime/node/bin/node')
const cliDiagnostics = []
const cli = async (...args) => {
  const result = await promisify(execFile)(node, [path.join(core, 'cli.mjs'), ...args], { env, cwd: core, timeout: 90_000, maxBuffer: 2 * 1024 * 1024 })
  cliDiagnostics.push({ command: args[0], stderr: result.stderr.slice(-32_000) })
  return result.stdout
}
// Run bundled native readers in short-lived children: Windows keeps a loaded
// DLL mapped until process exit, including when the containing app is removed.
const inspectInstance = async () => JSON.parse((await promisify(execFile)(node, ['--input-type=module', '-e',
  'import{pathToFileURL}from"node:url";const m=await import(pathToFileURL(process.argv[1]));console.log(JSON.stringify(m.inspectInstance(process.argv[2])))',
  path.join(core, 'scripts/lib/instance-runtime.mjs'), data], { env, timeout: 30_000 })).stdout)

const children = [], guiDiagnostics = []
async function waitForExit(child) {
  try {
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit', { signal: AbortSignal.timeout(30_000) })
    return { code: child.exitCode, signal: child.signalCode }
  } finally { child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy() }
}
function launch() {
  const child = spawn(executable, ['--background'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  let output = '', buffered = '', ended = false
  const phases = []
  child.once('exit', () => { ended = true })
  child.stdout.on('data', chunk => {
    const text = chunk.toString(); output = (output + text).slice(-128_000); buffered += text
    let end
    while ((end = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, end); buffered = buffered.slice(end + 1)
      try { const event = JSON.parse(line); if (event.component === 'desktop') phases.push(event) } catch {}
    }
  })
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-128_000) })
  child.on('error', error => { output += String(error); ended = true })
  async function phase(expected) {
    stage('waiting-gui-' + expected)
    // Includes full immutable payload checks, bounded 120s preflight and core boot.
    const deadline = Date.now() + 180_000
    while (Date.now() < deadline) {
      if (phases.some(event => event.phase === expected)) { stage('observed-gui-' + expected); return }
      if (ended || phases.some(event => ['error', 'migration_required'].includes(event.phase))) throw new Error('Packaged boot failed\n' + output)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('Packaged phase timed out: ' + expected + '\n' + output)
  }
  guiDiagnostics.push(() => ({ pid: child.pid, phases, output }))
  return { child, exited: () => waitForExit(child), phase }
}
try {
  let gui = launch(); await gui.phase('ready')
  const first = await inspectInstance()
  assert.equal(first.state, 'running'); assert.equal(await fs.realpath(first.record.install_root), await fs.realpath(core))
  const firstStatus = JSON.parse(await cli('status', '--json')), afterStatus = await inspectInstance()
  assert.equal(firstStatus.running, true, JSON.stringify({ cli_status: firstStatus, before_status: first, after_status: afterStatus }))
  const cliHome = path.join(temporary, '命令 用户')
  const registrationEnv = { ...env, HOME: cliHome, SHELL: process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash',
    LOCALAPPDATA: path.join(cliHome, 'AppData/Local'), PATH: process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32') : '/usr/bin:/bin' }
  delete registrationEnv.ZDOTDIR
  const registrationCode = 'import{pathToFileURL}from"node:url";import path from"node:path";const[root,dataDir,home]=process.argv.slice(1);const management=(await import(pathToFileURL(path.join(root,"scripts/lib/desktop-management.cjs")))).default;management.ensurePrivateDataRoot(home);const{installDesktopCli}=await import(pathToFileURL(path.join(root,"scripts/lib/desktop-cli-install.mjs")));console.log(JSON.stringify(await installDesktopCli({coreRoot:root,dataDir,home})))'
  const registration = JSON.parse((await promisify(execFile)(node, ['--input-type=module', '-e', registrationCode, core, data, cliHome],
    { env: registrationEnv, timeout: 90_000, maxBuffer: 2 * 1024 * 1024 })).stdout)
  const commandEnv = { ...registrationEnv, DATA_DIR: data, CRABOT_REGISTERED_CLI: registration.command }
  const registeredCliVersion = async () => {
    if (process.platform === 'win32') {
      const probe = path.join(temporary, 'registered-cli.cmd')
      await fs.writeFile(probe, '@echo off\r\ncall "%CRABOT_REGISTERED_CLI%" --version\r\nexit /b %errorlevel%\r\n')
      return (await promisify(execFile)(path.join(process.env.SystemRoot, 'System32/cmd.exe'), ['/d', '/c', probe],
        { env: commandEnv, encoding: 'utf8', timeout: 30_000 })).stdout.trim()
    }
    return (await promisify(execFile)(registration.command, ['--version'], { env: commandEnv, encoding: 'utf8', timeout: 30_000 })).stdout.trim()
  }
  const release = JSON.parse(await fs.readFile(path.join(core, 'core-release.json'), 'utf8'))
  assert.equal(await registeredCliVersion(), release.version)
  stage('registered-cli-verified')
  gui.child.kill('SIGKILL'); await gui.exited()
  assert.equal((await inspectInstance()).state, 'running')
  gui = launch(); await gui.phase('ready')
  assert.equal((await inspectInstance()).record.generation, first.record.generation)
  await cli('stop'); await gui.phase('stopped')
  assert.equal((await inspectInstance()).state, 'stopped')
  gui.child.kill('SIGKILL'); await gui.exited()
  let retainedRepair
  if (location.schema_version === 2) {
    const { prepareRetainedProductReinstall } = await import('./accept-retained-product-reinstall.mjs')
    stage('retained-program-preparation')
    retainedRepair = await prepareRetainedProductReinstall({ installRoot, payload: retainedPayload || inside(location.payload) })
    if (retainedPayload) {
      assert.notEqual(retainedRepair.selection.version, release.version)
      const originalRelease = JSON.parse(await fs.readFile(path.join(core, 'core-release.json'), 'utf8'))
      assert.notEqual(retainedRepair.selection.core_id, originalRelease.inventory_sha256)
    }
    stage('retained-programs-prepared')
    executable = retainedRepair.executable; core = retainedRepair.coreRoot
    node = path.join(core, process.platform === 'win32' ? '.product-runtime/node/node.exe' : '.product-runtime/node/bin/node')
    gui = launch(); await gui.phase('ready')
    const deadline = Date.now() + 180_000
    while (true) {
      try { await fs.lstat(path.join(data, 'desktop-maintenance.json')) }
      catch (error) { if (error.code === 'ENOENT') break; throw error }
      if (Date.now() >= deadline) throw new Error('Ordinary retained target did not complete maintenance after ready')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    stage('retained-maintenance-cleared')
    const repaired = await inspectInstance()
    assert.equal(repaired.state, 'running'); assert.equal(repaired.record.instance_id, first.record.instance_id)
    assert.notEqual(repaired.record.generation, first.record.generation)
    assert.equal(await fs.realpath(repaired.record.install_root), await fs.realpath(core))
    assert.equal(JSON.parse(await cli('status', '--json')).running, true)
    assert.equal(await registeredCliVersion(), retainedRepair.selection.version)
    assert.equal(await fs.readFile(retainedRepair.sentinel, 'utf8'), 'preserved across partial removal and real GUI recovery\n')
    await cli('stop'); await gui.phase('stopped'); gui.child.kill('SIGKILL'); await gui.exited()
    retainedRepair = { partial_removal_fixture: true, complete_uninstall_tested: false,
      ordinary_packaged_main: true, actual_core_started: true, same_instance_new_generation: true,
      maintenance_cleared_after_real_health: true, data_preserved: true, registered_cli_compatible: true, higher_version: !!retainedPayload }
  }
  console.log('CRABOT_PACKAGED_BOOT ' + JSON.stringify({ platform: process.platform, arch: process.arch,
    paired_offline_install: location.schema_version === 2, os_install_registration: false, retained_repair: retainedRepair,
    packaged_asar_native_auth: true, installed_core_shared_with_cli: true, gui_crash_preserves_core: true, reattach_same_generation: true,
    cli_stop_stays_stopped: true, unicode_spaced_data: true, outside_checkout: true, registered_bundled_cli: true, release_signed: false }))
} catch (error) {
  // The artifact uploader collects .desktop-build/*.log; the pair can be nested below it.
  // Preserve bounded fixture diagnostics without replacing the original assertion on a logging failure.
  const diagnostics = path.resolve('.desktop-build')
  try {
    await fs.mkdir(diagnostics, { recursive: true })
    await Promise.allSettled([
      ...['supervisor.boot.log', 'mm.stdout.log', 'mm.stderr.log'].map(async file => {
        const contents = await fs.readFile(path.join(data, 'logs', file)).catch(() => null)
        if (contents) await fs.writeFile(path.join(diagnostics, 'packaged-' + file), contents.subarray(-128_000))
      }),
      fs.writeFile(path.join(diagnostics, 'packaged-gui.log'), guiDiagnostics.map(read => JSON.stringify(read())).join('\n')),
      fs.writeFile(path.join(diagnostics, 'packaged-cli.log'), JSON.stringify(cliDiagnostics)),
    ])
  } catch { console.error('Packaged fixture diagnostics could not be preserved') }
  throw error
} finally {
  stage('cleanup-start')
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  const exits = await Promise.allSettled(children.map(waitForExit))
  await cli('stop')
  assert.equal((await inspectInstance()).state, 'stopped', 'Unverified processes keep their disposable data for investigation')
  for (const exit of exits) if (exit.status === 'rejected') throw exit.reason
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  stage('cleanup-completed')
}
