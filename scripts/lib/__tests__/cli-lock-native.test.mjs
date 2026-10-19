import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import native from '../process-identity.cjs'
import { acquireCliLock, acquireStartupLock, releaseCliLock, cliLockToken, hasInheritedCliLock } from '../cli-lock.mjs'

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


test('persistent relocation blocks ordinary commands even after the OS lock has been released', async t => {
  const dir = directory(t), initial = await acquireCliLock(dir, 'fixture')
  releaseCliLock(initial)
  mkdirSync(join(dir, 'workspace-control')); writeFileSync(join(dir, 'workspace-control/relocation.json'), 'pending')
  const before = readFileSync(join(dir, 'cli.lock'), 'utf8')
  for (const command of ['stop', 'restart', 'upgrade', 'start', 'desktop-stop']) {
    await assert.rejects(acquireCliLock(dir, command, 0), { code: 'WORKSPACE_MAINTENANCE' })
  }
  assert.equal(readFileSync(join(dir, 'cli.lock'), 'utf8'), before)
  const recovery = await acquireStartupLock(dir, 'management-start', 0)
  releaseCliLock(recovery)
  assert.equal(readFileSync(join(dir, 'workspace-control/relocation.json'), 'utf8'), 'pending')
})


test('a fence appearing at native lock acquisition rejects the operation and releases its handle', async t => {
  const dir = directory(t), original = native.tryFileLock
  const mocked = t.mock.method(native, 'tryFileLock', function(...args) {
    const handle = original(...args)
    if (handle) { mkdirSync(join(dir, 'workspace-control')); writeFileSync(join(dir, 'workspace-control/relocation.json'), 'late intent') }
    return handle
  })
  await assert.rejects(acquireCliLock(dir, 'restart', 0), { code: 'WORKSPACE_MAINTENANCE' })
  mocked.mock.restore()
  const management = await acquireStartupLock(dir, 'management-start', 0)
  releaseCliLock(management)
})
