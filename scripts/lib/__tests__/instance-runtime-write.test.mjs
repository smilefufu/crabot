import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { createInstanceRuntime, recordMmProcess, readInstanceRuntime } from '../instance-runtime.mjs'

async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'crabot-runtime-write-中文 ')))
  const record = createInstanceRuntime({ root, dataDir: root, mmPort: 19876 })
  const file = join(root, 'instance-runtime.json'), before = fs.readFileSync(file)
  const child = spawn(process.execPath, ['-e', 'process.send("ready");setTimeout(()=>{},30000)'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const ended = once(child, 'exit'); await once(child, 'message')
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await ended; fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, record, file, before, child }
}

function interceptWindowsRename(t, apply) {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  const rename = fs.renameSync
  t.mock.method(fs, 'renameSync', (from, to) => apply(from, to, rename))
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); Object.defineProperty(process, 'platform', platform) })
}

for (const code of ['EPERM', 'EACCES', 'EBUSY']) test('Windows registration retains the old readable record across transient ' + code, async t => {
  const f = await fixture(t), pending = new Set(); let attempts = 0
  interceptWindowsRename(t, (from, to, rename) => {
    pending.add(from); assert.equal(to, f.file)
    assert.deepEqual(fs.readFileSync(f.file), f.before)
    assert.equal(readInstanceRuntime(f.root).mm, null)
    if (++attempts <= 2) throw Object.assign(new Error('controlled sharing refusal'), { code })
    rename(from, to)
  })
  const record = recordMmProcess(f.root, f.record.generation, f.child.pid)
  assert.equal(attempts, 3); assert.equal(pending.size, 1)
  assert.equal(record.mm.pid, f.child.pid)
  assert.equal(record.generation, f.record.generation)
  assert.deepEqual(readInstanceRuntime(f.root), record)
  assert.deepEqual(fs.readdirSync(f.root), ['instance-runtime.json', 'mm.pid'])
})

test('a permanent Windows replacement refusal keeps the original record and removes only its pending file', async t => {
  const f = await fixture(t); let attempts = 0
  interceptWindowsRename(t, () => { attempts++; throw Object.assign(new Error('controlled permanent refusal'), { code: 'EPERM' }) })
  const began = Date.now()
  assert.throws(() => recordMmProcess(f.root, f.record.generation, f.child.pid), { code: 'EPERM' })
  assert.ok(attempts > 1); assert.ok(Date.now() - began < 2000)
  assert.deepEqual(fs.readFileSync(f.file), f.before)
  assert.deepEqual(fs.readdirSync(f.root), ['instance-runtime.json', 'mm.pid'])
})

test('a changed generation during Windows sharing refusal is never overwritten', async t => {
  const f = await fixture(t), replacement = Buffer.from(JSON.stringify({ ...f.record, generation: randomUUID() })); let attempts = 0
  interceptWindowsRename(t, () => {
    attempts++; fs.writeFileSync(f.file, replacement)
    throw Object.assign(new Error('controlled sharing refusal'), { code: 'EPERM' })
  })
  assert.throws(() => recordMmProcess(f.root, f.record.generation, f.child.pid), { code: 'CRABOT_INSTANCE_UNVERIFIED' })
  assert.equal(attempts, 1); assert.deepEqual(fs.readFileSync(f.file), replacement)
  assert.deepEqual(fs.readdirSync(f.root), ['instance-runtime.json', 'mm.pid'])
})

test('an unrelated Windows I/O failure is returned immediately without another rename', async t => {
  const f = await fixture(t); let attempts = 0
  interceptWindowsRename(t, () => { attempts++; throw Object.assign(new Error('controlled full disk'), { code: 'ENOSPC' }) })
  assert.throws(() => recordMmProcess(f.root, f.record.generation, f.child.pid), { code: 'ENOSPC' })
  assert.equal(attempts, 1); assert.deepEqual(fs.readFileSync(f.file), f.before)
  assert.deepEqual(fs.readdirSync(f.root), ['instance-runtime.json', 'mm.pid'])
})
