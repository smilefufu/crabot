import test from 'node:test'
import assert from 'node:assert/strict'
import { openSync, closeSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runBounded } from '../run-bounded.mjs'

test('ordinary commands retain zero-only success while an explicit native exit-code set is copied', async () => {
  await runBounded(process.execPath, ['-e', 'process.exit(0)'])
  await assert.rejects(runBounded(process.execPath, ['-e', 'process.exit(7)']), /code 7/)
  const successCodes = [1]
  const running = runBounded(process.execPath, ['-e', 'setTimeout(() => process.exit(1), 30)'], { successCodes })
  successCodes.length = 0
  await running
  await assert.rejects(runBounded(process.execPath, ['-e', 'process.exit(8)'], { successCodes: [0, 1] }), /code 8/)
})

test('an owned POSIX preparation child receives only its explicit extra descriptor', { skip: process.platform === 'win32' }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'crabot-bounded-fd-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'owned-output'), fd = openSync(file, 'wx', 0o600)
  try {
    await runBounded(process.execPath, ['-e', "require('node:fs').writeSync(3, 'owned descriptor')"], { extraFileDescriptors: [fd] })
  } finally { closeSync(fd) }
  assert.equal(readFileSync(file, 'utf8'), 'owned descriptor')
})

test('invalid success codes and descriptors reject before a preparation process is launched', () => {
  for (const successCodes of [[], [-1], [256], [1.5], ['0']]) {
    assert.throws(() => runBounded('must-not-launch', [], { successCodes }), /success codes/)
  }
  for (const fd of [-1, NaN, 1.5, '3']) {
    assert.throws(() => runBounded('must-not-launch', [], { extraFileDescriptors: [fd] }), /file descriptors/)
  }
})
