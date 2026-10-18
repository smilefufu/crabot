import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSystemArguments } from '../system-arguments.mjs'
test('batch all is explicit; unknown flags, arbitrary commands and user lists cannot expand scope', () => {
  assert.deepEqual(parseSystemArguments(['start', '--all']), { action: 'start', all: true, yes: false })
  assert.deepEqual(parseSystemArguments(['restart', '--yes', '--all']), { action: 'restart', all: true, yes: true })
  for (const args of [['stop'], ['restart', '--all', '--force'], ['start', '--all', '--all'], ['start', 'alice'], ['exec', '--all'], ['status', '--all']]) assert.throws(() => parseSystemArguments(args))
})
test('administrator user commands do not accept UID/path/shell substitutions', () => {
  assert.deepEqual(parseSystemArguments(['user', 'add', 'alice', '--autostart']), { action: 'user', operation: 'add', user: 'alice', autostart: true })
  for (const args of [['user', 'remove', 'alice', '--autostart'], ['user', 'add', '--uid=0'], ['user', 'add', 'alice', '--home=/root'], ['user', 'add', 'alice', 'bob']]) assert.throws(() => parseSystemArguments(args))
})
