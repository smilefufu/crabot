// Installer presentation adapter for the dedicated legacy-user data role. The
// target's verified bundled Node owns conversion/locks; the installer owns OS
// registration. This is neither fresh installation nor retained-uninstall repair.
import { spawn } from 'node:child_process'
import { promises as fs, realpathSync } from 'node:fs'
import path from 'node:path'
import identity from './process-identity.cjs'
import installation from './desktop-installation.cjs'
import product from './product-runtime.cjs'
import { inspectLegacyEntryFence } from './legacy-entry-fence.mjs'
import { verifyLegacyDesktopPrograms } from './legacy-desktop-programs.mjs'
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const fail = cause => Object.assign(new Error('旧安装接管交接尚未完成，请使用同一安装包继续；原数据和保护已保留。', { cause }), { code: 'CRABOT_MAINTENANCE_PENDING' })
const phases = ['stopping', 'preparing_environment', 'switching', 'converting']
const script = `
import { pathToFileURL } from 'node:url'
const [module, input] = process.argv.slice(1), prepared = JSON.parse(input), abort = new AbortController()
let critical = false, reply
const cancel = () => { if (!critical) abort.abort() }
process.on('message', message => {
  if (message?.type === 'cancel') return cancel()
  if (message?.type === 'entries-registered' && reply) { const use = reply; reply = undefined; return use(message.ok === true) }
  abort.abort()
})
process.once('disconnect', () => { cancel(); reply?.(false) })
const send = message => new Promise((resolve, reject) => {
  if (!process.connected) return reject(new Error('Installer disconnected'))
  process.send(message, error => error ? reject(error) : resolve())
})
try {
  const role = await import(pathToFileURL(module).href)
  const converted = await role.convertLegacyDesktopData({ prepared, signal: abort.signal, progress: phase => {
    if (phase === 'switching' || phase === 'converting') critical = true
    if (process.connected) process.send({ type: 'progress', phase }, () => {})
  } })
  abort.signal.throwIfAborted()
  critical = true
  const result = await role.commitLegacyDesktopInstallation({ prepared, maintenanceId: converted.maintenance_id,
    registerEntries: prepared => new Promise((resolve, reject) => {
      reply = ok => ok ? resolve() : reject(new Error('Entry registration unconfirmed'))
      send({ type: 'register-entries', prepared }).catch(reject)
    }) })
  await send({ type: 'handoff', result })
} catch (error) {
  process.exitCode = 1
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code) ? error.code : 'CRABOT_MAINTENANCE_PENDING'
  try { await send({ type: 'failure', code }) } catch {}
  console.error(error)
}
finally { if (process.connected) process.disconnect() }
`
export async function runPreparedLegacyDesktopTakeover({ prepared, entryFenceId, registerEntries, signal, progress = () => {} }) {
  if (typeof registerEntries !== 'function') throw fail()
  signal?.throwIfAborted()
  if (entryFenceId === undefined) {
    try { await fs.lstat(path.join(prepared.installation.installRoot, '.desktop-takeover')); entryFenceId = (await inspectLegacyEntryFence(prepared.installation.installRoot)).id }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  await verifyLegacyDesktopPrograms(prepared, { entryFenceId, signal })
  const runtime = product.loadProductRuntime(prepared.coreRoot, { required: true, full: true })
  signal?.throwIfAborted()
  const input = { installation: prepared.installation, selection: prepared.selection,
    coreRoot: prepared.coreRoot, guiRoot: prepared.guiRoot, proof: prepared.proof }
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(PATH|HOME|USER|LOGNAME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR|LANG|LC_.*|HTTPS?_PROXY|ALL_PROXY|NO_PROXY)$/i.test(name)))
  env.DATA_DIR = prepared.installation.dataRoot; env.CRABOT_HOME = prepared.coreRoot
  env.CRABOT_DEV = 'false'; env.CRABOT_PORT_OFFSET = '0'; env.CRABOT_PRODUCT_REQUIRED = '1'
  const child = spawn(runtime.executables.node, ['--input-type=module', '--eval', script,
    path.join(prepared.coreRoot, 'scripts/lib/legacy-desktop-takeover.mjs'), JSON.stringify(input)],
    { cwd: prepared.coreRoot, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  return new Promise((resolve, reject) => {
    let failed, result, registered = false, registering = false, critical = false, registration = Promise.resolve(), stderr = ''
    const stop = error => { failed ??= error || fail(); try { if (child.connected) child.disconnect() } catch {} }
    const cancel = () => { if (!critical && child.connected) child.send({ type: 'cancel' }, error => { if (error) stop(error) }) }
    signal?.addEventListener('abort', cancel, { once: true })
    child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-65536) })
    child.once('error', stop)
    child.once('spawn', () => {
      try {
        const peer = identity.inspectProcess(child.pid)
        if (!peer || peer.owner !== identity.inspectProcess(process.pid).owner || realpathSync(peer.executable) !== realpathSync(runtime.executables.node)) return stop(fail())
        if (signal?.aborted) cancel()
      } catch (error) { stop(error) }
    })
    child.on('message', message => {
      try {
        if (failed || !message || typeof message !== 'object') return stop(fail())
        if (message.type === 'progress' && phases.includes(message.phase) && !registered && !registering) {
          if (message.phase === 'switching' || message.phase === 'converting') critical = true
          try { progress(message.phase) } catch (error) { stop(error) }
        } else if (message.type === 'failure' && !result && Object.keys(message).sort().join(',') === 'code,type'
          && typeof message.code === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(message.code)) {
          failed = Object.assign(new Error(message.code), { code: message.code })
        } else if (message.type === 'register-entries' && !registering && !registered) {
          const own = installation.readDesktopInstallation(prepared.installation.installRoot)
          const expected = { installRoot: own.root, installation_id: own.record.installation_id,
            selection: prepared.selection, coreRoot: prepared.coreRoot, guiRoot: prepared.guiRoot }
          if (!same(message.prepared, expected)) return stop(fail())
          registering = true; critical = true
          registration = Promise.resolve().then(() => registerEntries(expected)).then(() => {
            registered = true
            if (child.connected) child.send({ type: 'entries-registered', ok: true }, error => { if (error) stop(error) })
          }, error => {
            failed = error
            if (child.connected) child.send({ type: 'entries-registered', ok: false }, error => { if (error) stop(error) })
          }).finally(() => { registering = false })
        } else if (message.type === 'handoff' && registered && !result
          && message.result?.executable === path.join(prepared.guiRoot, process.platform === 'darwin' ? 'Crabot.app/Contents/MacOS/Crabot' : process.platform === 'win32' ? 'Crabot.exe' : 'crabot-desktop')
          && message.result.dataDir === prepared.installation.dataRoot && message.result.verification_pending === true && message.result.health_verified === false
          && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(message.result.maintenance_id) && Object.keys(message.result).length === 5) result = message.result
        else stop(fail())
      } catch (error) { stop(error) }
    })
    child.once('close', async code => {
      signal?.removeEventListener('abort', cancel)
      await registration.catch(stop)
      if (!failed && code === 0 && result) resolve(result)
      else reject(fail(failed || new Error(stderr || 'Target Node exited before handoff')))
    })
  })
}
