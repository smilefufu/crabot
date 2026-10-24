// Fixed bundled Node entry, ordinary UID only; native UI owns Polkit.
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { homedir } from 'node:os'
import { readFile, readdir } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { registerInstallationEntries, readInstallationLocator, type PreparedInstallation } from './installation-entries.js'
import { finishUbuntuInstallation, ubuntuInstallationFailure } from './ubuntu-installation.js'
import { runUbuntuProcess, ubuntuDesktopEnvironment } from './ubuntu-process.js'
import { probeUbuntuPrograms } from './ubuntu-program-probe.js'
const directory = path.dirname(fileURLToPath(import.meta.url)), bundle = path.resolve(directory, '../..')
const abort = new AbortController()
const emit = (type: string, fields: Record<string, unknown> = {}) => process.stdout.write(JSON.stringify({ type, ...fields }) + '\n')
let authorization: { resolve: () => void; reject: (error: Error) => void } | undefined
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', line => {
  if (line === '{"action":"cancel"}') { abort.abort(); authorization?.reject(new Error('Cancelled')); return }
  if (line === '{"action":"authorized"}' && authorization) { authorization.resolve(); authorization = undefined; return }
  if (line === '{"action":"denied"}' && authorization) { authorization.reject(Object.assign(new Error('OS authorization rejected'), { code: 'CRABOT_INSTALL_SYSTEM_AUTHORIZATION' })); authorization = undefined; return }
  abort.abort(); authorization?.reject(new Error('Invalid installer action')); authorization = undefined
})
input.on('close', () => { abort.abort(); authorization?.reject(new Error('Installer closed')) })
process.on('SIGTERM', () => abort.abort())

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
  const inspected = await runUbuntuProcess(path.join(bundle, 'crabot-sandbox-helper'), ['--inspect', prepared.installRoot], ubuntuDesktopEnvironment(process.env), 60_000, abort.signal)
  if (inspected.code !== 0) throw Object.assign(new Error('Native inspection failed'), { code: 'CRABOT_INSTALL_PROGRAM_IDENTITY' })
  const product = createRequire(import.meta.url)('./bootstrap/scripts/lib/product-runtime.cjs')
  const installed = await finishUbuntuInstallation({ signal: abort.signal,
    probe: async () => {
      emit('progress', { phase: 'sandbox' })
      const runtime = product.loadProductRuntime(prepared.coreRoot, { required: true, full: true })
      await probeUbuntuPrograms(prepared, { runtime, signal: abort.signal, browserProbe: path.join(bundle, 'browser-probe.py') })
    },
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
  emit('failed', ubuntuInstallationFailure(error, abort.signal.aborted))
  process.exitCode = abort.signal.aborted ? 2 : 1
}).finally(() => { input.close(); process.stdin.destroy() })
