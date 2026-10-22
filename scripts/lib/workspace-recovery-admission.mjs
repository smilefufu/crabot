// Read-only fixed archive scope. This supplies no recovery or normal-job command authority.
import { sha256CanonicalJson as hash } from '../../crabot-shared/dist/canonical-json.js'
import { readCurrentWorkspaceRelocationFinalizing, readWorkspaceRelocationArchivedState, readWorkspaceRelocationReleased } from './workspace-relocation-intent.mjs'
import exits from './known-process-exit.cjs'
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const unavailable = () => Object.assign(new Error('当前冷恢复范围或原协调退出无法核实，维护保护已保留。'), { code: 'SERVICE_UNAVAILABLE' })
export function parseWorkspaceRecoveryAdmissionRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 4
    || !['intent_id', 'recovery_id', 'completion_sha256', 'finalizing_sha256'].every(key => Object.hasOwn(input, key))
    || !uuid(input.intent_id) || !uuid(input.recovery_id) || !digest(input.completion_sha256) || !digest(input.finalizing_sha256)) {
    throw Object.assign(new Error('Invalid recovery admission parameters'), { code: 'INVALID_PARAMS' })
  }
  return Object.freeze({ ...input })
}
export function readWorkspaceRecoveryAdmissionScope(dataDir, input) {
  const request = parseWorkspaceRecoveryAdmissionRequest(input)
  try {
    const fence = readCurrentWorkspaceRelocationFinalizing(dataDir)
    if (!fence || fence.intent_id !== request.intent_id || hash(fence) !== request.finalizing_sha256
      || readWorkspaceRelocationReleased(dataDir, request.intent_id)) throw unavailable()
    const state = readWorkspaceRelocationArchivedState(dataDir, request.intent_id)
    if (hash(state.completion) !== request.completion_sha256 || exits.probeKnownProcessExit([state.launch.process]).state !== 'stopped') throw unavailable()
    return { request, state, fence, fingerprint: hash({ state, fence }) }
  } catch { throw unavailable() }
}
