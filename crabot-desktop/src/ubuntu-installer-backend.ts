// Fixed bundled Node entry, ordinary UID only; native UI owns Polkit.
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { registerInstallationEntries, readInstallationLocator, type PreparedInstallation } from './installation-entries.js'
import { finishUbuntuInstallation } from './ubuntu-installation.js'
const directory = path.dirname(fileURLToPath(import.meta.url)), bundle = path.resolve(directory, '../..')
const abort = new AbortController()
const emit = (type: string, fields: Record<string, unknown> = {}) => process.stdout.write(JSON.stringify({ type, ...fields }) + '\n')
let authorization: { resolve: () => void; reject: (error: Error) => void } | undefined
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', line => {
  if (line === '{"action":"cancel"}') { abort.abort(); authorization?.reject(new Error('Cancelled')); return }
  if (line === '{"action":"authorized"}' && authorization) { authorization.resolve(); authorization = undefined; return }
  if (line === '{"action":"denied"}' && authorization) { authorization.reject(new Error('OS authorization rejected')); authorization = undefined; return }
  abort.abort(); authorization?.reject(new Error('Invalid installer action')); authorization = undefined
})
input.on('close', () => { abort.abort(); authorization?.reject(new Error('Installer closed')) })
process.on('SIGTERM', () => abort.abort())

