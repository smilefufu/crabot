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
  for (const args of [['user', 'remove', 'alice', '--autostart'], ['user', 'add', 'alice', '--autostart', '--no-autostart'], ['user', 'add', '--uid=0'], ['user', 'add', 'alice', '--home=/root'], ['user', 'add', 'alice', 'bob']]) assert.throws(() => parseSystemArguments(args))
})


test('omitted autostart preserves an existing selection; only explicit flags change it', () => {
  assert.equal(parseSystemArguments(['user', 'add', 'alice']).autostart, undefined)
  assert.equal(parseSystemArguments(['user', 'add', 'alice', '--no-autostart']).autostart, false)
  assert.equal(parseSystemArguments(['user', 'add', 'alice', '--autostart']).autostart, true)
})


test('recovery defaults to observation and requires one explicit safe action to accept --yes', () => {
  const id = '11111111-1111-1111-1111-111111111111'
  assert.deepEqual(parseSystemArguments(['recover', id]), { action: 'recover', id, mode: undefined, yes: false })
  assert.equal(parseSystemArguments(['recover', id, '--continue', '--yes']).mode, 'continue')
  assert.equal(parseSystemArguments(['recover', id, '--cancel']).mode, 'cancel')
  for (const flags of [['--yes'], ['--continue', '--cancel'], ['--continue', '--force'], ['--cancel', '--cancel']]) assert.throws(() => parseSystemArguments(['recover', id, ...flags]))
  for (const id of ['../outside', 'x;reboot', '']) assert.throws(() => parseSystemArguments(['recover', id, '--continue']))
})
