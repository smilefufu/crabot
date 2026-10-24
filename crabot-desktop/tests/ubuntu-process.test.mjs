import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { runUbuntuProcess, ubuntuDesktopEnvironment } from '../dist/ubuntu-process.js'
const identity = createRequire(import.meta.url)('../../scripts/lib/process-identity.cjs')
const posix = { skip: process.platform === 'win32', timeout: 5000 }

test('desktop process environment preserves OS display access without Agent/Admin or loader variables', () => {
  const result = ubuntuDesktopEnvironment({ DISPLAY: ':4', XAUTHORITY: '/os/auth', WAYLAND_DISPLAY: 'wayland-0', DBUS_SESSION_BUS_ADDRESS: 'os-bus',
    NODE_OPTIONS: 'unsafe', DATA_DIR: '/business', ADMIN_TOKEN: 'secret', API_KEY: 'secret', PATH: '/agent/custom' })
  assert.deepEqual(result, { DISPLAY: ':4', XAUTHORITY: '/os/auth', WAYLAND_DISPLAY: 'wayland-0', DBUS_SESSION_BUS_ADDRESS: 'os-bus', PATH: '/usr/bin:/bin' })
})
test('owned process waits for actual stream close and observes a late child diagnostic', posix, async () => {
  const child = `require('node:child_process').spawn(process.execPath,['-e',"setTimeout(()=>process.stderr.write('late diagnostic'),80)"],{stdio:['ignore','ignore','inherit']});process.exit(0)`
  const result = await runUbuntuProcess(process.execPath, ['-e', child], ubuntuDesktopEnvironment(process.env), 3000, new AbortController().signal)
  assert.deepEqual(result, { code: 0, diagnostic: 'late diagnostic' })
})
test('nonzero exit retains bounded diagnostics without inventing an installation result', posix, async () => {
  const result = await runUbuntuProcess(process.execPath, ['-e', "process.stderr.write('x'.repeat(20000));process.exitCode=7"], ubuntuDesktopEnvironment(process.env), 3000, new AbortController().signal)
  assert.equal(result.code, 7); assert.equal(result.diagnostic.length, 8192)
})
test('cancelling reaps the exact owned live process before returning; pre-cancel never spawns', posix, async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'crabot-owned-ubuntu-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const ready = path.join(root, 'ready'), abort = new AbortController()
  const pending = runUbuntuProcess(process.execPath, ['-e', "require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)", ready],
    ubuntuDesktopEnvironment(process.env), 3000, abort.signal)
  const deadline = Date.now() + 2000; let pid
  while (!pid && Date.now() < deadline) {
    try { pid = Number(await fs.readFile(ready, 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw error; await new Promise(resolve => setTimeout(resolve, 10)) }
  }
  assert.ok(pid); const original = identity.inspectProcess(pid); assert.ok(original)
  abort.abort(); await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(identity.sameProcess(original, identity.inspectProcess(pid)), false)
  await assert.rejects(runUbuntuProcess('/never-execute', [], {}, 100, abort.signal), { name: 'AbortError' })
})
test('owned deadline and spawn failures finish without successful readiness', posix, async () => {
  const result = await runUbuntuProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {}, 80, new AbortController().signal)
  assert.notEqual(result.code, 0)
  await assert.rejects(runUbuntuProcess('/nonexistent-crabot-program', [], {}, 100, new AbortController().signal), { code: 'ENOENT' })
})

test('a parent exiting before stderr closes cannot turn an expired operation into success', posix, async () => {
  const child = `require('node:child_process').spawn(process.execPath,['-e',"setTimeout(()=>process.stderr.write('too late'),200)"],{stdio:['ignore','ignore','inherit']});process.exit(0)`
  const result = await runUbuntuProcess(process.execPath, ['-e', child], {}, 80, new AbortController().signal)
  assert.notEqual(result.code, 0)
})
