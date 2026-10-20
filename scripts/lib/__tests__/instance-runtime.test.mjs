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
async function settleClose(closed, milliseconds) {
  let timer
  try { await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, milliseconds) })]) }
  finally { clearTimeout(timer) }
}
async function fixture(t, delay = 100, registrationDelay = 0, { forceRegistrationFailure = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'crabot-instance-中文 space-')))
  const data = join(root, 'data'), marker = join(root, 'stopped'), ready = join(root, 'ready')
  mkdirSync(join(root, 'crabot-core', 'dist'), { recursive: true }); mkdirSync(data)
  copyFileSync(new URL('./fixtures/core.mjs', import.meta.url), join(root, 'crabot-core', 'dist', 'main.js'))
  // The fixture main.js is explicitly ESM even when tests use Node 22.
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  const probe = createServer().listen(0, '127.0.0.1'); await once(probe, 'listening')
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/managed-core.mjs', import.meta.url))], {
    env: { ...process.env, TEST_CORE_ROOT: root, TEST_DATA_DIR: data, TEST_PORT: String(port), TEST_MARKER: marker, TEST_READY: ready, TEST_STOP_DELAY: String(delay), TEST_REGISTER_DELAY: String(registrationDelay), TEST_IDENTITY_REPORT: join(root, 'identity-report.json'), TEST_FORCE_REGISTRATION_FAILURE: forceRegistrationFailure ? '1' : '', TEST_CONTROLLER_LOG: join(root, 'controller.log') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
  const exited = once(child, 'exit'), closed = once(child, 'close').catch(() => {})
  t.after(async () => {
    // Only fixture-owned identities are eligible for cleanup; production is never addressed.
    let record
    try { record = readInstanceRuntime(data) } catch {}
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    if (record?.mm && identity.sameProcess(record.mm, identity.inspectProcess(record.mm.pid))) process.kill(record.mm.pid, 'SIGKILL')
    await exited.catch(() => {})
    await settleClose(closed, 3000)
    rmSync(root, { recursive: true, force: true })
  })
  const deadline = Date.now() + 10_000
  let record
  while (!existsSync(ready) || !(record = readInstanceRuntime(data))?.mm) {
    if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) {
      if (child.exitCode !== null || child.signalCode !== null) await settleClose(closed, 1000)
      const read = name => { try { return JSON.parse(readFileSync(join(root, name), 'utf8')) } catch { return null } }
      const controllerLog = existsSync(join(root, 'controller.log')) ? readFileSync(join(root, 'controller.log'), 'utf8').slice(-6000) : ''
      throw new Error('Fixture failed: ' + JSON.stringify({ exit_code: child.exitCode, signal: child.signalCode, ready: existsSync(ready),
        identity: read('identity-report.json'), runtime: read('data/instance-runtime.json'), controller_log: controllerLog, output: output.slice(-6000) }))
    }
    await pause(25)
  }
  return { root, data, marker, child, exited, record, snapshot: () => {
    const observed = process => {
      try { return identity.sameProcess(process, identity.inspectProcess(process.pid)) ? 'alive' : 'gone' }
      catch { return 'unknown' }
    }
    return { shutdown_requested: existsSync(marker), controller: observed(record.controller), mm: observed(record.mm), output: output.slice(-3000) }
  } }
}

