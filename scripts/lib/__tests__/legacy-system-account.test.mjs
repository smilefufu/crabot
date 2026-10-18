import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { discoverLegacySystemAccount } from '../legacy-system-account.mjs'
const options = { skip: process.platform === 'win32' }
function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'crabot-old-account-')))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const directory = path.join(home, '.crabot'), root = path.join(home, 'shared-code')
  fs.mkdirSync(directory); fs.mkdirSync(root)
  const file = path.join(directory, 'instance.json'), account = { user: 'alice', uid: process.getuid(), gid: process.getgid(), home }
  const release = { version: 'v2026.10.15.1', installRoot: root, code_fingerprint: 'a'.repeat(64) }
  const context = { account, release, port_offset_hint: 100 }
  const actual = { uid: account.uid, gid: account.gid, username: account.user, homedir: home }
  const write = extra => fs.writeFileSync(file, JSON.stringify({ mode: 'system', port_offset: 100, crabot_home: root,
    data_dir: '/must-not-adopt', api_key: 'must-not-return', pid: 1, command: 'must-not-execute', ...extra }))
  write()
  const discover = extra => discoverLegacySystemAccount(context, { actual, discoverRelease: async () => release, ...extra })
  return { home, directory, file, account, context, actual, release, write, discover }
}
test('account discovery returns operational fingerprints without adopting data paths or exposing private fields', options, async t => {
  const f = fixture(t), before = fs.readFileSync(f.file), result = await f.discover()
  assert.equal(result.data_binding, 'unverified'); assert.equal(result.port_offset, 100)
  assert.match(result.manifest_fingerprint, /^[a-f0-9]{64}$/)
  assert.doesNotMatch(JSON.stringify(result), /must-not|api_key|command|data_dir/)
  assert.deepEqual(fs.readFileSync(f.file), before); assert.deepEqual(fs.readdirSync(f.directory), ['instance.json'])
})
test('every actual OS account mismatch refuses before shared-code or employee file I/O', options, async t => {
  const f = fixture(t)
  for (const patch of [{ uid: f.account.uid + 1 }, { gid: f.account.gid + 1 }, { username: 'other' }, { homedir: '/other' }]) {
    await assert.rejects(f.discover({ actual: { ...f.actual, ...patch }, discoverRelease: () => assert.fail('identity must be checked first') }))
  }
  fs.rmSync(f.directory, { recursive: true })
  await assert.rejects(f.discover({ actual: { ...f.actual, uid: f.account.uid + 1 }, discoverRelease: () => assert.fail() }))
  assert.equal(fs.existsSync(f.directory), false)
})
test('changed shared code, inconsistent modes, offsets and installation sources stay unconverted', options, async t => {
  const f = fixture(t)
  await assert.rejects(f.discover({ discoverRelease: async () => ({ ...f.release, code_fingerprint: 'b'.repeat(64) }) }))
  for (const patch of [{ mode: 'user' }, { port_offset: 200 }, { port_offset: '100' }, { crabot_home: f.home }, { crabot_home: './shared-code' }]) {
    f.write(patch); await assert.rejects(f.discover(), { code: 'CRABOT_LEGACY_SYSTEM_ACCOUNT' })
  }
})
test('missing, oversized, writable, malformed and redirected employee manifests refuse without initialization', options, async t => {
  const f = fixture(t)
  fs.unlinkSync(f.file); await assert.rejects(f.discover()); assert.equal(fs.existsSync(f.file), false)
  f.write(); fs.chmodSync(f.file, 0o666); await assert.rejects(f.discover()); fs.chmodSync(f.file, 0o644)
  fs.writeFileSync(f.file, '{"api_key":"private-invalid-json"'); await assert.rejects(f.discover(), error => !error.message.includes('private-invalid-json'))
  fs.writeFileSync(f.file, ' '.repeat(65537)); await assert.rejects(f.discover())
  f.write(); const original = f.file + '.old'; fs.renameSync(f.file, original); fs.symlinkSync(original, f.file)
  await assert.rejects(f.discover()); fs.unlinkSync(f.file); fs.linkSync(original, f.file); await assert.rejects(f.discover())
})


test('bounded employee manifest reads handle short chunks and reject concurrent growth', options, async t => {
  const f = fixture(t), read = fs.readSync, stat = fs.fstatSync
  const short = t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => read(fd, buffer, offset, Math.min(length, 5), position))
  assert.equal((await f.discover()).data_binding, 'unverified'); short.mock.restore()
  let expanded = false
  t.mock.method(fs, 'fstatSync', fd => {
    const value = stat(fd)
    if (!expanded) { expanded = true; fs.appendFileSync(f.file, ' '.repeat(65537)) }
    return value
  })
  await assert.rejects(f.discover(), { code: 'CRABOT_LEGACY_SYSTEM_ACCOUNT' })
})
