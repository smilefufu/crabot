// Actual packaged executable/ASAR/fuses and native bootstrap, no injected hooks.
// CI-only: the developer's live user may already own the single business MM.
import assert from 'node:assert/strict'
import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { once } from 'node:events'
if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Packaged core boot test requires an isolated CI user')
const project = await fs.realpath(path.resolve(process.argv[2]))
const location = JSON.parse(await fs.readFile(path.join(project, 'packaged-location.json'), 'utf8'))
function inside(relative) {
  assert.equal(typeof relative, 'string'); assert.equal(path.isAbsolute(relative), false)
  const result = path.resolve(project, relative), from = path.relative(project, result)
  assert.ok(from && from !== '..' && !from.startsWith('..' + path.sep) && !path.isAbsolute(from))
  return result
}
assert.equal(location.schema_version, 1)
const originalExecutable = inside(location.executable), originalCore = inside(location.core)
// An app nested under the checkout can silently resolve missing dependencies
// from ancestor node_modules. Run the exact candidate outside that tree.
const platformRoot = path.dirname(process.platform === 'darwin'
  ? path.dirname(path.dirname(originalExecutable)) : originalExecutable)
for (const file of [originalExecutable, originalCore]) {
  const relative = path.relative(platformRoot, file)
  assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
}
const temporary = await fs.mkdtemp(path.join(tmpdir(), 'Crabot 打包 '))
const relocated = path.join(temporary, path.basename(platformRoot))
try { await fs.rename(platformRoot, relocated) }
catch (error) {
  if (error.code !== 'EXDEV') throw error
  await fs.cp(platformRoot, relocated, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
}
const executable = path.join(relocated, path.relative(platformRoot, originalExecutable))
const core = path.join(relocated, path.relative(platformRoot, originalCore))
const fromCheckout = path.relative(project, core)
assert.ok(path.isAbsolute(fromCheckout) || fromCheckout.startsWith('..' + path.sep))
const { verifyCoreRelease } = await import(pathToFileURL(path.join(core, 'scripts/lib/core-release.mjs')))
await verifyCoreRelease(core)
const data = path.join(temporary, '实例 数据')
const env = { ...process.env, DATA_DIR: data }
delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.NODE_PATH; delete env.CRABOT_DEV; delete env.CRABOT_PORT_OFFSET
const node = path.join(core, process.platform === 'win32' ? '.product-runtime/node/node.exe' : '.product-runtime/node/bin/node')
const cli = async (...args) => (await promisify(execFile)(node, [path.join(core, 'cli.mjs'), ...args], { env, cwd: core, timeout: 90_000, maxBuffer: 2 * 1024 * 1024 })).stdout
// Run bundled native readers in short-lived children: Windows keeps a loaded
// DLL mapped until process exit, including when the containing app is removed.
const inspectInstance = async () => JSON.parse((await promisify(execFile)(node, ['--input-type=module', '-e',
  'import{pathToFileURL}from"node:url";const m=await import(pathToFileURL(process.argv[1]));console.log(JSON.stringify(m.inspectInstance(process.argv[2])))',
  path.join(core, 'scripts/lib/instance-runtime.mjs'), data], { env, timeout: 30_000 })).stdout)

const children = []
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
    // Includes full immutable payload checks, bounded 120s preflight and core boot.
    const deadline = Date.now() + 180_000
    while (Date.now() < deadline) {
      if (phases.some(event => event.phase === expected)) return
      if (ended || phases.some(event => ['error', 'migration_required'].includes(event.phase))) throw new Error('Packaged boot failed\n' + output)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('Packaged phase timed out: ' + expected + '\n' + output)
  }
  return { child, exited: () => waitForExit(child), phase }
}
try {
  let gui = launch(); await gui.phase('ready')
  const first = await inspectInstance()
  assert.equal(first.state, 'running'); assert.equal(await fs.realpath(first.record.install_root), await fs.realpath(core))
  assert.equal(JSON.parse(await cli('status', '--json')).running, true)
  const cliHome = path.join(temporary, '命令 用户')
  const registrationEnv = { ...env, HOME: cliHome, SHELL: process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash',
    LOCALAPPDATA: path.join(cliHome, 'AppData/Local'), PATH: process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32') : '/usr/bin:/bin' }
  delete registrationEnv.ZDOTDIR
  const registrationCode = 'import{pathToFileURL}from"node:url";import path from"node:path";const[root,dataDir,home]=process.argv.slice(1);const management=(await import(pathToFileURL(path.join(root,"scripts/lib/desktop-management.cjs")))).default;management.ensurePrivateDataRoot(home);const{installDesktopCli}=await import(pathToFileURL(path.join(root,"scripts/lib/desktop-cli-install.mjs")));console.log(JSON.stringify(await installDesktopCli({coreRoot:root,dataDir,home})))'
  const registration = JSON.parse((await promisify(execFile)(node, ['--input-type=module', '-e', registrationCode, core, data, cliHome],
    { env: registrationEnv, timeout: 90_000, maxBuffer: 2 * 1024 * 1024 })).stdout)
  const commandEnv = { ...registrationEnv, DATA_DIR: data, CRABOT_REGISTERED_CLI: registration.command }
  let registeredVersion
  if (process.platform === 'win32') {
    const probe = path.join(temporary, 'registered-cli.cmd')
    await fs.writeFile(probe, '@echo off\r\ncall "%CRABOT_REGISTERED_CLI%" --version\r\nexit /b %errorlevel%\r\n')
    registeredVersion = (await promisify(execFile)(path.join(process.env.SystemRoot, 'System32/cmd.exe'), ['/d', '/c', probe],
      { env: commandEnv, encoding: 'utf8', timeout: 30_000 })).stdout.trim()
  } else registeredVersion = (await promisify(execFile)(registration.command, ['--version'], { env: commandEnv, encoding: 'utf8', timeout: 30_000 })).stdout.trim()
  const release = JSON.parse(await fs.readFile(path.join(core, 'core-release.json'), 'utf8'))
  assert.equal(registeredVersion, release.version)
  gui.child.kill('SIGKILL'); await gui.exited()
  assert.equal((await inspectInstance()).state, 'running')
  gui = launch(); await gui.phase('ready')
  assert.equal((await inspectInstance()).record.generation, first.record.generation)
  await cli('stop'); await gui.phase('stopped')
  assert.equal((await inspectInstance()).state, 'stopped')
  gui.child.kill('SIGKILL'); await gui.exited()
  console.log('CRABOT_PACKAGED_BOOT ' + JSON.stringify({ platform: process.platform, arch: process.arch,
    packaged_asar_native_auth: true, installed_core_shared_with_cli: true, gui_crash_preserves_core: true, reattach_same_generation: true,
    cli_stop_stays_stopped: true, unicode_spaced_data: true, outside_checkout: true, registered_bundled_cli: true, release_signed: false }))
} catch (error) {
  for (const file of ['supervisor.boot.log', 'mm.stdout.log', 'mm.stderr.log']) {
    const contents = await fs.readFile(path.join(data, 'logs', file)).catch(() => null)
    if (contents) await fs.writeFile(path.join(path.dirname(project), 'packaged-' + file), contents.subarray(-128_000))
  }
  throw error
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  const exits = await Promise.allSettled(children.map(waitForExit))
  await cli('stop')
  assert.equal((await inspectInstance()).state, 'stopped', 'Unverified processes keep their disposable data for investigation')
  for (const exit of exits) if (exit.status === 'rejected') throw exit.reason
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
