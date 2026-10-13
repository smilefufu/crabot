import { promises as fs, createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { verifyReleasePackage } from '../../scripts/lib/release-package.mjs'

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const archive = resolve(process.argv[2])
const filename = archive.split(/[\\/]/).at(-1)
const version = filename.match(/^crabot-(.+)-(?:darwin|linux|windows)-(?:x64|arm64)\.(?:tar\.gz|zip)$/)?.[1]
if (!version) throw new Error(`Invalid test archive: ${filename}`)
const windows = process.platform === 'win32'
const legacyVersion = 'v2026.10.12.4'
const legacyFilename = filename.replace(version, legacyVersion)
const fixture = await fs.mkdtemp(join(tmpdir(), 'ci-i-'))
const home = join(fixture, 'h 空')
let product = join(home, windows ? '.crabot' : 'p')
const data = join(home, '.crabot/data')
await fs.mkdir(home)
const env = { ...process.env, HOME: home, USERPROFILE: home, DATA_DIR: data, CRABOT_INSTALL_DIR: product, SHELL: '/bin/bash',
  NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1', CRABOT_CI_ARCHIVE: archive,
  CRABOT_CI_PRODUCT: product, CRABOT_CI_REPO: repo }
// Test-only: capture an Admin early exit before the runtime registry attaches logs.
const startupTrace = join(fixture, 'startup-trace.mjs')
await fs.writeFile(startupTrace, `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';const original=cp.spawn;cp.spawn=(command,args,options)=>{const child=original(command,args,options);if(options?.cwd?.endsWith('crabot-admin')&&args?.includes('dist/main.js')){child.stderr?.on('data',data=>process.stderr.write('[admin early stderr] '+data));child.stdout?.on('data',data=>process.stdout.write('[admin early stdout] '+data));}return child};syncBuiltinESMExports()`)
env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} --import=${pathToFileURL(startupTrace).href}`.trim()

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: repo, env, stdio: 'inherit', ...options })
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${command} timed out`)) }, 15 * 60_000)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('exit', code => { clearTimeout(timer); code === 0 ? resolveRun() : reject(new Error(`${command} exited ${code}`)) })
  })
}
let badChecksum = false
const legacyArchive = join(fixture, legacyFilename)
const requests = []
const server = createServer(async (req, res) => {
  requests.push(req.url)
  if (req.url === '/install.ps1') { res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end(await fs.readFile(join(repo, 'install.ps1'))); return }
  if (req.url.endsWith('/releases/latest')) { res.writeHead(302, { Location: `/smilefufu/crabot/releases/tag/${version}` }); res.end(); return }
  if (req.url.includes('/releases/tag/')) { res.end(version); return }
  if (req.url.endsWith(`/${legacyFilename}.sha256`)) { res.end(await fs.readFile(`${legacyArchive}.sha256`)); return }
  if (req.url.endsWith(`/${legacyFilename}`)) { createReadStream(legacyArchive).pipe(res); return }
  if (req.url.endsWith(`/${filename}.sha256`)) {
    const sha = await fs.readFile(`${archive}.sha256`, 'utf8')
    res.end(badChecksum ? '0'.repeat(64) + (windows ? '\n' : `  ${filename}\n`) : sha); return
  }
  if (req.url.endsWith(`/${filename}`)) { createReadStream(archive).pipe(res); return }
  res.writeHead(404); res.end()
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
env.CRABOT_CI_HTTP = `http://127.0.0.1:${server.address().port}`
async function install(targetVersion = 'latest', useIex = false) {
  env.CRABOT_CI_VERSION = targetVersion
  env.CRABOT_CI_IEX = useIex ? '1' : '0'
  if (windows) {
    const script = join(fixture, 'install.ps1')
    await fs.writeFile(script, `
function Invoke-WebRequest {
  param($Uri, $OutFile, [switch]$UseBasicParsing, $MaximumRedirection = 5, $TimeoutSec = 900)
  if ([string]$Uri -like 'https://github.com/smilefufu/crabot/*') { $Uri = [string]$Uri -replace '^https://github.com', $env:CRABOT_CI_HTTP }
  $arguments = @{ Uri = $Uri; UseBasicParsing = $true; MaximumRedirection = $MaximumRedirection; TimeoutSec = $TimeoutSec }
  if ($OutFile) { $arguments.OutFile = $OutFile }
  Microsoft.PowerShell.Utility\\Invoke-WebRequest @arguments
}
if ($env:CRABOT_CI_IEX -eq '1') { Invoke-RestMethod ($env:CRABOT_CI_HTTP + '/install.ps1') | Invoke-Expression }
else { & (Join-Path $env:CRABOT_CI_REPO 'install.ps1') -InstallDir $env:CRABOT_CI_PRODUCT -Version $env:CRABOT_CI_VERSION; exit $LASTEXITCODE }
`)
    await run(process.argv[3] || 'pwsh', ['-NoProfile', '-NonInteractive', '-File', script])
  } else {
    const script = join(fixture, 'install.sh')
    await fs.writeFile(script, `
source "$CRABOT_CI_REPO/install.sh"
curl() {
  local args=() item
  for item in "$@"; do
    case "$item" in https://github.com/smilefufu/crabot/*) item="$CRABOT_CI_HTTP/\${item#https://github.com/}";; esac
    args+=("$item")
  done
  command curl "\${args[@]}"
}
CRABOT_VERSION="$CRABOT_CI_VERSION"
main
`)
    await run('/bin/bash', [script])
    for (const shell of [env.SHELL]) {
      await run(shell, ['-l', '-i', '-c', 'command -v crabot && crabot --help'])
    }
  }
}
let ownedRuntimePids = []
async function assertServicesStarted() {
  const rpc = async (port, method) => {
    const response = await fetch(`http://127.0.0.1:${port}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000),
    })
    const result = await response.json()
    if (!response.ok || result.success !== true) throw new Error(`${port}/${method}: ${JSON.stringify(result)}`)
    return result.data
  }
  // An empty instance retries its missing model configuration for 60s before degraded registration.
  const deadline = Date.now() + 120_000
  let reason
  while (Date.now() < deadline) {
    try {
      const { modules } = await rpc(19000, 'list_modules')
      for (const id of ['admin-web', 'crabot-agent', 'memory-default']) {
        const module = modules.find(item => item.module_id === id)
        if (module?.status !== 'running') throw new Error(`${id} is ${module?.status || 'missing'}`)
        const health = await rpc(module.port, 'health')
        if (!['healthy', 'degraded'].includes(health.status)) throw new Error(`${id}: ${JSON.stringify(health)}`)
        if (id === 'admin-web' && health.details?.web_server_running !== true) throw new Error('Admin Web is not running')
      }
      ownedRuntimePids = modules.filter(item => ['admin-web', 'crabot-agent', 'memory-default'].includes(item.module_id)).map(item => item.pid).filter(pid => Number.isInteger(pid) && pid > 0)
      if (ownedRuntimePids.length !== 3) throw new Error('MM did not expose all three owned module PIDs')
      const page = await fetch('http://127.0.0.1:3000/', { signal: AbortSignal.timeout(5000) })
      if (!page.ok || !(await page.text()).includes('<html')) throw new Error('Admin Web did not serve the application')
      console.log('[installer smoke] Admin Web/RPC, Agent RPC and Memory RPC are running')
      return
    } catch (error) { reason = error; await new Promise(resolve => setTimeout(resolve, 1000)) }
  }
  throw new Error(`Installed services did not start: ${reason?.message}`)
}
async function stopAndAssert() {
  await run(process.execPath, [join(product, 'cli.mjs'), 'stop'])
  const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
  const deadline = Date.now() + 10_000
  while (ownedRuntimePids.some(alive) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200))
  if (ownedRuntimePids.some(alive)) throw new Error(`stop returned with owned module processes still alive: ${ownedRuntimePids.filter(alive).join(',')}`)
  ownedRuntimePids = []
}
let started = false
try {
  for (const suffix of ['', '.sha256']) {
    const response = await fetch(`https://github.com/smilefufu/crabot/releases/download/${legacyVersion}/${legacyFilename}${suffix}`, { signal: AbortSignal.timeout(900_000) })
    if (!response.ok) throw new Error(`legacy public asset download failed: ${response.status}`)
    await pipeline(Readable.fromWeb(response.body), createWriteStream(legacyArchive + suffix))
  }
  await install('latest', windows)
  if ((await fs.readFile(join(product, 'VERSION'), 'utf8')).trim() !== version) throw new Error('installer did not write the verified version')
  await verifyReleasePackage(product, version)
  await run(process.execPath, [join(product, 'cli.mjs'), '--help'])
  await run(process.execPath, [join(repo, '.github/scripts/smoke-scrapling.mjs'), product])
  await run(process.execPath, [join(repo, '.github/scripts/test-durable-file.mjs'), product])
  const credentials = await import(pathToFileURL(join(product, 'crabot-admin/dist/credentials.js')).href)
  await credentials.writeCredentials(join(data, 'admin'), await credentials.newCredentialsFromPassword('fixture-install-password', { is_temp: false, changed_via: 'start' }))
  started = true
  await run(process.execPath, [join(product, 'cli.mjs'), 'start', '-d'])
  await assertServicesStarted()
  const health = await fetch('http://127.0.0.1:19000/health', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.json())
  if (health.data?.status !== 'healthy') throw new Error(`installed MM health: ${JSON.stringify(health)}`)
  let runningRejected = false
  try { await install() } catch { runningRejected = true }
  if (!runningRejected) throw new Error('installer did not report rejection of the running instance')
  if ((await fs.readFile(join(product, 'VERSION'), 'utf8')).trim() !== version) throw new Error('running-instance rejection changed version')
  await stopAndAssert()
  started = false
  const sentinel = join(data, 'installer-sentinel')
  await fs.writeFile(sentinel, 'user-state-must-survive')
  const before = createHash('sha256').update(await fs.readFile(sentinel)).digest('hex')
  if (process.platform === 'darwin') env.SHELL = '/bin/zsh'
  await install()
  if (createHash('sha256').update(await fs.readFile(sentinel)).digest('hex') !== before) throw new Error('reinstall changed user data')
  const proxy = join(fixture, 'fetch-proxy.mjs')
  await fs.writeFile(proxy, `const original=globalThis.fetch;globalThis.fetch=(url,options)=>{url=String(url);if(url.startsWith('https://github.com/smilefufu/crabot/'))url=process.env.CRABOT_CI_HTTP+url.slice('https://github.com'.length);return original(url,options)}`)
  await fs.writeFile(join(product, 'VERSION'), 'fixture-previous-version\n')
  await run(process.execPath, ['--import', pathToFileURL(proxy).href, join(product, 'cli.mjs'), 'upgrade', '--yes'])
  if ((await fs.readFile(join(product, 'VERSION'), 'utf8')).trim() !== version) throw new Error('CLI upgrade did not commit its target version')
  if (createHash('sha256').update(await fs.readFile(sentinel)).digest('hex') !== before) throw new Error('CLI upgrade changed user data')
  // Invoke the actual UI runner; use its status file and core health as evidence.
  await fs.writeFile(join(product, 'VERSION'), 'fixture-before-ui-upgrade\n')
  started = true
  await run(process.execPath, ['--import', pathToFileURL(proxy).href, join(product, 'scripts/ui-upgrade.mjs')])
  const uiStatus = JSON.parse(await fs.readFile(join(data, 'admin/upgrade-status.json'), 'utf8'))
  if (uiStatus.phase !== 'done' || uiStatus.to_version !== version) throw new Error(`UI upgrade failed: ${JSON.stringify(uiStatus)}`)
  await assertServicesStarted()
  const uiHealth = await fetch('http://127.0.0.1:19000/health', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.json())
  if (uiHealth.data?.status !== 'healthy') throw new Error(`UI upgrade core health: ${JSON.stringify(uiHealth)}`)
  await stopAndAssert()
  started = false
  // Main installer must accept the real old public package without future Cua helpers.
  product = join(home, 'old')
  env.CRABOT_CI_PRODUCT = product
  env.CRABOT_INSTALL_DIR = product
  await install(legacyVersion)
  await verifyReleasePackage(product, legacyVersion)
  await run(process.execPath, [join(product, 'cli.mjs'), '--help'])
  if (windows) {
    // The shipped old Windows CLI is immutable; verify its rejected path and installer repair.
    let oldCliRejected = false
    try { await run(process.execPath, ['--import', pathToFileURL(proxy).href, join(product, 'cli.mjs'), 'upgrade', '--yes']) } catch { oldCliRejected = true }
    if (!oldCliRejected) throw new Error('expected the old Windows CLI to reject its unsupported platform')
    await install()
  } else {
    await run(process.execPath, ['--import', pathToFileURL(proxy).href, join(product, 'cli.mjs'), 'upgrade', '--yes'])
  }
  if ((await fs.readFile(join(product, 'VERSION'), 'utf8')).trim() !== version) throw new Error('legacy recovery did not commit target version')
  if (createHash('sha256').update(await fs.readFile(sentinel)).digest('hex') !== before) throw new Error('legacy installation/upgrade changed user data')
  started = true
  await run(process.execPath, [join(product, 'cli.mjs'), 'start', '-d'])
  await assertServicesStarted()
  await stopAndAssert()
  started = false
  badChecksum = true
  let rejected = false
  try { await install() } catch { rejected = true }
  if (!rejected) throw new Error('installer accepted a damaged checksum')
  if ((await fs.readFile(join(product, 'VERSION'), 'utf8')).trim() !== version) throw new Error('failed reinstall changed version')
  if (createHash('sha256').update(await fs.readFile(sentinel)).digest('hex') !== before) throw new Error('failed reinstall changed user data')
  if (!process.env.CRABOT_CI_SKIP_SOURCE) {
    if (windows) {
      await run(process.argv[3] || 'pwsh', ['-NoProfile', '-NonInteractive', '-File', join(repo, 'install.ps1'), '-FromSource'])
    } else {
      await run('/bin/bash', [join(repo, 'install.sh'), '--from-source'])
    }
    await run(process.execPath, [join(repo, 'cli.mjs'), '--help'])
  }
  console.log(JSON.stringify({ platform: `${process.platform}-${process.arch}`, version, realInstaller: true, initialEntry: windows ? "irm|iex" : "bash", coreHealth: health.data.status, runningReinstallRejected: true, reinstallPreservesData: true, cliUpgradePreservesData: true, uiUpgradeStatus: uiStatus.phase, realLegacyPackageInstalled: legacyVersion, legacyRecoveryPreservesData: true, badChecksumRejected: true, requests: requests.length }))
} catch (error) {
  console.error(`Installer acceptance failed: ${error.message}`)
  for (const name of ['supervisor.boot.log', 'mm.stderr.log', 'mm.stdout.log']) {
    try { console.error(`${name}:\n${(await fs.readFile(join(data, 'logs', name), 'utf8')).slice(-12000)}`) } catch {}
  }
  throw error
} finally {
  if (started) await run(process.execPath, [join(product, 'cli.mjs'), 'stop']).catch(() => {})
  if (windows) {
    for (const pid of ownedRuntimePids) await run('taskkill.exe', ['/pid', String(pid), '/t', '/f']).catch(() => {})
    for (const name of ['mm.pid']) {
      try {
        const pid = Number((await fs.readFile(join(data, name), 'utf8')).trim())
        if (Number.isInteger(pid) && pid > 0) await run('taskkill.exe', ['/pid', String(pid), '/t', '/f']).catch(() => {})
      } catch {}
    }
  }
  server.close()
  const cleanupTimer = setTimeout(() => { console.error(`Fixture cleanup timed out: ${fixture}`); process.exit(1) }, 60_000)
  cleanupTimer.unref()
  try { await fs.rm(fixture, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 }) } finally { clearTimeout(cleanupTimer) }
}
