import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { acquireCliLock, releaseCliLock, cliLockToken, hasInheritedCliLock } from '../cli-lock.mjs'

function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'crabot-native-lock-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('concurrent operations are bounded and an inherited lock requires the actual owner token', async t => {
  const dir = directory(t)
  const lock = await acquireCliLock(dir, 'start')
  assert.equal(hasInheritedCliLock(dir, '1'), false)
  assert.equal(hasInheritedCliLock(dir, cliLockToken(lock)), true)
  await assert.rejects(acquireCliLock(dir, 'stop', 25), /operation is in progress/)
  const token = cliLockToken(lock)
  releaseCliLock(lock)
  assert.equal(hasInheritedCliLock(dir, token), false)
  const next = await acquireCliLock(dir, 'stop', 25)
  releaseCliLock(next)
})

test('crashed owner releases the OS lock without stale-file races; corrupt metadata does not spin', async t => {
  const dir = directory(t)
  const source = `import {acquireCliLock} from ${JSON.stringify(new URL('../cli-lock.mjs', import.meta.url).href)};await acquireCliLock(process.argv[1],'fixture');process.send('locked');setInterval(()=>{},1000)`
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, dir], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  await once(child, 'message')
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
  writeFileSync(join(dir, 'cli.lock'), '{broken')
  const lock = await acquireCliLock(dir, 'recover', 100)
  releaseCliLock(lock)
})
