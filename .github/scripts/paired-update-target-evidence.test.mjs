import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createInstanceRuntime, identity } from '../../scripts/lib/instance-runtime.mjs'
import { collectPairedUpdateTargetEvidence, summarizePairedTargetBootstrap, summarizePairedTargetNativeStack, collectPairedTargetNativeStack } from './paired-update-target-evidence.mjs'
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-target-evidence-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const dataDir = path.join(root, 'data'), targetRoot = path.join(root, 'core')
  await fs.mkdir(dataDir); await fs.mkdir(targetRoot); await fs.mkdir(path.join(dataDir, 'logs'))
  return { root, dataDir, targetRoot }
}
test('absent target records are distinguished from a live starting controller without exposing identity', async t => {
  const f = await fixture(t)
  const empty = await collectPairedUpdateTargetEvidence(f)
  assert.equal(empty.runtime.state, 'stopped'); assert.equal(empty.runtime.status, 'absent')
  createInstanceRuntime({ dataDir: f.dataDir, root: f.targetRoot, mmPort: 19000 })
  const starting = await collectPairedUpdateTargetEvidence(f)
  assert.deepEqual(starting.runtime, { status: 'readable', state: 'starting', target_core_matches: true, controller_alive: true, mm_alive: false })
  assert.equal(JSON.stringify(starting).includes(f.root), false)
  assert.equal(starting.maintenance.status, 'absent')
})
test('malformed and oversized records remain unreadable rather than becoming a stopped instance', async t => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.dataDir, 'instance-runtime.json'), 'not json')
  await fs.writeFile(path.join(f.dataDir, 'desktop-maintenance.json'), 'x'.repeat(65537))
  const result = await collectPairedUpdateTargetEvidence(f)
  assert.deepEqual(result.runtime, { status: 'unreadable' }); assert.deepEqual(result.maintenance, { status: 'unreadable' })
})
test('fixed bounded log summaries retain failure signals and discard all raw text and secrets', async t => {
  const f = await fixture(t), secret = 'super-secret-provider-and-user-path'
  const file = path.join(f.dataDir, 'logs/mm.stderr.log')
  await fs.writeFile(file, 'EADDRINUSE' + 'x'.repeat(9000) + '\n' + secret + ' CRABOT_MAINTENANCE_PENDING ERR_MODULE_NOT_FOUND\n')
  const result = await collectPairedUpdateTargetEvidence({ ...f, handoffAt: Date.now() - 10000 })
  assert.deepEqual(result.logs['mm.stderr.log'], { status: 'readable', modified_after_handoff: true, codes: ['CRABOT_MAINTENANCE_PENDING'], module_not_found: true, address_in_use: false, permission_denied: false })
  assert.equal(JSON.stringify(result).includes(secret), false)
})
test('redirected and shared diagnostic files are rejected without reading their contents', async t => {
  const f = await fixture(t), file = path.join(f.root, 'private')
  await fs.writeFile(file, 'CRABOT_SHOULD_NOT_BE_READ')
  await fs.link(file, path.join(f.dataDir, 'logs/mm.stderr.log'))
  await fs.symlink(file, path.join(f.dataDir, 'desktop-maintenance.json'), process.platform === 'win32' ? 'file' : undefined)
  const result = await collectPairedUpdateTargetEvidence(f)
  assert.deepEqual(result.logs['mm.stderr.log'], { status: 'unreadable' })
  assert.deepEqual(result.maintenance, { status: 'unreadable' })
  assert.equal(JSON.stringify(result).includes('SHOULD_NOT_BE_READ'), false)
})

test('a valid maintenance phase is read through the product validator without exporting its private record', async t => {
  const f = await fixture(t)
  const record = { schema_version: 3, id: '11111111-1111-4111-8111-111111111111', data_dir: f.dataDir, install_root: f.targetRoot,
    source_version: '1.0.0', source_inventory_sha256: 'a'.repeat(64), target_version: '1.0.1', data_protection: 'scoped',
    phase: 'verifying', backup: null, target_core: { root: f.targetRoot, inventory_sha256: 'b'.repeat(64) } }
  const file = path.join(f.dataDir, 'desktop-maintenance.json'), text = JSON.stringify(record)
  if (process.platform === 'win32') identity.writePrivateFile(file, text)
  else await fs.writeFile(file, text, { mode: 0o600 })
  const result = await collectPairedUpdateTargetEvidence(f)
  assert.deepEqual(result.maintenance, { status: 'readable', schema_version: 3, phase: 'verifying', target_core_matches: true })
  assert.equal(JSON.stringify(result).includes(record.id), false)
})

