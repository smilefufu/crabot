import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { inspectLegacySystemDataDirectory, privatizeLegacySystemDataDirectory, validLegacySystemDirectoryIdentity } from '../legacy-system-directory.mjs'
const options = { skip: process.platform === 'win32' }
function fixture(t) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'crabot-old-data-directory-'))), data = path.join(parent, 'data')
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  fs.mkdirSync(data, { mode: 0o755 }); fs.chmodSync(data, 0o755)
  return { parent, data }
}
test('only original owned directory is narrowed; readonly observation and all other permissions stay unchanged', options, t => {
  const { parent, data } = fixture(t), child = path.join(data, 'workspace'), retained = path.join(data, 'retained')
  fs.mkdirSync(child, { mode: 0o755 }); fs.writeFileSync(retained, 'old bytes', { mode: 0o644 })
  const parentMode = fs.statSync(parent).mode, childMode = fs.statSync(child).mode, fileMode = fs.statSync(retained).mode
  const observed = inspectLegacySystemDataDirectory(data)
  assert.equal(fs.statSync(data).mode & 0o7777, 0o755)
  assert.equal(privatizeLegacySystemDataDirectory(data, observed.identity), data)
  assert.equal(fs.statSync(data).mode & 0o7777, 0o700)
  assert.equal(fs.statSync(parent).mode, parentMode); assert.equal(fs.statSync(child).mode, childMode); assert.equal(fs.statSync(retained).mode, fileMode)
  assert.equal(fs.readFileSync(retained, 'utf8'), 'old bytes')
})
for (const change of ['replaced', 'symbolic-link', 'world-writable', 'setgid', 'missing', 'wrong-identity']) test('unverified directory is never created, adopted or chmodded: ' + change, options, t => {
  const { parent, data } = fixture(t), expected = inspectLegacySystemDataDirectory(data).identity
  if (change === 'replaced') { fs.renameSync(data, data + '-retained'); fs.mkdirSync(data, { mode: 0o755 }) }
  if (change === 'symbolic-link') { fs.renameSync(data, data + '-retained'); fs.symlinkSync(data + '-retained', data, 'dir') }
  if (change === 'world-writable') fs.chmodSync(data, 0o777)
  if (change === 'setgid') fs.chmodSync(data, 0o2755)
  if (change === 'missing') fs.rmdirSync(data)
  if (change === 'wrong-identity') expected.inode = '0'
  const mode = fs.existsSync(data) ? fs.lstatSync(data).mode : null
  assert.throws(() => privatizeLegacySystemDataDirectory(data, expected))
  assert.equal(fs.existsSync(data) ? fs.lstatSync(data).mode : null, mode)
  assert.equal(fs.readdirSync(parent).some(name => name === 'cli.lock'), false)
})
test('directory identity metadata cannot carry a path or silently coerce numeric values', () => {
  assert.equal(validLegacySystemDirectoryIdentity({ device: '0', inode: '1' }), true)
  for (const value of [null, {}, { device: 0, inode: '1' }, { device: '0', inode: 1 }, { device: '0', inode: '0' },
    { device: '-1', inode: '1' }, { device: '0', inode: '1', path: '/elsewhere' }]) assert.equal(validLegacySystemDirectoryIdentity(value), false)
})
