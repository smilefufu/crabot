import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs, { promises as files } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const supported = process.platform !== 'win32'
let area, program
before(async () => {
  if (!supported) return
  area = await files.realpath(await files.mkdtemp(path.join(tmpdir(), 'crabot-gtk-pipe-')))
  program = path.join(area, 'finite-protocol-peer')
  execFileSync('/usr/bin/cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', fileURLToPath(new URL('./fixtures/removal-progress-peer.c', import.meta.url)), '-o', program], { timeout: 30000 })
})
after(async () => { if (area) await files.rm(area, { recursive: true, force: true }) })
async function fixture(t, mode = 'normal') {
  const directory = await files.mkdtemp(path.join(area, 'host-')), executable = path.join(directory, 'crabot-maintenance')
  await files.copyFile(program, executable); await files.chmod(executable, 0o700)
  await files.writeFile(path.join(directory, 'behavior'), mode)
  const bytes = await files.readFile(executable), frontend = { type: 'file', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mode: 0o700 }
  const abort = new AbortController()
  const create = async () => (await import('../dist/ubuntu-removal-progress.js')).createUbuntuRemovalProgressWindow({ directory, frontend, abort })
  let window
  t.after(async () => { if (window) await window.close() })
  return { directory, executable, frontend, abort, create: async () => window = await create() }
}
async function until(check) {
  const deadline = Date.now() + 2000
  while (!check()) { if (Date.now() >= deadline) throw new Error('Finite peer did not reach assertion'); await new Promise(resolve => setTimeout(resolve, 10)) }
}
for (const mode of ['normal', 'cancel', 'duplicate-cancel', 'uncancellable']) test('private native progress peer: ' + mode, { skip: !supported, timeout: 15000 }, async t => {
  const f = await fixture(t, mode), window = await f.create()
  window.assertReady(); window.update('正在核验原安装', mode !== 'uncancellable')
  if (mode.includes('cancel') && mode !== 'uncancellable') { await until(() => f.abort.signal.aborted); assert.equal(f.abort.signal.reason.name, 'AbortError') }
  else { await new Promise(resolve => setTimeout(resolve, 60)); assert.equal(f.abort.signal.aborted, false) }
  await window.close(); await window.close(); assert.throws(() => window.assertReady())
  assert.equal(await files.readFile(path.join(f.directory, 'behavior'), 'utf8'), mode)
})
for (const mode of ['exit', 'invalid', 'oversize']) test('bad GTK startup cannot authorize a ready window: ' + mode, { skip: !supported, timeout: 15000 }, async t => {
  const f = await fixture(t, mode)
  await assert.rejects(f.create()); assert.equal(f.abort.signal.aborted, true)
})
test('a bad later frame fails the existing window without executing an action', { skip: !supported, timeout: 15000 }, async t => {
  const f = await fixture(t, 'late-invalid'), window = await f.create()
  window.update('正在核验', false); await until(() => f.abort.signal.aborted)
  assert.equal(f.abort.signal.reason.code, 'CRABOT_DESKTOP_REMOVAL'); assert.throws(() => window.update('不能继续', true)); await window.close()
})
test('unresponsive frontend cleanup confirms the exact native process generation exits', { skip: !supported, timeout: 15000 }, async t => {
  const f = await fixture(t, 'ignore-close'), window = await f.create()
  await window.close(); assert.throws(() => window.assertReady())
})
for (const mode of ['changed', 'symlink', 'hardlink', 'public-root', 'bad-digest', 'bad-mode', 'pre-cancelled']) test('unverified progress programs are never spawned: ' + mode, { skip: !supported, timeout: 15000 }, async t => {
  const f = await fixture(t)
  if (mode === 'changed') await files.appendFile(f.executable, 'changed')
  if (mode === 'symlink') { await files.unlink(f.executable); await files.symlink(program, f.executable) }
  if (mode === 'hardlink') await files.link(f.executable, path.join(f.directory, 'linked'))
  if (mode === 'public-root') await files.chmod(f.directory, 0o755)
  if (mode === 'bad-digest') f.frontend.sha256 = '0'.repeat(64)
  if (mode === 'bad-mode') f.frontend.mode = 0o777
  if (mode === 'pre-cancelled') f.abort.abort()
  await assert.rejects(f.create())
  await assert.rejects(files.lstat(path.join(f.directory, 'spawned')), { code: 'ENOENT' })
})
test('frontend inherits only display variables, never the agent environment or secrets', { skip: !supported, timeout: 15000 }, async t => {
  const f = await fixture(t), keys = ['NODE_OPTIONS', 'DATA_DIR', 'ADMIN_TOKEN', 'CRABOT_PRODUCT_ROOT'], previous = keys.map(key => process.env[key])
  try {
    for (const key of keys) process.env[key] = 'must-not-reach-the-frontend'
    const window = await f.create(); window.update('显示已就绪', false); await window.close()
  } finally { keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i] }) }
})

test('duplicate readiness fails the window whether delivered in one chunk or later', { skip: !supported, timeout: 15000 }, async t => {
  const f = await fixture(t, 'duplicate-ready')
  let window
  try { window = await f.create() } catch { assert.equal(f.abort.signal.aborted, true); return }
  await until(() => f.abort.signal.aborted); assert.throws(() => window.assertReady()); await window.close()
})

test('a silent frontend cannot pass readiness or survive its bounded startup cleanup', { skip: !supported, timeout: 18000 }, async t => {
  const f = await fixture(t, 'silent')
  await assert.rejects(f.create()); assert.equal(f.abort.signal.reason.code, 'CRABOT_DESKTOP_REMOVAL')
  const pid = Number(await files.readFile(path.join(f.directory, 'spawned'), 'utf8'))
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})
test('startup cancellation waits for this actual process to leave', { skip: !supported, timeout: 12000 }, async t => {
  const f = await fixture(t, 'silent'), pending = f.create()
  void pending.catch(() => {})
  await until(() => fs.existsSync(path.join(f.directory, 'spawned'))); f.abort.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  const pid = Number(await files.readFile(path.join(f.directory, 'spawned'), 'utf8'))
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})
test('actual same-source GTK maps, displays progress and exits through the private pipe', {
  skip: process.platform !== 'linux' || !process.env.CRABOT_GTK_FRONTEND, timeout: 15000,
}, async t => {
  const directory = await files.mkdtemp(path.join(area, 'actual-gtk-')), executable = path.join(directory, 'crabot-maintenance')
  await files.copyFile(process.env.CRABOT_GTK_FRONTEND, executable); await files.chmod(executable, 0o700)
  const bytes = await files.readFile(executable), frontend = { type: 'file', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mode: 0o700 }
  const abort = new AbortController(), { createUbuntuRemovalProgressWindow } = await import('../dist/ubuntu-removal-progress.js')
  const window = await createUbuntuRemovalProgressWindow({ directory, frontend, abort })
  t.after(() => window.close()); window.assertReady(); window.update('正在核验原安装，用户数据将保留…', false)
  await window.close(); assert.equal(abort.signal.aborted, false)
  console.log('CRABOT_GTK_PIPE_RESULT ' + JSON.stringify({ actual_gtk: true, private_stdio: true, window_mapped: true, business_mm_started: false }))
})
