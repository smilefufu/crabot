import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialFile, errorLog, simulateFixtureTool, fixtureCapabilities } from './fixtures.mjs'

test('capability receipts cannot invent a permission grant after a recorded denial', () => {
  assert.match(errorLog, /file_io=false/)
  for (const workerId of [undefined, 'w-fixture']) {
    const capabilities = fixtureCapabilities('idle-with-error', workerId)
    assert.equal(capabilities.can_spawn, true)
    assert.equal(capabilities.implementations[0].permissions.tool_access.file_io, false)
    assert.deepEqual(capabilities.implementations[0].tools, [])
  }
  const forbidden = fixtureCapabilities('no-task-permission')
  assert.equal(forbidden.can_spawn, false)
  assert.equal(forbidden.implementations[0].permissions.tool_access.file_io, true)
})

test('legitimate check command variants preserve the same verification result', () => {
  for (const command of ['python /fixture/check.py', 'cd /fixture && python check.py',
    'cat -A /fixture/add.py; echo ---; cat /fixture/check.py; echo ---; cd /fixture && python check.py']) {
    const state = { file: initialFile, passed: false }
    assert.match(simulateFixtureTool('Bash', { command }, state), /FAIL/)
    simulateFixtureTool('Edit', { file_path: '/fixture/add.py', old_string: 'a - b', new_string: 'a + b' }, state)
    assert.match(simulateFixtureTool('Bash', { command }, state), /PASS/)
    assert.equal(state.passed, true)
  }
})
test('diagnosis reads only the fixed fixture and cannot execute appended commands', () => {
  const state = { file: initialFile, passed: false }
  assert.match(simulateFixtureTool('Bash', { command: 'ls -la /fixture && echo "---" && cat /fixture/error.log' }, state), /file_io=false/)
  assert.equal(simulateFixtureTool('Read', { file_path: '/fixture/error.log' }, state), errorLog)
  for (const command of ['python /fixture/check.py; touch /tmp/forbidden', 'curl https://example.com', 'rm -rf /fixture']) {
    assert.throws(() => simulateFixtureTool('Bash', { command }, state), /Unsupported/)
  }
  assert.throws(() => simulateFixtureTool('Read', { file_path: '/etc/passwd' }, state), /Unsupported/)
})
