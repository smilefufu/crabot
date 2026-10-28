import { it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { spawnSync, spawn } from 'node:child_process'
import { acquireCliLock, releaseCliLock } from '../../lib/cli-lock.mjs'
const product = fileURLToPath(new URL('../../../', import.meta.url))
let root, data, home
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'upgrade-entry-'))
  data = path.join(root, 'data'); home = path.join(root, 'product')
  await fs.mkdir(data); await fs.mkdir(path.join(home, 'scripts'), { recursive: true })
})
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })
async function write(name, bytes) { await fs.mkdir(path.dirname(path.join(home, name)), { recursive: true }); await fs.writeFile(path.join(home, name), bytes) }
const env = () => ({ ...process.env, DATA_DIR: data, CRABOT_CLI_LOCK_HELD: '', CRABOT_CLI_LOCK_OWNER: '', CRABOT_ORPHAN_RECOVERY_INTERACTIVE: '0' })
async function scripts() {
  for (const name of ['lib', 'upgrade-lib']) await fs.cp(path.join(product, 'scripts', name), path.join(home, 'scripts', name), { recursive: true, filter: source => !['node_modules', '__tests__'].includes(path.basename(source)) })
  await fs.mkdir(path.join(home, 'scripts/desktop'), { recursive: true })
  for (const name of ['legacy-releases.json', 'legacy-python-bootstrap.json']) await fs.copyFile(path.join(product, 'scripts/desktop', name), path.join(home, 'scripts/desktop', name))
  await fs.symlink(path.join(product, 'node_modules'), path.join(home, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  await fs.mkdir(path.join(home, 'crabot-native/build/Release'), { recursive: true })
  await fs.copyFile(path.join(product, 'crabot-native/build/Release/crabot-native.node'), path.join(home, 'crabot-native/build/Release/crabot-native.node'))
  await write('scripts/lib/instance.mjs', 'export const resolveCliDataDir = () => process.env.DATA_DIR; export const hasInstance = () => true')
  await write('scripts/lib/node_modules/proper-lockfile/index.js', 'module.exports = {}')
  await write('scripts/lib/scrapling-runtime.cjs', 'module.exports = { runtimeRequired() { return false } }')
  await write('scripts/_preflight.mjs', '// dependencies are prepared in this isolated fixture')
  await write('scripts/lib/mode.mjs', "export const detectMode = () => 'user'")
  await write('cli.mjs', `import fs from 'node:fs'; import path from 'node:path'; const file=path.join(process.env.DATA_DIR,'calls.json'); const calls=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):[]; calls.push(process.argv[2]); fs.writeFileSync(file,JSON.stringify(calls));`)
  for (const name of ['crabot-core/dist/main.js', 'crabot-core/dist/orphan-recovery-preflight.js', 'crabot-admin/dist/main.js', 'crabot-agent/dist/main.js']) await write(name, '// finite fixture; must not spawn')
  await fs.copyFile(path.join(product, 'scripts/prepare-shared-requests.mjs'), path.join(home, 'scripts/prepare-shared-requests.mjs'))
}
async function invalidLedger() {
  const file = path.join(data, 'agent/worker-ledgers/bad.json')
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, '{"schema_version":99}')
}
it.skipIf(process.env.GITHUB_ACTIONS !== 'true')('actual compiled direct MM rejects corrupt data before its PID, venv or ingress can be created', async () => {
  await invalidLedger()
  const result = spawnSync(process.execPath, [path.join(product, 'crabot-core/dist/main.js')], { cwd: path.join(product, 'crabot-core'), env: { ...env(), PORT: '0' }, encoding: 'utf8', timeout: 10000 })
  expect(result.status).toBe(1)
  expect(result.stdout + result.stderr).toContain('Unsupported ledger envelope')
  expect(result.stdout).not.toContain('Module Manager starting')
  await expect(fs.stat(path.join(data, 'mm.pid'))).rejects.toThrow()
  await expect(fs.stat(path.join(data, 'agent-venv'))).rejects.toThrow()
})
it('CLI start fallback rejects corrupt migration data before spawning MM or writing a live PID', async () => {
  await scripts(); await invalidLedger()
  await write('crabot-agent/shared_request_version', '1')
  await write('crabot-admin/dist/credentials.js', 'exports.readCredentials = async () => ({}); exports.writeCredentials = async () => { throw new Error("unexpected credential write") }; exports.newCredentialsFromPassword = () => {};')
  await fs.copyFile(path.join(product, 'scripts/start.mjs'), path.join(home, 'scripts/start.mjs'))
  const port = await new Promise(resolve => { const socket = net.createServer(); socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)) }) })
  const result = spawnSync(process.execPath, [path.join(home, 'scripts/start.mjs'), '-d'], { cwd: home, env: { ...env(), CRABOT_PORT_OFFSET: String(port - 19000) }, encoding: 'utf8', timeout: 10000 })
  expect(result.status, result.stderr).toBe(1)
  expect(result.stdout + result.stderr).toContain('Unsupported ledger envelope')
  expect(result.stdout).not.toContain('Starting in background')
  await expect(fs.stat(path.join(data, 'mm.pid'))).rejects.toThrow()
})
it('actual restart entry never invokes stop when target migration scope is not ready', async () => {
  await scripts()
  await write('crabot-core/schema_version', 'v2')
  await fs.mkdir(path.join(data, 'core')); await fs.writeFile(path.join(data, 'core/SCHEMA_VERSION'), 'v1')
  await fs.copyFile(path.join(product, 'scripts/restart.mjs'), path.join(home, 'scripts/restart.mjs'))
  const result = spawnSync(process.execPath, [path.join(home, 'scripts/restart.mjs')], { cwd: home, env: env(), encoding: 'utf8', timeout: 10000 })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('Missing migration scope')
  await expect(fs.stat(path.join(data, 'calls.json'))).rejects.toThrow()
})
it('actual Web upgrade entry leaves the running build alone when isolated preparation fails', async () => {
  await scripts()
  await write('scripts/upgrade-lib/prepared-upgrade.mjs', 'export async function prepareUpgrade() { throw new Error("fixture preparation failure") }; export async function installPreparedUpgrade() { throw new Error("unexpected switch") }')
  await write('scripts/upgrade-lib/release.mjs', 'export const stageRelease=async()=>{throw new Error("unexpected staging")};export const downloadRelease=async()=>{throw new Error("unexpected download")};export const getReleaseUrls=()=>({});export const getCurrentVersion = () => null; export const getLatestVersion = async () => ({tag:"next"}); export const writeVersionFile = () => { throw new Error("unexpected version write") }')
  await write('dist/live.js', 'old build')
  await fs.copyFile(path.join(product, 'scripts/ui-upgrade.mjs'), path.join(home, 'scripts/ui-upgrade.mjs'))
  const result = spawnSync(process.execPath, [path.join(home, 'scripts/ui-upgrade.mjs')], { cwd: home, env: env(), encoding: 'utf8', timeout: 10000 })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('fixture preparation failure')
  expect(await fs.readFile(path.join(home, 'dist/live.js'), 'utf8')).toBe('old build')
  await expect(fs.stat(path.join(data, 'calls.json'))).rejects.toThrow()
})