test('verified controller and MM stop gracefully; a terminal waiting process holds no lifecycle lock', async t => {
  const f = await fixture(t, 100, 250)
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

test('a transient identity failure during stop waits for evidence instead of reporting stopped or signalling an unknown process', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  const inspect = identity.inspectProcess
  let probes = 0
  try {
    await stopInstance(f.data, { log: message => {
      if (!message.startsWith('Stopping generation')) return
      identity.inspectProcess = pid => {
        if (pid === f.record.mm.pid && probes++ < 2) throw Object.assign(new Error('fixture transient identity failure'), { code: 'CRABOT_PROCESS_IDENTITY' })
        return inspect(pid)
      }
    } })
    assert.ok(probes >= 3)
    assert.equal(readFileSync(f.marker, 'utf8'), 'graceful')
    assert.equal(readInstanceRuntime(f.data), null)
  } finally { identity.inspectProcess = inspect }
})

test('status JSON uses the verified MM and discovered Admin port, and never repairs forged identity', async t => {
  const f = await fixture(t)
  const statusEntry = fileURLToPath(new URL('../../status.mjs', import.meta.url))
  async function status() {
    const child = spawn(process.execPath, [statusEntry, '--json'], {
      env: { ...process.env, DATA_DIR: f.data, HOME: f.root, USERPROFILE: f.root, CRABOT_PORT_OFFSET: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
    const [code] = await once(child, 'exit')
    assert.equal(code, 0, stderr)
    return { body: JSON.parse(stdout), stderr }
  }
  const healthy = await status()
  assert.equal(healthy.body.running, true)
  assert.equal(healthy.body.endpoints.mm.url, `http://localhost:${f.record.mm_port}`)
  assert.equal(healthy.body.endpoints.admin_rpc.url, 'http://localhost:23456')
  const file = join(f.data, 'instance-runtime.json')
  const forged = JSON.stringify({ ...f.record, controller: { ...f.record.controller, started: 'wrong incarnation' } })
  writeFileSync(file, forged)
  const unverified = await status()
  assert.equal(unverified.body.running, false)
  assert.match(unverified.stderr, /Cannot verify instance identity/)
  assert.equal(readFileSync(file, 'utf8'), forged)
  writeFileSync(file, JSON.stringify(f.record))
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
  const started = Date.now(), events = []
  let f, phase = 'fixture-starting'
  const report = () => {
    t.diagnostic('fixture-only shutdown timeout: ' + JSON.stringify({ phase, elapsed_ms: Date.now() - started, events, ...(f?.snapshot() ?? {}) }))
  }
  t.signal.addEventListener('abort', report, { once: true })
  try {
    f = await fixture(t, 16_000)
    phase = 'stopping'
    const start = Date.now()
    await stopInstance(f.data, { log: message => { events.push({ elapsed_ms: Date.now() - started, message }) } })
    phase = 'stopped'
    assert.ok(Date.now() - start >= 15_900)
    assert.equal(readFileSync(f.marker, 'utf8'), 'graceful')
  } finally { t.signal.removeEventListener('abort', report) }
})


test('failed startup fixture reports the exit and identity evidence before cleaning its own processes', async t => {
  await assert.rejects(fixture(t, 100, 0, { forceRegistrationFailure: true }), error => {
    assert.match(error.message, /"exit_code":1/)
    assert.match(error.message, /"forced":true/)
    const report = JSON.parse(error.message.slice('Fixture failed: '.length))
    assert.equal(report.runtime.mm, null)
    assert.match(report.controller_log, /MM registration failed.*CRABOT_INSTANCE_UNVERIFIED/)
    return true
  })
})

for (let iteration = 0; iteration < 8; iteration++) test('Windows repeated Unicode-path registration retains exact parent identity through delayed startup: ' + (iteration + 1), { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const began = Date.now(); let phase = 'ready', f
  const diagnostic = () => t.diagnostic(JSON.stringify({ iteration: iteration + 1, phase, elapsed_ms: Date.now() - began, ...(f ? f.snapshot() : {}) }))
  t.signal.addEventListener('abort', diagnostic, { once: true })
  try {
    f = await fixture(t, 100, 250)
    t.diagnostic('ready_ms=' + (Date.now() - began))
    assert.equal(inspectInstance(f.data).state, 'running')
    phase = 'stop'
    const stopping = Date.now()
    await stopInstance(f.data)
    t.diagnostic('stop_ms=' + (Date.now() - stopping))
    assert.equal(readFileSync(f.marker, 'utf8'), 'graceful')
    assert.equal(readInstanceRuntime(f.data), null)
    await f.exited
  } catch (error) { diagnostic(); throw error }
  finally { t.signal.removeEventListener('abort', diagnostic) }
})
