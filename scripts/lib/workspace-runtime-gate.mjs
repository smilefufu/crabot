// Fixed idle carrier and private single-use startup channel; no business request API.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import native from './process-identity.cjs'
import { verifyWorkspaceRuntimeStart } from './workspace-runtime-records.mjs'
import { sha256CanonicalJson as hash } from '../../crabot-shared/dist/canonical-json.js'
export const gateFields = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name))
export const gateUuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
export function validWorkspaceRuntimeInvocation(value) {
  const text = item => typeof item === 'string' && !item.includes('\0')
  return gateFields(value, ['command', 'args', 'cwd', 'env']) && text(value.command) && path.isAbsolute(value.command)
    && text(value.cwd) && path.isAbsolute(value.cwd) && Array.isArray(value.args) && value.args.every(text)
    && value.env && typeof value.env === 'object' && !Array.isArray(value.env) && Object.entries(value.env).every(([key, item]) => text(key) && key && !key.includes('=') && text(item))
}
export const gateMessageBudget = message => Buffer.byteLength(JSON.stringify(message)) <= 1024 * 1024
const failure = () => Object.assign(new Error('恢复验证模块的先登记后启动尚未确认，原维护保护已保留；未重试。'), { code: 'CRABOT_WORKSPACE_RUNTIME_GATE' })
const entry = fileURLToPath(new URL('../workspace-runtime-gate.mjs', import.meta.url))

export function createWorkspaceRuntimeGate() {
  if (process.versions.electron) throw failure()
  const allowed = new Set(['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE'])
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && allowed.has(key.toUpperCase())))
  const child = spawn(process.execPath, [entry], { cwd: path.dirname(entry), env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true })
  let closed = false, nonce, pending, resolveReady, rejectReady, startPromise, fingerprint, binding
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  void ready.catch(() => {})
  const timer = setTimeout(() => close(), 60000)
  const close = () => {
    if (closed) return
    closed = true; clearTimeout(timer); rejectReady(failure())
    if (pending) { clearTimeout(pending.timer); pending.reject(failure()); pending = undefined }
    if (child.connected) child.disconnect()
  }
  child.once('exit', close); child.once('error', close); child.once('disconnect', close)
  child.on('message', message => {
    try {
      if (closed || !gateMessageBudget(message)) throw failure()
      if (!nonce) {
        if (!gateFields(message, ['kind', 'nonce']) || message.kind !== 'workspace_runtime_gate_ready' || !gateUuid(message.nonce)) throw failure()
        nonce = message.nonce; clearTimeout(timer); resolveReady(Object.freeze({ nonce })); return
      }
      if (!pending || hash(message) !== hash(pending.expected)) throw failure()
      const current = pending; pending = undefined; clearTimeout(current.timer); current.resolve(message)
    } catch { close() }
  })
  function exchange(message, expected) {
    if (closed || pending || !child.connected || !nonce || !gateMessageBudget(message)) return Promise.reject(failure())
    return new Promise((resolve, reject) => {
      pending = { expected, resolve, reject, timer: setTimeout(() => { pending = undefined; reject(failure()) }, 60000) }
      try { child.send(message, error => { if (error) close() }) } catch { close() }
    })
  }
  function registration() {
    return verifyWorkspaceRuntimeStart({ dataDir: binding.dataDir, recoveryId: binding.recoveryId, moduleId: binding.moduleId,
      recordHash: binding.recordHash, definitionHash: hash(binding.invocation) })
  }
  async function current() {
    await binding.verify(); binding.assertCurrent()
    const record = registration()
    if (closed || child.pid !== record.process.pid || !native.sameProcess(record.parent, native.inspectProcess(process.pid))
      || !native.sameProcess(record.process, native.inspectProcess(child.pid))) throw failure()
    return record
  }
  return Object.freeze({ child, ready: () => ready, close,
    start(input) {
      try {
        if (!gateFields(input, ['dataDir', 'recoveryId', 'moduleId', 'recordHash', 'invocation', 'verify', 'assertCurrent'])
          || typeof input.verify !== 'function' || typeof input.assertCurrent !== 'function' || !validWorkspaceRuntimeInvocation(input.invocation)) throw failure()
        const snapshot = { ...input, invocation: structuredClone(input.invocation) }
        const key = hash({ dataDir: snapshot.dataDir, recoveryId: snapshot.recoveryId, moduleId: snapshot.moduleId, recordHash: snapshot.recordHash, invocation: snapshot.invocation })
        if (startPromise) { if (key !== fingerprint) throw failure(); return startPromise }
        fingerprint = key; binding = snapshot
        let submitted = false
        startPromise = Promise.resolve().then(async () => {
          try {
            await ready
            const record = await current()
            binding.assertCurrent()
            registration()
            submitted = true
            const result = await exchange({ kind: 'workspace_runtime_gate_start', nonce, data_dir: binding.dataDir, recovery_id: binding.recoveryId,
              module_id: binding.moduleId, record_sha256: binding.recordHash, invocation: binding.invocation }, { kind: 'workspace_runtime_gate_started', nonce, runtime_id: record.runtime.runtime_id })
            await current()
            return result
          } catch { if (!submitted) close(); throw failure() }
        })
        return startPromise
      } catch { return Promise.reject(failure()) }
    },
    async observe() {
      if (!startPromise || !binding) throw failure()
      const record = await current(), query_id = randomUUID()
      const result = await exchange({ kind: 'workspace_runtime_gate_observe', nonce, runtime_id: record.runtime.runtime_id, query_id },
        { kind: 'workspace_runtime_gate_observed', nonce, runtime_id: record.runtime.runtime_id, query_id })
      await current(); return result
    },
  })
}
