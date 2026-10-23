import assert from 'node:assert/strict'
import test from 'node:test'
import { parseWorkspaceRelocationRecoveryStartRequest } from './workspace-recovery-start-request.js'

test('recovery confirmation is closed, fixed and never carries body authority', () => {
  const request = { intent_id: '12345678-1234-4123-8123-123456789abc', recovery_id: '87654321-4321-4321-8321-cba987654321',
    completion_sha256: 'a'.repeat(64), finalizing_sha256: 'b'.repeat(64), confirmed: true as const }
  const parsed = parseWorkspaceRelocationRecoveryStartRequest(request)
  assert.deepEqual(parsed, request); assert.ok(Object.isFrozen(parsed))
  request.completion_sha256 = 'c'.repeat(64); assert.equal(parsed.completion_sha256, 'a'.repeat(64))
  for (const invalid of [null, [], { ...request, confirmed: false }, { ...request, pid: 1 }, { ...request, authorization: 'body' },
    { ...request, recovery_id: request.recovery_id.toUpperCase() }, { ...request, completion_sha256: 'a'.repeat(63) }]) {
    assert.throws(() => parseWorkspaceRelocationRecoveryStartRequest(invalid), { code: 'INVALID_PARAMS' })
  }
})
