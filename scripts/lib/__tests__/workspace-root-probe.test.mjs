import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import cp from 'node:child_process'
import crypto from 'node:crypto'
import { once } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { tmpdir } from 'node:os'
import native from '../process-identity.cjs'
import { probeWorkspaceDirectory } from '../workspace-root-probe.mjs'

function frame(directory) {
  const stat = fs.lstatSync(directory, { bigint: true })
  return { path: directory, dev: String(stat.dev), ino: String(stat.ino), native_id: process.platform === 'win32' ? native.inspectDirectoryFileId(directory) : null }
}
function fixture(t) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'workspace-probe-中文 space-'))), root = path.join(parent, 'root')
  fs.mkdirSync(root, { mode: 0o700 }); fs.writeFileSync(path.join(root, '.original'), 'original hidden work')
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  return { parent, root, directory: frame(root) }
}
const allowed = async () => () => {}

test('actual fixed Node probe writes and reads only its own temporary marker and releases the original directory', async t => {
  const f = fixture(t), cwd = process.cwd(), original = fs.readFileSync(path.join(f.root, '.original'))
  let authorizations = 0, checks = 0
  const result = await probeWorkspaceDirectory({ directory: f.directory, authorize: async () => { authorizations++; return () => { checks++ } } })
  assert.deepEqual(result, f.directory); assert.equal(authorizations, 2); assert.ok(checks >= 2)
  assert.deepEqual(fs.readdirSync(f.root), ['.original']); assert.deepEqual(fs.readFileSync(path.join(f.root, '.original')), original)
  assert.equal(process.cwd(), cwd)
  const moved = path.join(f.parent, 'moved'); fs.renameSync(f.root, moved); fs.renameSync(moved, f.root)
})
for (const change of ['wrong inode', 'wrong device', 'extra field', 'non-directory', 'link']) test('unverified directory is rejected without touching its contents: ' + change, async t => {
  const f = fixture(t), directory = { ...f.directory }
  if (change === 'wrong inode') directory.ino = '9999999999999999999'
  if (change === 'wrong device') directory.dev = '9999999999999999999'
  if (change === 'extra field') directory.command = 'do not execute'
  if (change === 'non-directory') directory.path = path.join(f.root, '.original')
  if (change === 'link') {
    directory.path = path.join(f.parent, 'linked'); fs.symlinkSync(f.root, directory.path, process.platform === 'win32' ? 'junction' : 'dir')
  }
  await assert.rejects(probeWorkspaceDirectory({ directory, authorize: allowed }), { code: 'WORKSPACE_ROOT_PROBE_UNVERIFIED' })
  assert.deepEqual(fs.readdirSync(f.root), ['.original']); assert.equal(fs.readFileSync(path.join(f.root, '.original'), 'utf8'), 'original hidden work')
})
test('rejected authorization performs no child launch or workspace I/O', async t => {
  const f = fixture(t), spawn = t.mock.method(cp, 'spawn', () => { throw new Error('unauthorized spawn') })
  syncBuiltinESMExports(); t.after(() => { spawn.mock.restore(); syncBuiltinESMExports() })
  await assert.rejects(probeWorkspaceDirectory({ directory: f.directory, authorize: async () => { throw new Error('original job revoked') } }))
  assert.equal(spawn.mock.callCount(), 0); assert.deepEqual(fs.readdirSync(f.root), ['.original'])
})
test('a root replaced while authorization waits never receives a marker', async t => {
  const f = fixture(t), retained = path.join(f.parent, 'original-root')
  await assert.rejects(probeWorkspaceDirectory({ directory: f.directory, authorize: async () => {
    fs.renameSync(f.root, retained); fs.mkdirSync(f.root); fs.writeFileSync(path.join(f.root, 'unrelated'), 'keep unrelated directory')
    return () => {}
  } }))
  assert.deepEqual(fs.readdirSync(f.root), ['unrelated']); assert.deepEqual(fs.readdirSync(retained), ['.original'])
})
for (const rejectAt of [2, 3]) test('synchronous revocation stops probe setup before permission can be used: check=' + rejectAt, async t => {
  const f = fixture(t); let checks = 0
  const originalSpawn = cp.spawn
  let launches = 0
  const observed = t.mock.method(cp, 'spawn', (...args) => { launches++; return originalSpawn(...args) })
  syncBuiltinESMExports(); t.after(() => { observed.mock.restore(); syncBuiltinESMExports() })
  await assert.rejects(probeWorkspaceDirectory({ directory: f.directory, authorize: async () => () => {
    if (++checks === rejectAt) throw new Error('original job was revoked')
  } }))
  assert.equal(checks, rejectAt); assert.equal(launches, rejectAt === 2 ? 0 : 1)
  assert.deepEqual(fs.readdirSync(f.root), ['.original'])
  const moved = path.join(f.parent, 'released'); fs.renameSync(f.root, moved); fs.renameSync(moved, f.root)
})
test('an existing marker is not overwritten or removed when exclusive creation fails', async t => {
  const f = fixture(t), nonce = '00000000-0000-4000-8000-000000000000', name = '.crabot-workspace-probe-' + nonce
  fs.writeFileSync(path.join(f.root, name), 'unrelated existing file')
  const random = t.mock.method(crypto, 'randomUUID', () => nonce)
  syncBuiltinESMExports(); t.after(() => { random.mock.restore(); syncBuiltinESMExports() })
  await assert.rejects(probeWorkspaceDirectory({ directory: f.directory, authorize: allowed }))
  assert.equal(fs.readFileSync(path.join(f.root, name), 'utf8'), 'unrelated existing file')
})
test('timeout stops only the actual probe generation and releases its directory handles', { timeout: 20000 }, async t => {
  const diagnostics = []
  t.mock.method(console, 'error', text => diagnostics.push(JSON.parse(text)))
  const f = fixture(t), sibling = cp.spawn(process.execPath, ['-e', 'process.send("ready");setTimeout(()=>{},30000)'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const siblingExit = once(sibling, 'exit'); await once(sibling, 'message')
  t.after(async () => { if (sibling.exitCode === null && sibling.signalCode === null) sibling.kill('SIGKILL'); await siblingExit })
  const siblingIdentity = native.inspectProcess(sibling.pid), spawn = cp.spawn
  let probe
  const replacement = t.mock.method(cp, 'spawn', (command, args, options) => {
    probe = spawn(command, ['-e', 'process.on("message",()=>{});setInterval(()=>{},1000)'], options)
    return probe
  })
  syncBuiltinESMExports(); t.after(() => { replacement.mock.restore(); syncBuiltinESMExports() })
  await assert.rejects(probeWorkspaceDirectory({ directory: f.directory, authorize: allowed }), { code: 'WORKSPACE_ROOT_PROBE_UNVERIFIED' })
  assert.equal(diagnostics[0].probe_event, 'deadline')
  assert.equal(Number.isSafeInteger(diagnostics[0].elapsed_ms), true)
  assert.equal(Number.isSafeInteger(diagnostics[0].submission_delay_ms), true)
  assert.equal(probe.exitCode !== null || probe.signalCode !== null, true)
  assert.equal(native.sameProcess(siblingIdentity, native.inspectProcess(sibling.pid)), true)
  assert.deepEqual(fs.readdirSync(f.root), ['.original'])
  const moved = path.join(f.parent, 'released'); fs.renameSync(f.root, moved); fs.renameSync(moved, f.root)
})

for (const result of [true, false, Promise.resolve()]) test('a synchronous guard result cannot silently replace a throwing authorization check: ' + typeof result, async t => {
  const f = fixture(t), spawn = t.mock.method(cp, 'spawn', () => { throw new Error('unsupported guard reached spawn') })
  syncBuiltinESMExports(); t.after(() => { spawn.mock.restore(); syncBuiltinESMExports() })
  await assert.rejects(probeWorkspaceDirectory({ directory: f.directory, authorize: async () => () => result }))
  assert.equal(spawn.mock.callCount(), 0); assert.deepEqual(fs.readdirSync(f.root), ['.original'])
})
test('a completed filesystem probe cannot succeed after its original job is revoked', async t => {
  const f = fixture(t); let checks = 0
  await assert.rejects(probeWorkspaceDirectory({ directory: f.directory, authorize: async () => {
    if (++checks === 2) throw new Error('original job no longer owns validation')
    return () => {}
  } }))
  assert.equal(checks, 2); assert.deepEqual(fs.readdirSync(f.root), ['.original'])
})

test('an actual executable spawn failure releases the acquired directory without reporting a successful probe', async t => {
  const f = fixture(t), spawn = cp.spawn
  const missing = t.mock.method(cp, 'spawn', (_command, args, options) => spawn(path.join(f.parent, 'absent-node'), args, options))
  syncBuiltinESMExports(); t.after(() => { missing.mock.restore(); syncBuiltinESMExports() })
  await assert.rejects(probeWorkspaceDirectory({ directory: f.directory, authorize: allowed }), { code: 'WORKSPACE_ROOT_PROBE_UNVERIFIED' })
  assert.deepEqual(fs.readdirSync(f.root), ['.original'])
  const moved = path.join(f.parent, 'released'); fs.renameSync(f.root, moved); fs.renameSync(moved, f.root)
})

for (const mode of ['missing completion', 'failed exit']) test('neither an exit nor a completion frame alone proves filesystem capability: ' + mode, async t => {
  const f = fixture(t), spawn = cp.spawn, diagnostics = []
  t.mock.method(console, 'error', text => diagnostics.push(JSON.parse(text)))
  const code = mode === 'missing completion'
    ? 'process.once("message",()=>{process.exitCode=0;process.disconnect()})'
    : 'process.once("message",frame=>process.send({kind:"workspace_root_probe_complete",nonce:frame.nonce,root:frame.root},()=>{process.exitCode=1;process.disconnect()}))'
  const replacement = t.mock.method(cp, 'spawn', (command, _args, options) => spawn(command, ['-e', code], options))
  syncBuiltinESMExports(); t.after(() => { replacement.mock.restore(); syncBuiltinESMExports() })
  await assert.rejects(probeWorkspaceDirectory({ directory: f.directory, authorize: allowed }), { code: 'WORKSPACE_ROOT_PROBE_UNVERIFIED' })
  assert.equal(diagnostics.length, 1)
  assert.equal(diagnostics[0].event, 'workspace_root_probe_failed')
  assert.equal(diagnostics[0].probe_event, mode === 'missing completion' ? 'disconnect' : 'child-exit')
  assert.equal(JSON.stringify(diagnostics).includes(f.root), false)
  assert.deepEqual(fs.readdirSync(f.root), ['.original'])
  const moved = path.join(f.parent, 'released'); fs.renameSync(f.root, moved); fs.renameSync(moved, f.root)
})


test('probe diagnostics retain only fixed technical failure facts and no private error text', async t => {
  const f = fixture(t), diagnostics = []
  t.mock.method(console, 'error', text => diagnostics.push(JSON.parse(text)))
  await assert.rejects(probeWorkspaceDirectory({ directory: f.directory, authorize: async () => { throw new Error('private-probe-secret ' + f.root) } }), { code: 'WORKSPACE_ROOT_PROBE_UNVERIFIED' })
  assert.equal(diagnostics.length, 1)
  const { elapsed_ms, submission_delay_ms, ...facts } = diagnostics[0]
  assert.equal(Number.isSafeInteger(elapsed_ms), true); assert.equal(submission_delay_ms, null)
  assert.deepEqual(facts, { event: 'workspace_root_probe_failed', stage: 'authorize', probe_event: null, accepted: false, exited: false, exit_code: null, exit_signal: null, native_exit_state: null })
  assert.equal(JSON.stringify(diagnostics).includes('private-probe-secret'), false)
  assert.equal(JSON.stringify(diagnostics).includes(f.root), false)
})


test('a diagnostic sink failure cannot skip the original failed-probe cleanup', async t => {
  const f = fixture(t), spawn = cp.spawn
  t.mock.method(console, 'error', () => { throw new Error('finite diagnostic sink failure') })
  const missing = t.mock.method(cp, 'spawn', (_command, args, options) => spawn(path.join(f.parent, 'absent-node'), args, options))
  syncBuiltinESMExports(); t.after(() => { missing.mock.restore(); syncBuiltinESMExports() })
  await assert.rejects(probeWorkspaceDirectory({ directory: f.directory, authorize: allowed }), { code: 'WORKSPACE_ROOT_PROBE_UNVERIFIED' })
  assert.deepEqual(fs.readdirSync(f.root), ['.original'])
  const moved = path.join(f.parent, 'released'); fs.renameSync(f.root, moved); fs.renameSync(moved, f.root)
})

test('a completion and actual child exit still fail when the independent Native exit proof is unknown', async t => {
  const f = fixture(t), spawn = cp.spawn, exited = native.isProcessExited, diagnostics = []
  let child
  t.mock.method(console, 'error', text => diagnostics.push(JSON.parse(text)))
  const observed = t.mock.method(cp, 'spawn', (...args) => { child = spawn(...args); return child })
  t.mock.method(native, 'isProcessExited', pid => pid === child?.pid ? false : exited(pid))
  syncBuiltinESMExports(); t.after(() => { observed.mock.restore(); syncBuiltinESMExports() })
  await assert.rejects(probeWorkspaceDirectory({ directory: f.directory, authorize: allowed }), { code: 'WORKSPACE_ROOT_PROBE_UNVERIFIED' })
  assert.equal(child.exitCode, 0)
  assert.equal(diagnostics[0].probe_event, 'native-exit')
  assert.equal(diagnostics[0].accepted, true); assert.equal(diagnostics[0].exited, true)
  assert.equal(diagnostics[0].native_exit_state, 'unknown')
  assert.deepEqual(fs.readdirSync(f.root), ['.original'])
})