test('schema evidence uses the existing static validator without initializing or migrating data', async t => {
  const f = await fixture(t), code = path.join(f.targetRoot, 'crabot-agent'), data = path.join(f.dataDir, 'agent')
  await fs.mkdir(code); await fs.mkdir(data)
  await fs.writeFile(path.join(code, 'schema_version'), 'v2')
  await fs.writeFile(path.join(data, 'SCHEMA_VERSION'), 'v1')
  const secret = 'private user text must never enter diagnostics'
  await fs.writeFile(path.join(data, 'preserved'), secret)
  const result = await collectPairedUpdateTargetEvidence(f)
  assert.deepEqual(result.schema, { status: 'readable', pending: [{ module_id: 'crabot-agent', code_version: 'v2', data_version: 'v1' }] })
  assert.equal(JSON.stringify(result).includes(secret), false)
  assert.equal(JSON.stringify(result).includes(f.root), false)
  assert.equal(await fs.readFile(path.join(data, 'SCHEMA_VERSION'), 'utf8'), 'v1')
  assert.equal(await fs.readFile(path.join(data, 'preserved'), 'utf8'), secret)
  assert.deepEqual((await fs.readdir(data)).sort(), ['SCHEMA_VERSION', 'preserved'])
})

test('bootstrap summary exports only fixed phases/codes, excluding arbitrary fields, paths and user text', () => {
  const secret = 'private-model-token-and-user-text', output = [secret, '/private/' + secret,
    JSON.stringify({ component: 'desktop-bootstrap', phase: 'instance-lock-acquired', secret }),
    JSON.stringify({ component: 'desktop-bootstrap', phase: 'app-ready', app_version: '1.2.4', secret }),
    JSON.stringify({ component: 'desktop-bootstrap', phase: secret }), JSON.stringify({ component: secret, phase: 'failed' }),
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'crabot-client' in /private/" + secret, 'CRABOT_' + secret, 'bad json'].join('\n')
  const result = summarizePairedTargetBootstrap(output, '1.2.4')
  assert.deepEqual(result, { events: [{ phase: 'instance-lock-acquired' }, { phase: 'app-ready', version_matches_current: true }], codes: ['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'], missing_packages: ['crabot-client'] })
  assert.equal(JSON.stringify(result).includes(secret), false)
  assert.equal(JSON.stringify(result).includes('/private/'), false)
})
test('bootstrap phase history and malformed output remain bounded without exporting versions', () => {
  const line = JSON.stringify({ component: 'desktop-bootstrap', phase: 'app-ready', app_version: 'untrusted-private-version' })
  const result = summarizePairedTargetBootstrap(Array(40).fill(line).join('\n'), '1.2.4')
  assert.equal(result.events.length, 32)
  assert.ok(result.events.every(event => event.version_matches_current === false))
  assert.equal(JSON.stringify(result).includes('untrusted-private-version'), false)
  assert.deepEqual(summarizePairedTargetBootstrap('null\n{}\n', '1.2.4'), { events: [], codes: [], missing_packages: [] })
  assert.throws(() => summarizePairedTargetBootstrap('x'.repeat(65537), '1.2.4'))
  assert.throws(() => summarizePairedTargetBootstrap(null, '1.2.4'))
})

test('bounded locator stages distinguish an observed loader stall without exporting paths or arguments', () => {
  const phases = ['loading-installation-verifier', 'installation-verifier-loaded', 'installation-pin-read', 'installation-discovered', 'installation-validated', 'environment-bound', 'profile-configured']
  const output = phases.map(phase => JSON.stringify({ component: 'desktop-bootstrap', phase, path: '/private/must-not-export', token: 'secret' })).join('\n')
  const result = summarizePairedTargetBootstrap(output, '1.2.3')
  assert.deepEqual(result.events, phases.map(phase => ({ phase })))
  assert.equal(JSON.stringify(result).includes('must-not-export'), false)
  assert.equal(JSON.stringify(result).includes('secret'), false)
})

test('native target diagnostics retain only code symbols from the first thread', () => {
  const raw = `Process: Crabot PRIVATE-TEXT
Path: /Users/private/provider-secret
Call graph:
    40 Thread_123 DispatchQueue_1: com.apple.main-thread (serial)
    + 40 start  (in dyld) + 1 [0x111]
    +   40 electron::api::App::RequestSingleInstanceLock(gin::Arguments*, /Users/private)  (in Electron Framework) + 5 [0x222]
    +     40 uv__io_poll  (in Electron Framework) + 9 [0x333]
    +     40 -[SMAppService status] (in ServiceManagement) + 1 [0x334]
    +     40 SecItemCopyMatching(PRIVATE-ARGUMENT) (in Security) + 1 [0x335]
    +     40 PRIVATE_SECRET("credential") (in private-module) + 0 [0x444]
    40 Thread_456
    + 40 node::PrivateOtherThread  (in Electron Framework) + 1 [0x555]
Total number in stack (recursive counted multiple, when >=5):
`
  assert.deepEqual(summarizePairedTargetNativeStack(raw), { main_thread_found: true,
    frames: ['start', 'electron::api::App::RequestSingleInstanceLock', 'uv__io_poll', '-[SMAppService status]', 'SecItemCopyMatching'] })
  assert.equal(JSON.stringify(summarizePairedTargetNativeStack(raw)).includes('PRIVATE'), false)
  assert.equal(JSON.stringify(summarizePairedTargetNativeStack(raw)).includes('/Users'), false)
})

test('native target diagnostics have fixed module, frame-count and input limits', () => {
  const lines = Array.from({ length: 80 }, (_, i) => ` + 1 base::Frame${i}() (in Electron Framework) + 1 [0x1]`)
  const raw = 'Call graph:\n 1 Thread_1\n' + lines.join('\n')
  assert.equal(summarizePairedTargetNativeStack(raw).frames.length, 40)
  assert.deepEqual(summarizePairedTargetNativeStack('Path: secret\n'), { main_thread_found: false, frames: [] })
  assert.throws(() => summarizePairedTargetNativeStack('x'.repeat(2 * 1024 * 1024 + 1)))
})

test('unsealed or missing target identity cannot invoke native observation', async t => {
  const f = await fixture(t)
  assert.deepEqual(await collectPairedTargetNativeStack({ targetRoot: f.targetRoot }), { status: 'unavailable' })
  assert.deepEqual(await collectPairedTargetNativeStack({ targetRoot: f.targetRoot, targetIdentity: identity.inspectProcess(process.pid) }), { status: 'unavailable' })
  assert.deepEqual(await fs.readdir(f.targetRoot), [])
  assert.deepEqual(await fs.readdir(f.dataDir), ['logs'])
})

test('the original GUI private profile log exposes only current bounded bootstrap metadata', async t => {
  const f = await fixture(t), profile = path.join(f.dataDir, 'desktop-profile'), file = path.join(profile, 'bootstrap.log')
  await fs.mkdir(profile)
  await fs.writeFile(file, JSON.stringify({ component: 'desktop-bootstrap', phase: 'profile-configured', path: '/private/user-content' }) + '\n'
    + JSON.stringify({ component: 'desktop-bootstrap', phase: 'failed', code: 'CRABOT_CORE_INTEGRITY', message: 'private-message' }) + '\n')
  const result = await collectPairedUpdateTargetEvidence(f)
  assert.deepEqual(result.bootstrap.events, [{ phase: 'profile-configured' }, { phase: 'failed' }])
  assert.deepEqual(result.bootstrap.codes, ['CRABOT_CORE_INTEGRITY'])
  assert.equal(JSON.stringify(result).includes('private-message'), false)
  assert.equal(JSON.stringify(result).includes('user-content'), false)
  const stale = await collectPairedUpdateTargetEvidence({ ...f, handoffAt: Date.now() + 10000 })
  assert.equal(stale.bootstrap.modified_after_handoff, false); assert.deepEqual(stale.bootstrap.events, [])
  await fs.writeFile(file, 'x'.repeat(16385))
  assert.deepEqual((await collectPairedUpdateTargetEvidence(f)).bootstrap, { status: 'unreadable' })
  await fs.unlink(file); await fs.writeFile(path.join(f.root, 'keep'), 'private user content'); await fs.link(path.join(f.root, 'keep'), file)
  assert.deepEqual((await collectPairedUpdateTargetEvidence(f)).bootstrap, { status: 'unreadable' })
})