it('foreground start releases only its startup lock after MM health, while its own process stays alive', async () => {
  await scripts()
  await write('crabot-admin/dist/credentials.js', 'exports.readCredentials = async () => ({}); exports.writeCredentials = async () => {}; exports.newCredentialsFromPassword = () => {};')
  await fs.copyFile(path.join(product, 'scripts/start.mjs'), path.join(home, 'scripts/start.mjs'))
  const port = await new Promise(resolve => { const socket = net.createServer(); socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)) }) })
  await write('crabot-core/dist/main.js', `const http=require('node:http'); const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({success:true,data:{status:'healthy'}}))}); server.listen(${port},'127.0.0.1'); process.on('message', message => { if(message?.type==='crabot-shutdown')server.close(()=>process.exit(0)) });`)
  const child = spawn(process.execPath, [path.join(home, 'scripts/start.mjs')], { cwd: home, env: { ...env(), CRABOT_PORT_OFFSET: String(port - 19000) }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
  const exited = new Promise(resolve => child.on('close', resolve))
  try {
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      const pid = await fs.readFile(path.join(data, 'mm.pid'), 'utf8').catch(() => '')
      const locked = await acquireCliLock(data, 'probe', 0).then(lock => { releaseCliLock(lock); return false }, () => true)
      if (pid && !locked) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(child.exitCode, output).toBeNull()
    expect(await fs.readFile(path.join(data, 'mm.pid'), 'utf8')).toBe(String(child.pid))
    const available = await acquireCliLock(data, 'probe', 0); releaseCliLock(available)
    await fs.writeFile(path.join(data, 'mm.pid'), '2147483000')
  } finally { child.kill('SIGTERM'); await exited }
  expect(await fs.readFile(path.join(data, 'mm.pid'), 'utf8')).toBe('2147483000')
}, 12000)