async function run(command: string, args: string[], env: NodeJS.ProcessEnv, timeout: number, cwd?: string) {
  abort.signal.throwIfAborted()
  // A private process group contains only this finite probe and its children.
  const child = spawn(command, args, { cwd, env, stdio: 'ignore', detached: true })
  let alive = true
  child.once('exit', () => { alive = false })
  const stop = () => { if (alive && child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch {} } }
  const timer = setTimeout(stop, timeout), cancelled = () => stop()
  abort.signal.addEventListener('abort', cancelled, { once: true })
  try {
    await once(child, 'spawn')
    const [code] = await once(child, 'exit')
    abort.signal.throwIfAborted()
    if (code !== 0) throw new Error('Sandbox probe failed')
  } finally { clearTimeout(timer); abort.signal.removeEventListener('abort', cancelled); stop() }
}
async function probe(prepared: PreparedInstallation) {
  emit('progress', { phase: 'sandbox' })
  const product = createRequire(import.meta.url)('./bootstrap/scripts/lib/product-runtime.cjs')
  const runtime = product.loadProductRuntime(prepared.coreRoot, { required: true, full: true })
  const roles = ['gui', 'chromium', 'scrapling']
  if (Object.keys(runtime.manifest.files).some(name => /\/browsers\/chromium_headless_shell-[0-9]+\/chrome-headless-shell-linux(?:64)?\/headless_shell$/.test(name))) roles.push('headless')
  const profile = await mkdtemp(path.join(tmpdir(), 'crabot-install-sandbox-')), token = randomBytes(32).toString('hex'), received = new Set<string>()
  const server = createServer((request, response) => {
    const role = request.url?.slice(token.length + 2)
    if (!role || !['gui', 'chromium', 'headless', 'scrapling'].includes(role) || request.url !== `/${token}/${role}`) { response.writeHead(404).end(); return }
    response.setHeader('Cache-Control', 'no-store')
    if (request.method === 'GET') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'")
      response.end(`<title>Crabot sandbox probe</title><body>Crabot<script>fetch(location.href,{method:'POST',body:'${token}:${role}'}).then(r=>r.text()).then(t=>{if(t==='verified')document.body.dataset.ready='yes'})</script>`)
    } else if (request.method === 'POST') {
      let body = ''; request.on('data', bytes => { body += bytes; if (body.length > 100) request.destroy() })
      request.on('end', () => { if (body !== `${token}:${role}`) { response.writeHead(400).end(); return }; received.add(role); response.end('verified') })
    } else response.writeHead(405).end()
  })
  server.headersTimeout = 5000; server.requestTimeout = 5000
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Probe unavailable')
    const endpoint = `http://127.0.0.1:${address.port}/${token}`
    const env = { ...process.env }
    for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'CHROME_DEVEL_SANDBOX', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DATA_DIR', 'PYTHONPATH', 'PYTHONHOME']) delete env[name]
    for (const name of ['TMPDIR', 'TEMP', 'TMP']) env[name] = profile
    env.HOME = profile; env.CRABOT_SCRAPLING_DATA_DIR = profile
    env.XDG_CACHE_HOME = path.join(profile, 'cache'); env.XDG_CONFIG_HOME = env.CHROME_CONFIG_HOME = path.join(profile, 'config')
    await mkdir(path.join(profile, 'gui'), { mode: 0o700 })
    await run(path.join(prepared.guiRoot, 'crabot-desktop'), [`--user-data-dir=${path.join(profile, 'gui')}`, `--installation-sandbox-probe=${endpoint}/gui`], env, 60_000, profile)
    await run(runtime.executables.python, ['-I', '-B', path.join(bundle, 'browser-probe.py'), prepared.coreRoot, endpoint], env, 150_000, profile)
    if (!roles.every(role => received.has(role))) throw new Error('Probe network incomplete')
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(profile, { recursive: true, force: true })
  }
}
async function main() {
  const verifyOnly = process.argv.length === 3 && process.argv[2] === '--verify-payload-only'
  if (process.platform !== 'linux' || process.arch !== 'x64' || process.getuid!() === 0 || process.getuid!() !== process.geteuid!()
    || process.argv.length !== 3 || !verifyOnly && (!path.isAbsolute(process.argv[2]) || /[\r\n\0]/.test(process.argv[2]))) throw new Error('Invalid native installer')
  const backend = await import(pathToFileURL(path.join(directory, 'bootstrap/scripts/lib/desktop-payload.mjs')).href)
  if (verifyOnly) {
    const verified = await backend.verifyDesktopPayload(path.join(bundle, 'offline'))
    if (verified.bytes <= 0n) throw new Error('Invalid payload')
    emit('payload_verified', { business_mm_started: false }); return
  }
  const { detectMode } = await import(pathToFileURL(path.join(directory, 'bootstrap/scripts/lib/mode.mjs')).href)
  if (detectMode() === 'system') throw Object.assign(new Error('System deployment'), { code: 'CRABOT_INSTALL_SYSTEM_MODE' })
  const locator = await readInstallationLocator(homedir(), 'linux', process.env)
  const oldData = await readdir(path.join(homedir(), '.crabot/data')).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  if (!locator && oldData.length) throw Object.assign(new Error('Legacy deployment'), { code: 'CRABOT_DESKTOP_TAKEOVER_REQUIRED' })
  const prepared: PreparedInstallation = await backend.prepareDesktopInstallation({ payload: path.join(bundle, 'offline'), installRoot: path.resolve(process.argv[2]),
    signal: abort.signal, progress: (phase: string) => emit('progress', { phase }) })
  // Verify the root helper's closed view before any executable probes or Polkit.
  await run(path.join(bundle, 'crabot-sandbox-helper'), ['--inspect', prepared.installRoot], process.env, 60_000)
  const installed = await finishUbuntuInstallation({ signal: abort.signal, probe: () => probe(prepared),
    authorizationNeeded: async () => (await readFile('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').catch(() => '')).trim() === '1',
    authorize: () => new Promise<void>((resolve, reject) => { authorization = { resolve, reject }; emit('authorization_required') }),
    register: async () => {
      emit('progress', { phase: 'registering' })
      await registerInstallationEntries(prepared, { home: homedir(), platform: 'linux', env: process.env,
        shell: { readShortcutLink: () => { throw new Error('Windows only') }, writeShortcutLink: () => false } })
    }, commit: () => backend.commitDesktopInstallation(prepared),
  }) as { executable: string }
  emit('complete', { executable: installed.executable })
}
void main().catch(error => {
  const allowed = ['ENOSPC', 'CRABOT_UPDATE_SPACE', 'CRABOT_CORE_INTEGRITY', 'CRABOT_INSTALL_FILESYSTEM', 'CRABOT_INSTALL_SYSTEM_MODE', 'CRABOT_DESKTOP_TAKEOVER_REQUIRED', 'CRABOT_INSTALL_REGISTRATION']
  emit('failed', { code: abort.signal.aborted ? 'CANCELLED' : allowed.includes(error?.code) ? error.code : 'NOT_READY' }); process.exitCode = abort.signal.aborted ? 2 : 1
}).finally(() => { input.close(); process.stdin.destroy() })
