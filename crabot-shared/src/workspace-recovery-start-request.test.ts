import assert from 'node:assert/strict'
import test from 'node:test'
import { parseWorkspaceRelocationRecoveryStartRequest } from './workspace-recovery-start-request.js'

test('recovery confirmation is closed, fixed and never carries body authority', () => {
  const request = { intent_id: '12345678-1234-4123-8123-123456789abc', recovery_id: '87654321-4321-4321-8321-cba987654321',
    completion_sha256: 'a'.repeat(64), finalizing_sha256: 'b'.repeat(64), confirmed: true as const }
  const parsed = parseWorkspaceRelocationRecoveryStartRequest(request)
  assert.deepEqual(parsed, request); assert.ok(Object.isFrozen(parsed))
  assert.ok('completion_sha256' in parsed)
  request.completion_sha256 = 'c'.repeat(64); assert.equal(parsed.completion_sha256, 'a'.repeat(64))
  for (const invalid of [null, [], { ...request, confirmed: false }, { ...request, pid: 1 }, { ...request, authorization: 'body' },
    { ...request, recovery_id: request.recovery_id.toUpperCase() }, { ...request, completion_sha256: 'a'.repeat(63) }]) {
    assert.throws(() => parseWorkspaceRelocationRecoveryStartRequest(invalid), { code: 'INVALID_PARAMS' })
  }
})

test('interrupted confirmation fixes only its checkpoint and cannot select an action or mix archive authority', () => {
  const request = { intent_id: '12345678-1234-4123-8123-123456789abc', recovery_id: '87654321-4321-4321-8321-cba987654321',
    checkpoint_sha256: 'a'.repeat(64), confirmed: true as const }
  const parsed = parseWorkspaceRelocationRecoveryStartRequest(request)
  assert.deepEqual(parsed, request); assert.ok(Object.isFrozen(parsed)); assert.ok('checkpoint_sha256' in parsed)
  request.checkpoint_sha256 = 'b'.repeat(64); assert.equal(parsed.checkpoint_sha256, 'a'.repeat(64))
  for (const invalid of [{ ...request, confirmed: false }, { ...request, action: 'finish_commit' }, { ...request, path: '/forged' },
    { ...request, completion_sha256: 'c'.repeat(64) }, { ...request, finalizing_sha256: 'd'.repeat(64) },
    { ...request, recovery_id: request.recovery_id.toUpperCase() }, { ...request, checkpoint_sha256: 'A'.repeat(64) }]) {
    assert.throws(() => parseWorkspaceRelocationRecoveryStartRequest(invalid), { code: 'INVALID_PARAMS' })
  }
})
