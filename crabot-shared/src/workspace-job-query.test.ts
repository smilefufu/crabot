import test from 'node:test'
import assert from 'node:assert/strict'
import { parseWorkspaceRelocationJobQuery } from './workspace-job-query.js'

const id = '12345678-1234-4123-8123-123456789abc'
test('read-only query fixes only a current or canonical job identity and grants no initial confirmation', () => {
  assert.deepEqual(parseWorkspaceRelocationJobQuery({}), {})
  const input = { intent_id: id }, result = parseWorkspaceRelocationJobQuery(input)
  input.intent_id = '22345678-1234-4123-8123-123456789abc'
  assert.deepEqual(result, { intent_id: id }); assert.equal(Object.isFrozen(result), true)
  for (const bad of [null, [], '', { intent_id: undefined }, { intent_id: id.toUpperCase() }, { intent_id: '../private' },
    { intent_id: id, confirmed: true }, { intent_id: id, target: '/private' }, { source: 'admin-web' }, { token: 'body-credential' }]) {
    assert.throws(() => parseWorkspaceRelocationJobQuery(bad), { code: 'INVALID_PARAMS' })
  }
})
