// Install a real sealed archive's CLI without host Node/Python/uv or network.
// No business MM, model provider, desktop input or real user profile is used.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
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
try {
  const first = await install(); assert.match(first.stdout, /Core version: /)
  const id = (await fs.readFile(path.join(installed, 'current-core'), 'utf8')).trim(), payload = path.join(installed, 'releases', id)
  assert.equal((await verifyCoreRelease(payload)).inventory_sha256, id)
  await fs.writeFile(path.join(installed, '.env'), 'PRESERVED=container-environment\n')
  await install()
  assert.equal(await fs.readFile(path.join(installed, '.env'), 'utf8'), 'PRESERVED=container-environment\n')
  const command = path.join(installed, 'bin', windows ? 'crabot.exe' : 'crabot')
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
    bundled_installer: true, repeated_install: true, no_host_tools: true, unchanged_payloads: true, no_service_started: true, unicode_spaced_paths: true }))
} finally { await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
