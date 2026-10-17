import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { readInstanceRuntime, inspectInstance, clearInstanceRuntime, identity } from '../instance-runtime.mjs'
import { stopInstance } from '../instance-controller.mjs'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function fixture(t, delay = 100) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'crabot-instance-中文 space-')))
  const data = join(root, 'data'), marker = join(root, 'stopped'), ready = join(root, 'ready')
  mkdirSync(join(root, 'crabot-core', 'dist'), { recursive: true }); mkdirSync(data)
  copyFileSync(new URL('./fixtures/core.mjs', import.meta.url), join(root, 'crabot-core', 'dist', 'main.js'))
  // The fixture main.js is explicitly ESM even when tests use Node 22.
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  const probe = createServer().listen(0, '127.0.0.1'); await once(probe, 'listening')
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/managed-core.mjs', import.meta.url))], {
    env: { ...process.env, TEST_CORE_ROOT: root, TEST_DATA_DIR: data, TEST_PORT: String(port), TEST_MARKER: marker, TEST_READY: ready, TEST_STOP_DELAY: String(delay) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
  const exited = once(child, 'exit')
  t.after(async () => {
    // Only fixture-owned identities are eligible for cleanup; production is never addressed.
    let record
    try { record = readInstanceRuntime(data) } catch {}
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    if (record?.mm && identity.sameProcess(record.mm, identity.inspectProcess(record.mm.pid))) process.kill(record.mm.pid, 'SIGKILL')
    await exited.catch(() => {})
    rmSync(root, { recursive: true, force: true })
  })
  const deadline = Date.now() + 10_000
  while (!existsSync(ready)) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error('Fixture failed: ' + output)
    await pause(25)
  }
  return { root, data, marker, child, exited, record: readInstanceRuntime(data) }
}

test('verified controller and MM stop gracefully; a terminal waiting process holds no lifecycle lock', async t => {
  const f = await fixture(t)
  assert.equal(inspectInstance(f.data).state, 'running')
  assert.equal(f.record.controller.pid, f.child.pid)
  assert.notEqual(f.record.mm.pid, f.child.pid)
  await stopInstance(f.data)
  assert.equal(readFileSync(f.marker, 'utf8'), 'graceful')
  assert.equal(readInstanceRuntime(f.data), null)
  assert.equal(inspectInstance(f.data).state, 'stopped')
  await f.exited
})

test('a reused or forged start identity is refused without signalling the unrelated process', async t => {
  const f = await fixture(t)
  const file = join(f.data, 'instance-runtime.json')
  writeFileSync(file, JSON.stringify({ ...f.record, controller: { ...f.record.controller, started: 'different incarnation' } }))
  await assert.rejects(stopInstance(f.data), { code: 'CRABOT_INSTANCE_UNVERIFIED' })
  assert.equal(identity.sameProcess(f.record.controller, identity.inspectProcess(f.child.pid)), true)
  assert.equal(existsSync(f.marker), false)
  writeFileSync(file, JSON.stringify(f.record))
  await stopInstance(f.data)
})

test('late cleanup cannot remove the replacement generation or its mm.pid', async t => {
  const f = await fixture(t)
  assert.equal(clearInstanceRuntime(f.data, '00000000-0000-0000-0000-000000000000'), false)
  assert.equal(readInstanceRuntime(f.data).generation, f.record.generation)
  assert.equal(readFileSync(join(f.data, 'mm.pid'), 'utf8'), String(f.child.pid))
  await stopInstance(f.data)
})

test('legacy PID alone is not adopted and an MM shutdown window cannot be shortened', async t => {
  const root = mkdtempSync(join(tmpdir(), 'crabot-legacy-pid-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'mm.pid'), String(process.pid))
  assert.equal(inspectInstance(root).state, 'legacy')
  await assert.rejects(stopInstance(root), { code: 'CRABOT_LEGACY_INSTANCE' })
  await assert.rejects(stopInstance(root, { timeoutMs: 10 }), /Cannot shorten/)
})

test('shutdown keeps the full MM window, exceeding the old Unix 15 second deadline', { timeout: 30_000 }, async t => {
  const f = await fixture(t, 16_000)
  const start = Date.now()
  await stopInstance(f.data)
  assert.ok(Date.now() - start >= 15_900)
  assert.equal(readFileSync(f.marker, 'utf8'), 'graceful')
})
