// Remain idle until this exact carrier has a durable private registration.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import native from './lib/process-identity.cjs'
import { verifyWorkspaceRuntimeStart } from './lib/workspace-runtime-records.mjs'
import { gateFields, gateUuid, gateMessageBudget, validWorkspaceRuntimeInvocation } from './lib/workspace-runtime-gate.mjs'
import { sha256CanonicalJson as hash } from '../crabot-shared/dist/canonical-json.js'
let attempted = false, started = false, runtimeId, runtimeChild, closed = false
const nonce = randomUUID()
const carrierTransport = process.env.CRABOT_RUNTIME_GATE_TRANSPORT
const close = () => {
  if (closed) return
  closed = true
  clearTimeout(timer)
  if (runtimeChild?.connected) runtimeChild.disconnect()
  if (runtimeChild?.stdin) {
    process.stdin.unpipe(runtimeChild.stdin)
    process.stdin.destroy()
    runtimeChild.stdin.end()
  }
  if (process.connected) process.disconnect()
}
const timer = setTimeout(close, 60000)
const send = message => { if (process.connected) process.send(message, error => { if (error) close() }) }
process.once('disconnect', close); process.once('error', close)
process.on('message', message => {
  if (carrierTransport === 'ipc' && message?.type === 'crabot:rpc') {
    if (runtimeChild?.connected) {
      runtimeChild.send(message, error => { if (error) close() })
    } else if (message.kind === 'call') {
      send({ type: 'crabot:rpc', kind: 'error', id: message.id,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Runtime has not started' } })
    }
    return
  }
  try {
    if (!gateMessageBudget(message) || message.nonce !== nonce) throw new Error('Invalid private message')
    if (message.kind === 'workspace_runtime_gate_observe') {
      if (!started || !gateFields(message, ['kind', 'nonce', 'runtime_id', 'query_id']) || message.runtime_id !== runtimeId || !gateUuid(message.query_id)) throw new Error('Invalid observation')
      send({ ...message, kind: 'workspace_runtime_gate_observed' }); return
    }
    if (attempted || !gateFields(message, ['kind', 'nonce', 'data_dir', 'recovery_id', 'module_id', 'record_sha256', 'invocation'])
      || message.kind !== 'workspace_runtime_gate_start' || !validWorkspaceRuntimeInvocation(message.invocation)) throw new Error('Invalid start')
    attempted = true
    const record = verifyWorkspaceRuntimeStart({ dataDir: message.data_dir, recoveryId: message.recovery_id, moduleId: message.module_id,
      recordHash: message.record_sha256, definitionHash: hash(message.invocation) })
    const self = native.inspectProcess(process.pid)
    if (!native.sameProcess(record.process, self) || self.parent !== record.parent.pid || !native.sameProcess(record.parent, native.inspectProcess(self.parent))) throw new Error('Invalid carrier')
    clearTimeout(timer); runtimeId = record.runtime.runtime_id
    const mode = message.invocation.env.CRABOT_RPC_TRANSPORT
    if (mode !== carrierTransport && (mode || carrierTransport)) throw new Error('Invalid runtime transport')
    const child = runtimeChild = spawn(message.invocation.command, message.invocation.args, { cwd: message.invocation.cwd, env: message.invocation.env,
      stdio: mode === 'ipc' ? ['ignore', 'inherit', 'inherit', 'ipc'] : [mode === 'pipe' ? 'pipe' : 'ignore', 'inherit', 'inherit'],
      serialization: 'advanced', detached: false, windowsHide: true })
    if (mode === 'ipc') child.on('message', frame => {
      if (frame?.type === 'crabot:rpc') send(frame)
    })
    if (mode === 'pipe') {
      child.stdin.on('error', () => close())
      process.stdin.pipe(child.stdin)
    }
    child.once('spawn', () => { started = true; send({ kind: 'workspace_runtime_gate_started', nonce, runtime_id: runtimeId }) })
    child.once('error', () => { process.exitCode = 1; close() })
    child.once('exit', code => { process.exitCode = code ?? 1; close() })
  } catch { process.exitCode = 1; close() }
})
if (!process.send || !process.connected || process.versions.electron) { process.exitCode = 1; close() }
else send({ kind: 'workspace_runtime_gate_ready', nonce })
