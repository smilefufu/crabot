import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import native from '../../scripts/lib/process-identity.cjs'
import management from '../../scripts/lib/desktop-management.cjs'
import { openBootstrapLog } from '../dist/bootstrap-log.js'
async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'crabot-bootstrap-log-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const profile = management.ensurePrivateDataRoot(path.join(root, 'profile'))
  return { root, profile, file: path.join(profile, 'bootstrap.log') }
}
const event = (phase = 'profile-configured') => ({ phase, at: new Date().toISOString() })
test('bootstrap logging retains bounded fixed metadata and never extra fields', async t => {
  const f = await fixture(t), write = openBootstrapLog(f.profile, native)
  assert.equal(typeof write, 'function')
  write({ ...event(), token: 'private-token', path: '/private/path', message: 'private-message' })
  write({ ...event('failed'), code: 'CRABOT_CORE_INTEGRITY' })
  for (let i = 0; i < 50; i++) write(event('installation-bound'))
  const text = fs.readFileSync(f.file, 'utf8'), records = text.trimEnd().split('\n').map(JSON.parse)
  assert.equal(records.length, 32)
  assert.equal(records[1].code, 'CRABOT_CORE_INTEGRITY')
  assert.ok(records.every(value => value.component === 'desktop-bootstrap'))
  for (const value of ['private-token', '/private/path', 'private-message']) assert.equal(text.includes(value), false)
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.file).mode & 0o777, 0o600)
  else assert.equal(native.isPrivateFile(f.file), true)
})
test('a new boot replaces only its own private bounded log and rejects malformed metadata', async t => {
  const f = await fixture(t)
  openBootstrapLog(f.profile, native)(event('profile-configured'))
  const write = openBootstrapLog(f.profile, native)
  write({ ...event(), phase: '/private/phase' }); write({ ...event(), code: 'a secret code' }); write({ ...event(), at: 'private-time' })
  assert.equal(fs.readFileSync(f.file, 'utf8'), '')
  write({ ...event('app-ready'), app_version: '0.1.1-desktop-fixture.1' })
  assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).app_version, '0.1.1-desktop-fixture.1')
})
for (const kind of ['hardlink', 'symlink', 'directory', 'oversized']) test('bootstrap logging preserves unexpected files: ' + kind, async t => {
  const f = await fixture(t), outside = path.join(f.root, 'keep')
  fs.writeFileSync(outside, 'preserved')
  if (kind === 'hardlink') fs.linkSync(outside, f.file)
  if (kind === 'symlink') fs.symlinkSync(outside, f.file, 'file')
  if (kind === 'directory') fs.mkdirSync(f.file)
  if (kind === 'oversized') fs.writeFileSync(f.file, 'x'.repeat(65537), { mode: 0o600 })
  const before = kind === 'oversized' ? fs.readFileSync(f.file) : undefined
  assert.equal(openBootstrapLog(f.profile, native), undefined)
  assert.equal(fs.readFileSync(outside, 'utf8'), 'preserved')
  if (before) assert.deepEqual(fs.readFileSync(f.file), before)
})
test('a late replacement and an I/O failure never escape logging or write another file', async t => {
  const f = await fixture(t), write = openBootstrapLog(f.profile, native), outside = path.join(f.root, 'keep')
  fs.writeFileSync(outside, 'preserved'); fs.renameSync(f.file, f.file + '.old'); fs.linkSync(outside, f.file)
  assert.doesNotThrow(() => write(event()))
  assert.equal(fs.readFileSync(outside, 'utf8'), 'preserved')
  fs.unlinkSync(f.file); fs.renameSync(f.file + '.old', f.file)
  const again = openBootstrapLog(f.profile, native), original = fs.writeSync
  fs.writeSync = () => { throw Object.assign(new Error('full'), { code: 'ENOSPC' }) }
  try { assert.doesNotThrow(() => again(event())) } finally { fs.writeSync = original }
})
test('profile replacement or lost ownership leaves both directories untouched', async t => {
  const f = await fixture(t)
  let owned = true
  const write = openBootstrapLog(f.profile, { ...native, isOwnedDirectory: file => owned && native.isOwnedDirectory(file) })
  owned = false; write(event())
  assert.equal(fs.readFileSync(f.file, 'utf8'), '')
  owned = true; fs.renameSync(f.profile, f.profile + '.old'); management.ensurePrivateDataRoot(f.profile)
  write(event())
  assert.deepEqual(fs.readdirSync(f.profile), [])
  assert.equal(fs.readFileSync(path.join(f.profile + '.old', 'bootstrap.log'), 'utf8'), '')
})
test('close errors cannot turn diagnostics into a startup failure', async t => {
  const f = await fixture(t), write = openBootstrapLog(f.profile, native), original = fs.closeSync
  fs.closeSync = fd => { original(fd); throw Object.assign(new Error('close failed'), { code: 'EIO' }) }
  try { assert.doesNotThrow(() => write(event())) } finally { fs.closeSync = original }
})

test('bootstrap logging preserves a nonprivate file and enforces its byte budget after late appends', async t => {
  const f = await fixture(t)
  fs.writeFileSync(f.file, 'preserved', { mode: 0o644 })
  if (process.platform !== 'win32') fs.chmodSync(f.file, 0o644)
  assert.equal(openBootstrapLog(f.profile, native), undefined)
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'preserved')
  fs.unlinkSync(f.file)
  const write = openBootstrapLog(f.profile, native)
  fs.appendFileSync(f.file, 'x'.repeat(16370))
  write(event())
  assert.equal(fs.statSync(f.file).size, 16370)
})
