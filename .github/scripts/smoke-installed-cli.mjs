// Install a real sealed archive's CLI without host Node/Python/uv or network.
// Local runs never start MM. Isolated CI additionally checks real first start/stop.
// No real model provider, desktop input or real user profile is used.
import assert from 'node:assert/strict'
import { constants, promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { createConnection } from 'node:net'
import { probeMmModules } from '../../scripts/lib/mm-probe.mjs'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
if (process.platform === 'win32' && process.env.GITHUB_ACTIONS !== 'true') throw new Error('Windows PATH installation smoke requires an isolated CI user')
const execute = promisify(execFile), core = await fs.realpath(path.resolve(process.argv[2]))
const { verifyCoreRelease } = await import(pathToFileURL(path.join(core, 'scripts/lib/core-release.mjs')))
const release = await verifyCoreRelease(core)
const temporary = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'Crabot CLI 安装 ')))
const home = path.join(temporary, '用户'), installed = path.join(temporary, '程序'), data = path.join(temporary, '实例'), fakeBin = path.join(temporary, 'host-tools')
await fs.mkdir(home); await fs.mkdir(fakeBin)
await fs.writeFile(path.join(home, '.profile'), 'export CRABOT_TEST_PRESERVED=present\n')
const sentinel = path.join(temporary, 'host-tool-was-used')
for (const command of ['node', 'python', 'python3', 'uv', 'npm', 'npx', 'curl']) {
  await fs.writeFile(path.join(fakeBin, command), '#!/bin/sh\nprintf used >> "$CRABOT_TEST_HOST_SENTINEL"\nexit 88\n', { mode: 0o755 })
  await fs.writeFile(path.join(fakeBin, command + '.cmd'), '@echo off\r\necho used>>"%CRABOT_TEST_HOST_SENTINEL%"\r\nexit /b 88\r\n')
}
const windows = process.platform === 'win32', system = process.env.SystemRoot
const env = { ...process.env, HOME: home, USERPROFILE: home, DATA_DIR: data, SHELL: '/bin/bash',
  LOCALAPPDATA: path.join(home, 'AppData/Local'), APPDATA: path.join(home, 'AppData/Roaming'),
  CRABOT_TEST_HOST_SENTINEL: sentinel, HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9' }
for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'CRABOT_HOME', 'CRABOT_DEV', 'CRABOT_PORT_OFFSET', 'ZDOTDIR', 'NVM_DIR', 'BASH_ENV', 'ENV']) delete env[key]
env.PATH = [fakeBin, ...(windows ? [path.join(system, 'System32'), path.join(system, 'System32/WindowsPowerShell/v1.0')] : ['/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(path.delimiter)
const node = path.join(core, windows ? '.product-runtime/node/node.exe' : '.product-runtime/node/bin/node')
let install
if (windows) {
  const wrapper = path.join(temporary, 'install.ps1')
  await fs.writeFile(wrapper, "function global:Invoke-WebRequest { throw 'Network disabled for offline installation smoke' }\n& $env:CRABOT_TEST_INSTALLER -InstallDir $env:CRABOT_TEST_INSTALL_ROOT\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\n")
  env.CRABOT_TEST_INSTALLER = path.join(core, 'install.ps1'); env.CRABOT_TEST_INSTALL_ROOT = installed
  install = () => execute(path.join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapper],
    { env, cwd: temporary, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 })
} else install = () => execute('/bin/bash', [path.join(core, 'install.sh'), '--install-dir=' + installed], { env, cwd: temporary, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 })
const command = path.join(installed, 'bin', windows ? 'crabot.exe' : 'crabot')
let started = false, ciStartStop = false
async function stopInstalledCore() {
  await execute(command, ['stop'], { env, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 })
  await assert.rejects(fs.lstat(path.join(data, 'instance-runtime.json')), { code: 'ENOENT' })
  await assert.rejects(fs.lstat(path.join(data, 'mm.pid')), { code: 'ENOENT' })
  started = false
}
async function checkInstalledServices() {
  const deadline = Date.now() + 120_000
  let failure
  while (Date.now() < deadline) {
    try {
      const modules = await probeMmModules(19000)
      for (const id of ['admin-web', 'crabot-agent', 'memory-default']) {
        const module = modules?.find(item => item.module_id === id)
        assert.equal(module?.status, 'running', id + ' has not registered')
        const response = await fetch(`http://127.0.0.1:${module.port}/health`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) })
        const health = await response.json()
        assert.ok(response.ok && health.success === true && ['healthy', 'degraded'].includes(health.data.status), id + ' is not ready')
        if (id === 'admin-web') assert.equal(health.data.details?.web_server_running, true)
      }
      const page = await fetch('http://127.0.0.1:3000/', { signal: AbortSignal.timeout(5000) })
      assert.ok(page.ok && (await page.text()).includes('<html'))
      return
    } catch (error) { failure = error; await new Promise(resolve => setTimeout(resolve, 500)) }
  }
  throw failure
}
async function assertNoExistingCore() {
  await new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: 19000 })
    socket.once('connect', () => { socket.destroy(); reject(new Error('Existing listener preserved; refusing a second CI core')) })
    socket.once('error', error => { socket.destroy(); if (error.code === 'ECONNREFUSED') resolve(); else reject(error) })
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('Existing core state is unknown')) })
  })
}
const durations = {}
async function installPhase(phase) {
  const started = Date.now()
  console.log('CRABOT_CLI_INSTALL_PHASE ' + JSON.stringify({ phase, state: 'starting' }))
  try { return await install() }
  finally {
    durations[phase] = Date.now() - started
    console.log('CRABOT_CLI_INSTALL_PHASE ' + JSON.stringify({ phase, elapsed_ms: durations[phase] }))
  }
}
try {
  const first = await installPhase('fresh'); assert.match(first.stdout, /Core version: /)
  const id = (await fs.readFile(path.join(installed, 'current-core'), 'utf8')).trim(), payload = path.join(installed, 'releases', id)
  assert.equal((await verifyCoreRelease(payload)).inventory_sha256, id)
  await fs.writeFile(path.join(installed, '.env'), 'PRESERVED=container-environment\n')
  await installPhase('repeat')
  assert.equal(await fs.readFile(path.join(installed, '.env'), 'utf8'), 'PRESERVED=container-environment\n')
  if (process.env.GITHUB_ACTIONS === 'true') {
    await assertNoExistingCore()
    const credentialScript = 'import{pathToFileURL}from"node:url";const m=await import(pathToFileURL(process.argv[1]));await m.writeCredentials(process.argv[2],await m.newCredentialsFromPassword("isolated-cli-smoke-password",{is_temp:false,changed_via:"start"}))'
    await execute(node, ['--input-type=module', '-e', credentialScript, path.join(payload, 'crabot-admin/dist/credentials.js'), path.join(data, 'admin')], { env, timeout: 30_000 })
    started = true
    await execute(command, ['start', '-d'], { env, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 })
    await checkInstalledServices()
    await stopInstalledCore()
    await installPhase('after-stop')
    ciStartStop = true
  }
  const environment = path.join(data, 'agent-venv', 'smoke-package')
  await fs.mkdir(path.dirname(environment), { recursive: true }); await fs.writeFile(environment, 'preserved custom dependency')
  await fs.writeFile(path.join(payload, 'cli.mjs'), '// deliberately damaged installed smoke payload\n')
  await installPhase('repair')
  const retained = (await fs.readdir(path.join(installed, 'releases'))).filter(name => name.startsWith('.damaged-'))
  assert.equal(retained.length, 1)
  assert.equal(await fs.readFile(path.join(installed, 'releases', retained[0], 'cli.mjs'), 'utf8'), '// deliberately damaged installed smoke payload\n')
  assert.equal(await fs.readFile(environment, 'utf8'), 'preserved custom dependency')
  assert.equal(await fs.readFile(path.join(installed, '.env'), 'utf8'), 'PRESERVED=container-environment\n')
  await verifyCoreRelease(payload)
  assert.equal((await execute(command, ['--version'], { env, timeout: 30_000 })).stdout.trim(), release.version)
  if (!windows) {
    assert.ok((await fs.readFile(path.join(home, '.profile'), 'utf8')).startsWith('export CRABOT_TEST_PRESERVED=present\n'))
    const login = await execute('/bin/bash', ['--login', '-c', 'test "$CRABOT_TEST_PRESERVED" = present && crabot --version'], { env, timeout: 30_000 })
    assert.equal(login.stdout.trim(), release.version)
  }
  await assert.rejects(fs.lstat(sentinel), { code: 'ENOENT' })
  // Native DLLs loaded into this test process cannot be unlinked on Windows.
  // Probe with the bundled child and let it exit before removing its payload.
  const probe = 'import{pathToFileURL}from"node:url";const m=await import(pathToFileURL(process.argv[1]));console.log(JSON.stringify(m.inspectInstance(process.argv[2])))'
  const runtime = await execute(node, ['--input-type=module', '-e', probe, path.join(payload, 'scripts/lib/instance-runtime.mjs'), data], { env, timeout: 30_000 })
  assert.equal(JSON.parse(runtime.stdout).state, 'stopped')
  await assert.rejects(fs.lstat(path.join(data, 'mm.pid')), { code: 'ENOENT' })
  await verifyCoreRelease(payload); await verifyCoreRelease(core)
  console.log('CRABOT_INSTALLED_CLI ' + JSON.stringify({ platform: process.platform, arch: process.arch, version: release.version,
    duration_ms: durations, bundled_installer: true, repeated_install: true, repaired_payload: true, retained_damaged_payload: true, preserved_user_environment: true, no_host_tools: true, unchanged_payloads: true, installer_started_service: false, ci_first_start_stop: ciStartStop, no_service_started: !ciStartStop, final_stopped: true, unicode_spaced_paths: true }))
} catch (error) {
  if (process.env.GITHUB_ACTIONS === 'true') {
    // Only fixed startup logs in this disposable, provider-free CI installation.
    // Capture before cleanup so a failed first start has evidence beyond its deadline.
    for (const name of ['logs/supervisor.boot.log', 'logs/mm.stdout.log', 'logs/mm.stderr.log', 'logs/admin-web.log', 'logs/crabot-agent.log', 'logs/memory-default.log']) {
      let handle
      try {
        handle = await fs.open(path.join(data, name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        const stat = await handle.stat()
        if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) continue
        const bytes = Buffer.alloc(Math.min(stat.size, 32768))
        await handle.read(bytes, 0, bytes.length, stat.size - bytes.length)
        console.error('CRABOT_CI_INSTALLED_STARTUP_LOG ' + name + '\n' + bytes.toString('utf8').split('\n').slice(-60).join('\n'))
      } catch (probe) { console.error('CRABOT_CI_INSTALLED_STARTUP_LOG ' + name + ' ' + probe.code) }
      finally { await handle?.close().catch(() => {}) }
    }
  }
  throw error
} finally {
  if (started) await stopInstalledCore() // Never delete an unsettled fixture or kill an unverified process.
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