it.skipIf(process.env.GITHUB_ACTIONS !== 'true')('actual compiled MM releases startup ownership after ingress and its exit preserves later lock/PID evidence', async () => {
  await scripts()
  await fs.cp(path.join(product, 'crabot-core/dist'), path.join(home, 'crabot-core/dist'), { recursive: true })
  await fs.symlink(path.join(product, 'crabot-core/node_modules'), path.join(home, 'crabot-core/node_modules'), 'dir')
  // Limit this main-entry test to MM lifecycle; independent core-module and venv tests cover those.
  await write('crabot-core/dist/core-modules.js', 'exports.buildCoreModules = () => []')
  await write('crabot-core/dist/agent-venv.js', 'exports.ensureAgentVenv = () => null')
  const port = await new Promise(resolve => { const socket = net.createServer(); socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)) }) })
  const child = spawn(process.execPath, [path.join(home, 'crabot-core/dist/main.js')], { cwd: path.join(home, 'crabot-core'), env: { ...env(), PORT: String(port), CRABOT_PORT_OFFSET: '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
  const exited = new Promise(resolve => child.on('close', resolve))
  try {
    const deadline = Date.now() + 8000
    let healthy = false
    while (Date.now() < deadline) {
      try { healthy = (await (await fetch(`http://127.0.0.1:${port}/health`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(200) })).json()).data.status === 'healthy' } catch {}
      const locked = await acquireCliLock(data, 'probe', 0).then(lock => { releaseCliLock(lock); return false }, () => true)
      if (healthy && !locked) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(healthy, output).toBe(true)
    expect(await fs.readFile(path.join(data, 'mm.pid'), 'utf8')).toBe(String(child.pid))
    const available = await acquireCliLock(data, 'probe', 0); releaseCliLock(available)
    await fs.writeFile(path.join(data, 'cli.lock'), JSON.stringify({ pid: 2147483000, command: 'later fixture' }))
    await fs.writeFile(path.join(data, 'mm.pid'), '2147483000')
  } finally { child.kill('SIGTERM'); await exited }
  expect(JSON.parse(await fs.readFile(path.join(data, 'cli.lock'), 'utf8')).command).toBe('later fixture')
  expect(await fs.readFile(path.join(data, 'mm.pid'), 'utf8')).toBe('2147483000')
}, 12000)

it.each(['upgrade.mjs', 'ui-upgrade.mjs'])('already current release is read-only and invokes no preparation or stop: %s', async entry => {
  await scripts()
  await write('scripts/upgrade-lib/prepared-upgrade.mjs', 'export async function prepareUpgrade() { throw new Error("unexpected reprepare") }; export async function installPreparedUpgrade() { throw new Error("unexpected switch") }')
  await write('scripts/upgrade-lib/release.mjs', 'export const stageRelease=async()=>{throw new Error("unexpected staging")};export const downloadRelease=async()=>{throw new Error("unexpected download")};export const getReleaseUrls=()=>({});export const getCurrentVersion = () => "next"; export const getLatestVersion = async () => ({tag:"next"}); export const writeVersionFile = () => { throw new Error("unexpected version write") }')
  await fs.copyFile(path.join(product, 'scripts', entry), path.join(home, 'scripts', entry))
  const result = spawnSync(process.execPath, [path.join(home, 'scripts', entry), '--yes'], { cwd: home, env: env(), encoding: 'utf8', timeout: 10000 })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('already up to date')
  await expect(fs.stat(path.join(data, 'calls.json'))).rejects.toThrow()
})
