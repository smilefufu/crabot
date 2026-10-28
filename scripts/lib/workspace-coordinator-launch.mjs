// Fixed local coordinator handoff only. No Worker stop, move or public job acceptance.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import native from './process-identity.cjs'
import { captureSpawnedProcessTree } from './spawned-process-tree.cjs'
import { cliLockToken, releaseCliLock } from './cli-lock.mjs'
import { readWorkspaceRelocationIntent, readWorkspaceRelocationCoordinator, commitWorkspaceRelocationCoordinator } from './workspace-relocation-intent.mjs'
import { sha256CanonicalJson } from '../../crabot-shared/dist/canonical-json.js'

const diagnostics = new WeakMap()
export const workspaceCoordinatorDiagnostics = child => diagnostics.get(child) ?? ''

const entry = fileURLToPath(new URL('../workspace-relocation-coordinator.mjs', import.meta.url))
const failure = () => Object.assign(new Error('迁移协调器启动尚未核实，原目录及维护记录已保留；未重新启动作业。'), { code: 'CRABOT_WORKSPACE_COORDINATOR' })
const fields = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key))
function environment() {
  const allowed = new Set(['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL', 'LC_CTYPE'])
  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && allowed.has(key.toUpperCase())))
}

export async function launchWorkspaceRelocationCoordinator(options) {
  let child, identity, stage = 'validate', clear = () => {}
  try {
    if (!fields(options, ['dataDir', 'id']) || process.versions.electron) throw failure()
    const { dataDir, id } = options, lock = path.resolve(dataDir, 'cli.lock'), token = cliLockToken(lock)
    const intent = readWorkspaceRelocationIntent(dataDir), intentHash = sha256CanonicalJson(intent)
    if (!token || !intent || intent.id !== id || readWorkspaceRelocationCoordinator(dataDir, id).launch) throw failure()
    const parent = native.inspectProcess(process.pid)
    const verifyParent = () => {
      if (cliLockToken(lock) !== token || sha256CanonicalJson(readWorkspaceRelocationIntent(dataDir)) !== intentHash
        || !native.sameProcess(parent, native.inspectProcess(process.pid))) throw failure()
    }
    verifyParent()
    stage = 'spawn'
    child = spawn(process.execPath, [entry], { env: environment(), stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true, detached: process.platform !== 'win32' })
    child.on('error', () => {}) // The handoff/client owns diagnostics; a later IPC error must not crash MM.
    diagnostics.set(child, '')
    child.stderr?.on('data', bytes => diagnostics.set(child, (workspaceCoordinatorDiagnostics(child) + bytes.toString()).slice(-16384)))
    stage = 'capture-child'
    identity = captureSpawnedProcessTree(child).find(item => item.pid === child.pid)
    if (!identity) throw failure()
    let launch, launchHash, readyHash, resolveReady, rejectReady, settled = false
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
    void ready.catch(() => {})
    const reject = () => { if (!settled) { settled = true; rejectReady(failure()) } }
    const verify = () => {
      const current = readWorkspaceRelocationCoordinator(dataDir, id)
      if (!launch || !current.launch || !current.ready || sha256CanonicalJson(current.launch) !== launchHash
        || sha256CanonicalJson(readWorkspaceRelocationIntent(dataDir)) !== intentHash
        || !native.sameProcess(parent, native.inspectProcess(process.pid))
        || !native.sameProcess(identity, native.inspectProcess(child.pid)) || child.exitCode !== null || child.signalCode !== null || !child.connected) throw failure()
      return current
    }
    const receive = message => {
      try {
        if (!fields(message, ['kind', 'intent_id', 'launch_id', 'ready_sha256']) || message.intent_id !== id || message.launch_id !== launch?.launch_id) throw failure()
        const current = verify(), hash = sha256CanonicalJson(current.ready)
        if (message.ready_sha256 !== hash) throw failure()
        if (message.kind === 'workspace_relocation_ready' && readyHash === undefined) { readyHash = hash; return }
        if (message.kind !== 'workspace_relocation_handlers_ready' || readyHash !== hash || settled) throw failure()
        settled = true; resolveReady(Object.freeze({ child, launch: current.launch, ready: current.ready }))
      } catch { reject() }
    }
    const timer = setTimeout(reject, 15000)
    clear = () => { clearTimeout(timer); child.off('message', receive); child.off('exit', reject); child.off('error', reject) }
    child.on('message', receive); child.once('exit', reject); child.once('error', reject)
    verifyParent()
    stage = 'publish-launch'
    launch = commitWorkspaceRelocationCoordinator({ dataDir, id, launchId: randomUUID(), coordinator: identity })
    launchHash = sha256CanonicalJson(launch)
    verifyParent()
    stage = 'release-parent-lock'
    releaseCliLock(lock)
    child.send({ kind: 'workspace_relocation_start', data_dir: dataDir, intent_id: id, launch_id: launch.launch_id, launch_sha256: launchHash }, error => { if (error) reject() })
    stage = 'await-ready'
    const result = await ready
    verify(); clear()
    return result
  } catch (cause) {
    clear()
    if (identity && child && child.exitCode === null && child.signalCode === null) {
      try { native.terminateKnownProcess(identity) } catch { /* Unknown exit retains all evidence. */ }
      await new Promise(resolve => {
        const timer = setTimeout(done, 2000)
        function done() { clearTimeout(timer); child.off('exit', done); resolve() }
        child.once('exit', done)
        if (child.exitCode !== null || child.signalCode !== null) done()
      })
    }
    const error = failure(); error.cause = cause; error.stage = stage
    error.diagnostics = workspaceCoordinatorDiagnostics(child)
    try { error.child_observation = child?.pid ? native.inspectProcess(child.pid) : null } catch (observed) { error.child_observation = { unavailable: observed.code } }
    throw error
  }
}
