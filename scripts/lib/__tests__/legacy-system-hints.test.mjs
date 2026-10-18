import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { readLegacySystemHints, resolveLegacySystemCandidates } from '../legacy-system-hints.mjs'
const options = { skip: process.platform === 'win32' }
function fixture(t) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'crabot-legacy-hints-'))), file = path.join(parent, 'ports.json')
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  return { parent, file, write: rows => { fs.writeFileSync(file, JSON.stringify(rows), { mode: 0o664 }); fs.chmodSync(file, 0o664) },
    read: extra => readLegacySystemHints({ file, ownerUid: process.getuid(), ...extra }) }
}
test('legacy group-writable hints never adopt employee paths, PID or commands as authority', options, t => {
  const f = fixture(t), rows = [{ user: 'alice', offset: 100, pid_at_init: 1, data_dir: '/root/secret', command: 'must not execute' }]
  f.write(rows); const before = fs.readFileSync(f.file), snapshot = f.read()
  assert.deepEqual(snapshot.hints, [{ user: 'alice', port_offset: 100 }]); assert.match(snapshot.fingerprint, /^[a-f0-9]{64}$/)
  assert.deepEqual(fs.readFileSync(f.file), before)
  const resolved = resolveLegacySystemCandidates(snapshot, { lookup: user => ({ user, uid: 1001, gid: 1002, home: '/home/alice' }) })
  assert.deepEqual(resolved.candidates, [{ account: { user: 'alice', uid: 1001, gid: 1002, home: '/home/alice' }, port_offset_hint: 100 }])
  assert.equal(resolved.candidates[0].data_dir, undefined)
})
test('malformed/redirected/missing hints fail and never silently become an empty installation', options, t => {
  const f = fixture(t)
  assert.throws(() => f.read())
  for (const rows of [null, {}, [{ user: 'root', offset: 0 }], [{ user: '--help', offset: 100 }], [{ user: 'alice', offset: '100' }],
    [{ user: 'alice', offset: 100 }, { user: 'bob', offset: 100 }], [{ user: 'alice', offset: 100 }, { user: 'alice', offset: 200 }]]) {
    f.write(rows); assert.throws(() => f.read(), { code: 'CRABOT_LEGACY_SYSTEM_HINTS' })
  }
  fs.writeFileSync(f.file, '{"api_key":"must-not-leak"')
  assert.throws(() => f.read(), error => !error.message.includes('must-not-leak'))
  f.write([]); const linked = path.join(f.parent, 'original'); fs.renameSync(f.file, linked); fs.symlinkSync(linked, f.file)
  assert.throws(() => f.read()); fs.unlinkSync(f.file); fs.linkSync(linked, f.file); assert.throws(() => f.read())
})
test('root UID, alias collision and vanished accounts remain discovery failures without employee I/O', () => {
  const hints = { hints: [{ user: 'alice', port_offset: 100 }, { user: 'bob', port_offset: 200 }, { user: 'missing', port_offset: 300 }, { user: 'carol', port_offset: 400 }], fingerprint: 'a'.repeat(64) }
  const resolved = resolveLegacySystemCandidates(hints, { lookup: user => {
    if (user === 'missing') throw new Error('account deleted')
    return { user, uid: user === 'carol' ? 1002 : 1001, gid: 1001, home: '/home/' + user }
  } })
  assert.deepEqual(resolved.candidates.map(row => row.account.user), ['carol']); assert.deepEqual(resolved.failures.map(row => row.user).sort(), ['alice', 'bob', 'missing'])
  const root = resolveLegacySystemCandidates(hints, { lookup: user => ({ user, uid: 0, gid: 0, home: '/root' }) })
  assert.equal(root.candidates.length, 0); assert.equal(root.failures.length, 4)
})
test('empty old hints are observable but do not publish new registration or initialize any account', options, t => {
  const f = fixture(t); f.write([])
  assert.deepEqual(resolveLegacySystemCandidates(f.read(), { lookup: () => assert.fail() }).candidates, [])
  assert.deepEqual(fs.readdirSync(f.parent), ['ports.json'])
})


test('bounded legacy hints handle short reads and reject growth beyond the precheck', options, t => {
  const f = fixture(t); f.write([{ user: 'alice', offset: 100 }])
  const read = fs.readSync, stat = fs.fstatSync
  const short = t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => read(fd, buffer, offset, Math.min(length, 7), position))
  assert.deepEqual(f.read().hints, [{ user: 'alice', port_offset: 100 }]); short.mock.restore()
  let expanded = false
  t.mock.method(fs, 'fstatSync', fd => {
    const value = stat(fd)
    if (!expanded) { expanded = true; fs.appendFileSync(f.file, ' '.repeat(2 * 1024 * 1024)) }
    return value
  })
  assert.throws(() => f.read(), { code: 'CRABOT_LEGACY_SYSTEM_HINTS' })
})
