import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import management from '../desktop-management.cjs'
import { openSystemUserMaintenanceLog } from '../system-user-diagnostics.mjs'
const options = { skip: process.platform === 'win32' }
function fixture(t) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'crabot-system-diagnostic-')))
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  const data = management.ensurePrivateDataRoot(path.join(parent, 'data')), entry = { uid: process.getuid(), data_dir: data }
  return { parent, data, entry }
}
test('normal existing 0755 logs do not prevent a private maintenance log or alter old permissions', options, t => {
  const { data, entry } = fixture(t), old = path.join(data, 'logs')
  fs.mkdirSync(old, { mode: 0o755 }); fs.chmodSync(old, 0o755); fs.writeFileSync(path.join(old, 'old.log'), 'retained', { mode: 0o644 })
  const fd = openSystemUserMaintenanceLog(entry)
  try { fs.writeSync(fd, 'private diagnostic\n') } finally { fs.closeSync(fd) }
  assert.equal(fs.readFileSync(path.join(data, 'system-control/system-maintenance.log'), 'utf8'), 'private diagnostic\n')
  assert.equal(fs.statSync(path.join(data, 'system-control')).mode & 0o777, 0o700)
  assert.equal(fs.statSync(path.join(data, 'system-control/system-maintenance.log')).mode & 0o777, 0o600)
  assert.equal(fs.statSync(old).mode & 0o777, 0o755); assert.equal(fs.readFileSync(path.join(old, 'old.log'), 'utf8'), 'retained')
  assert.deepEqual(fs.readdirSync(old), ['old.log'])
})
for (const changed of ['wrong-uid', 'missing-data', 'directory-symlink', 'file-symlink', 'hard-link', 'wide-file']) test('unsafe operational logging does not write or recreate employee data: ' + changed, options, t => {
  const { parent, data, entry } = fixture(t), control = path.join(data, 'system-control'), log = path.join(control, 'system-maintenance.log')
  const retained = path.join(parent, 'retained'); fs.writeFileSync(retained, 'untouched', { mode: 0o600 })
  if (changed === 'wrong-uid') entry.uid++
  if (changed === 'missing-data') fs.rmdirSync(data)
  if (changed === 'directory-symlink') { fs.mkdirSync(retained + '-directory'); fs.symlinkSync(retained + '-directory', control, 'dir') }
  if (['file-symlink', 'hard-link', 'wide-file'].includes(changed)) {
    fs.mkdirSync(control, { mode: 0o700 })
    if (changed === 'file-symlink') fs.symlinkSync(retained, log)
    if (changed === 'hard-link') fs.linkSync(retained, log)
    if (changed === 'wide-file') { fs.writeFileSync(log, 'old log'); fs.chmodSync(log, 0o644) }
  }
  assert.throws(() => openSystemUserMaintenanceLog(entry))
  assert.equal(fs.readFileSync(retained, 'utf8'), 'untouched')
  if (changed === 'missing-data') assert.equal(fs.existsSync(data), false)
  if (changed === 'wrong-uid') assert.deepEqual(fs.readdirSync(data), [])
  if (changed === 'wide-file') assert.equal(fs.readFileSync(log, 'utf8'), 'old log')
})
