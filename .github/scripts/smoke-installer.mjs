import { promises as fs, createReadStream } from 'node:fs'
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
const fixture = await fs.mkdtemp(join(tmpdir(), 'ci-i-'))
const home = join(fixture, 'h 空')
const product = join(home, 'p')
const data = join(home, '.crabot/data')
await fs.mkdir(home)
const env = { ...process.env, HOME: home, USERPROFILE: home, DATA_DIR: data, CRABOT_INSTALL_DIR: product, SHELL: '/bin/bash',
  NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1', CRABOT_CI_ARCHIVE: archive,
  CRABOT_CI_PRODUCT: product, CRABOT_CI_REPO: repo }
function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: repo, env, stdio: 'inherit', ...options })
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${command} timed out`)) }, 15 * 60_000)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('exit', code => { clearTimeout(timer); code === 0 ? resolveRun() : reject(new Error(`${command} exited ${code}`)) })
  })
}
let badChecksum = false
const requests = []
const server = createServer(async (req, res) => {
  requests.push(req.url)
  if (req.url.endsWith('/releases/latest')) { res.writeHead(302, { Location: `/smilefufu/crabot/releases/tag/${version}` }); res.end(); return }
  if (req.url.includes('/releases/tag/')) { res.end(version); return }
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
async function install() {
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
& (Join-Path $env:CRABOT_CI_REPO 'install.ps1') -InstallDir $env:CRABOT_CI_PRODUCT
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
main
`)
    await run('/bin/bash', [script])
    for (const shell of ['/bin/bash', ...(process.platform === 'darwin' ? ['/bin/zsh'] : [])]) {
      await run(shell, ['-l', '-i', '-c', 'command -v crabot && crabot --help'])
    }
  }
}
let started = false
try {
  await install()
  if ((await fs.readFile(join(product, 'VERSION'), 'utf8')).trim() !== version) throw new Error('installer did not write the verified version')
  await verifyReleasePackage(product, version)
  await run(process.execPath, [join(product, 'cli.mjs'), '--help'])
  await run(process.execPath, [join(repo, '.github/scripts/smoke-scrapling.mjs'), product])
  const credentials = await import(pathToFileURL(join(product, 'crabot-admin/dist/credentials.js')).href)
  await credentials.writeCredentials(join(data, 'admin'), await credentials.newCredentialsFromPassword('fixture-install-password', { is_temp: false, changed_via: 'start' }))
  await run(process.execPath, [join(product, 'cli.mjs'), 'start', '-d'])
  started = true
  const health = await fetch('http://127.0.0.1:19000/health', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.json())
  if (health.data?.status !== 'healthy') throw new Error(`installed MM health: ${JSON.stringify(health)}`)
  await run(process.execPath, [join(product, 'cli.mjs'), 'stop'])
  started = false
  const sentinel = join(data, 'installer-sentinel')
  await fs.writeFile(sentinel, 'user-state-must-survive')
  const before = createHash('sha256').update(await fs.readFile(sentinel)).digest('hex')
  await install()
  if (createHash('sha256').update(await fs.readFile(sentinel)).digest('hex') !== before) throw new Error('reinstall changed user data')
  const proxy = join(fixture, 'fetch-proxy.mjs')
  await fs.writeFile(proxy, `const original=globalThis.fetch;globalThis.fetch=(url,options)=>{url=String(url);if(url.startsWith('https://github.com/smilefufu/crabot/'))url=process.env.CRABOT_CI_HTTP+url.slice('https://github.com'.length);return original(url,options)}`)
  await fs.writeFile(join(product, 'VERSION'), 'fixture-previous-version\n')
  await run(process.execPath, ['--import', proxy, join(product, 'cli.mjs'), 'upgrade', '--yes'])
  if ((await fs.readFile(join(product, 'VERSION'), 'utf8')).trim() !== version) throw new Error('CLI upgrade did not commit its target version')
  if (createHash('sha256').update(await fs.readFile(sentinel)).digest('hex') !== before) throw new Error('CLI upgrade changed user data')
  badChecksum = true
  let rejected = false
  try { await install() } catch { rejected = true }
  if (!rejected) throw new Error('installer accepted a damaged checksum')
  if ((await fs.readFile(join(product, 'VERSION'), 'utf8')).trim() !== version) throw new Error('failed reinstall changed version')
  if (createHash('sha256').update(await fs.readFile(sentinel)).digest('hex') !== before) throw new Error('failed reinstall changed user data')
  console.log(JSON.stringify({ platform: `${process.platform}-${process.arch}`, version, realInstaller: true, coreHealth: health.data.status, reinstallPreservesData: true, cliUpgradePreservesData: true, badChecksumRejected: true, requests: requests.length }))
} finally {
  if (started) await run(process.execPath, [join(product, 'cli.mjs'), 'stop']).catch(() => {})
  server.close()
  await fs.rm(fixture, { recursive: true, force: true })
}
