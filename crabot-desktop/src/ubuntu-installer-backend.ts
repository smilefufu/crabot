// Fixed bundled Node entry, ordinary UID only; native UI owns Polkit.
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { homedir } from 'node:os'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { registerInstallationEntries, registerRetainedInstallationEntries, readInstallationLocator, type PreparedInstallation } from './installation-entries.js'
import { ensureUbuntuProgramsReady, finishUbuntuInstallation, ubuntuInstallationFailure } from './ubuntu-installation.js'
import { runUbuntuProcess, ubuntuDesktopEnvironment } from './ubuntu-process.js'
import { probeUbuntuPrograms } from './ubuntu-program-probe.js'
import { prepareRetainedDesktopReinstall } from './retained-reinstall.js'
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
  if (!locator) {
    const { assertFreshUserInstallation } = await import(pathToFileURL(path.join(directory, 'bootstrap/scripts/lib/legacy-desktop.mjs')).href)
    await assertFreshUserInstallation({ home: homedir(), source: process.env })
  }
  const payload = path.join(bundle, 'offline'), installRoot = path.resolve(process.argv[2])
  const product = createRequire(import.meta.url)('./bootstrap/scripts/lib/product-runtime.cjs')
  const inspectPrepared = async (prepared: PreparedInstallation) => {
    const inspected = await runUbuntuProcess(path.join(bundle, 'crabot-sandbox-helper'), ['--inspect', prepared.installRoot], ubuntuDesktopEnvironment(process.env), 60_000, abort.signal)
    if (inspected.code !== 0) throw Object.assign(new Error('Native inspection failed'), { code: 'CRABOT_INSTALL_PROGRAM_IDENTITY' })
  }
  const readiness = (prepared: PreparedInstallation) => ({ signal: abort.signal,
    probe: async () => {
      emit('progress', { phase: 'sandbox' })
      const runtime = product.loadProductRuntime(prepared.coreRoot, { required: true, full: true })
      await probeUbuntuPrograms(prepared, { runtime, signal: abort.signal, browserProbe: path.join(bundle, 'browser-probe.py') })
    },
    authorizationNeeded: async () => (await readFile('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').catch(() => '')).trim() === '1',
    authorize: () => new Promise<void>((resolve, reject) => { authorization = { resolve, reject }; emit('authorization_required') }),
  })
  const register = async (prepared: PreparedInstallation) => {
    emit('progress', { phase: 'registering' })
    await registerInstallationEntries(prepared, { home: homedir(), platform: 'linux', env: process.env,
      shell: { readShortcutLink: () => { throw new Error('Windows only') }, writeShortcutLink: () => false } })
  }
  const retained = await prepareRetainedDesktopReinstall({ payload, installRoot, signal: abort.signal,
    progress: phase => emit('progress', { phase }), registerEntries: async (prepared, operationId) => {
      await inspectPrepared(prepared)
      await ensureUbuntuProgramsReady(readiness(prepared))
      abort.signal.throwIfAborted()
      emit('progress', { phase: 'registering' })
      await registerRetainedInstallationEntries(prepared, { home: homedir(), platform: 'linux', env: process.env, operationId,
        shell: { readShortcutLink: () => { throw new Error('Windows only') }, writeShortcutLink: () => false } })
    } })
  if (retained) { emit('complete', { executable: retained.executable, verification_pending: true }); return }
  const prepared: PreparedInstallation = await backend.prepareDesktopInstallation({ payload, installRoot,
    signal: abort.signal, progress: (phase: string) => emit('progress', { phase }) })
  // Fresh completion remains separate from retained-data target recovery.
  await inspectPrepared(prepared)
  const installed = await finishUbuntuInstallation({ ...readiness(prepared),
    register: () => register(prepared), commit: () => backend.commitDesktopInstallation(prepared),
  }) as { executable: string }
  emit('complete', { executable: installed.executable })
}
void main().catch(error => {
  emit('failed', ubuntuInstallationFailure(error, abort.signal.aborted))
  process.exitCode = abort.signal.aborted ? 2 : 1
}).finally(() => { input.close(); process.stdin.destroy() })
