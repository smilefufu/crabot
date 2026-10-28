// Fixed Node filesystem capability only. The caller retains actual job authorization.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import native from './process-identity.cjs'
import { captureSpawnedProcessTree } from './spawned-process-tree.cjs'
import { probeKnownProcessExit } from './known-process-exit.cjs'
import { stopKnownProcessScope } from './known-process-stop.cjs'

const entry = fileURLToPath(new URL('../workspace-root-probe.mjs', import.meta.url))
const fields = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const failure = stage => Object.assign(new Error('新工作区文件能力尚未确认，已保留维护保护和原文件。'), { code: 'WORKSPACE_ROOT_PROBE_UNVERIFIED', stage })
function validDirectory(root) {
  return fields(root, ['path', 'dev', 'ino', 'native_id']) && typeof root.path === 'string' && path.isAbsolute(root.path)
    && path.dirname(root.path) !== root.path && path.normalize(root.path) === root.path && !root.path.includes('\0')
    && typeof root.dev === 'string' && /^\d+$/.test(root.dev) && typeof root.ino === 'string' && /^[1-9]\d*$/.test(root.ino)
    && (process.platform === 'win32' ? typeof root.native_id === 'string' && /^\d+:[a-f0-9]{32}$/i.test(root.native_id) : root.native_id === null)
}
function checkDirectory(root) {
  const stat = fs.lstatSync(root.path, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(root.path) !== root.path
    || String(stat.dev) !== root.dev || String(stat.ino) !== root.ino || !native.isOwnedDirectory(root.path)
    || process.platform === 'win32' && native.inspectDirectoryFileId(root.path) !== root.native_id) throw failure('directory')
}
function environment() {
  const allowed = new Set(['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE'])
  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && allowed.has(key.toUpperCase())))
}
export async function probeWorkspaceDirectory(options) {
  let stage = 'input', directoryFd, pin, child, processes, timer, spawnFailed = false
  const began = performance.now()
  let spawnedAt, submittedAt
  let probeEvent = null, accepted = false, exited = false, exitCode, exitSignal, nativeExitState = null
  const release = () => {
    if (pin) { const held = pin; pin = undefined; native.releaseDirectoryPin(held) }
    if (directoryFd !== undefined) { const held = directoryFd; directoryFd = undefined; fs.closeSync(held) }
  }
  const assertAuthorized = guard => {
    if (typeof guard !== 'function') throw failure(stage)
    const result = guard()
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => {})
      throw failure(stage)
    }
  }
  try {
    if (!fields(options, ['directory', 'authorize']) || typeof options.authorize !== 'function' || !validDirectory(options.directory) || process.versions.electron) throw failure(stage)
    const root = structuredClone(options.directory), authorize = options.authorize, nonce = randomUUID()
    stage = 'authorize'
    const current = await authorize()
    assertAuthorized(current); checkDirectory(root)
    stage = 'directory'
    if (process.platform === 'win32') pin = native.pinDirectory(root.path)
    else {
      directoryFd = fs.openSync(root.path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
      const stat = fs.fstatSync(directoryFd, { bigint: true })
      if (String(stat.dev) !== root.dev || String(stat.ino) !== root.ino) throw failure(stage)
    }
    assertAuthorized(current); checkDirectory(root)
    const parent = native.inspectProcess(process.pid)
    stage = 'spawn'
    child = spawn(process.execPath, [entry], { cwd: process.platform === 'win32' ? root.path : undefined,
      env: environment(), stdio: ['ignore', 'ignore', 'pipe', ...(directoryFd !== undefined ? [directoryFd] : []), 'ipc'],
      windowsHide: true, detached: process.platform !== 'win32' })
    spawnedAt = performance.now()
    let rejectRun, resolveRun
    const run = new Promise((resolve, reject) => { resolveRun = resolve; rejectRun = reject })
    void run.catch(() => {})
    const fail = event => { probeEvent ??= event; rejectRun(failure(stage)) }
    const complete = () => { if (accepted && exited) resolveRun() }
    child.on('error', () => { spawnFailed = true; fail('child-error') })
    child.stderr?.resume()
    child.once('exit', (code, signal) => { exited = true; exitCode = code; exitSignal = signal; if (code !== 0 || signal) fail('child-exit'); else complete() })
    child.once('disconnect', () => { if (!accepted) fail('disconnect') })
    child.on('message', message => {
      if (accepted || !fields(message, ['kind', 'nonce', 'root']) || message.kind !== 'workspace_root_probe_complete'
        || message.nonce !== nonce || JSON.stringify(message.root) !== JSON.stringify(root)) { fail('completion-frame'); return }
      accepted = true; complete()
    })
    timer = setTimeout(() => fail('deadline'), 5000)
    processes = captureSpawnedProcessTree(child)
    assertAuthorized(current); checkDirectory(root)
    stage = 'submit'
    submittedAt = performance.now()
    child.send({ kind: 'workspace_root_probe', nonce, root, parent }, error => { if (error) fail('submission') })
    stage = 'exit'
    await run
    if (exitCode !== 0 || exitSignal) { probeEvent = 'child-exit'; throw failure(stage) }
    probeEvent = 'native-exit'
    nativeExitState = probeKnownProcessExit(processes).state
    if (nativeExitState !== 'stopped') throw failure(stage)
    probeEvent = null
    clearTimeout(timer); timer = undefined
    release()
    stage = 'final-authorize'
    const final = await authorize()
    assertAuthorized(final); checkDirectory(root)
    return Object.freeze(root)
  } catch (cause) {
    try {
      console.error(JSON.stringify({ event: 'workspace_root_probe_failed', stage, probe_event: probeEvent, accepted, exited,
        exit_code: child?.exitCode ?? null, exit_signal: child?.signalCode ?? null, native_exit_state: nativeExitState,
        elapsed_ms: Math.round(performance.now() - began), submission_delay_ms: submittedAt === undefined ? null : Math.round(submittedAt - spawnedAt) }))
    } catch { /* Diagnostics must not interrupt owned-child cleanup. */ }
    clearTimeout(timer)
    if (processes) {
      try { await stopKnownProcessScope(processes, { timeoutMs: 1, onObserved: async () => {} }) } catch { /* Unknown exit remains failure; retain handles until the actual child exits. */ }
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => {
        const event = child.pid ? 'exit' : 'close', wait = setTimeout(done, 5000)
        function done() { clearTimeout(wait); child.off(event, done); resolve() }
        child.once(event, done)
        if (child.exitCode !== null || child.signalCode !== null) done()
      })
    }
    throw Object.assign(failure(stage), { cause })
  } finally {
    if (!child || (spawnFailed && !child.pid) || child.exitCode !== null || child.signalCode !== null) release()
    else child.once('exit', () => { try { release() } catch { console.warn('[Workspace probe] directory handle release remains unconfirmed') } })
  }
}
