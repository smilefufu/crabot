import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { readCiCrashFrames } from '../read-ci-crash-frame.mjs'

for (const mode of ['large sparse dump', 'invalid stream', 'too many modules']) test('fixed crash metadata: ' + mode, async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'crabot-ci-minidump-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const bytes = Buffer.alloc(1024), file = path.join(root, 'crash.dmp'), base = 0x140000000n
  bytes.writeUInt32LE(0x504d444d, 0); bytes.writeUInt32LE(2, 8); bytes.writeUInt32LE(32, 12)
  bytes.writeUInt32LE(4, 32); bytes.writeUInt32LE(112, 36); bytes.writeUInt32LE(64, 40)
  bytes.writeUInt32LE(6, 44); bytes.writeUInt32LE(168, 48); bytes.writeUInt32LE(mode === 'invalid stream' ? 0xffffffff : 192, 52)
  bytes.writeUInt32LE(mode === 'too many modules' ? 4097 : 1, 64)
  bytes.writeBigUInt64LE(base, 68); bytes.writeUInt32LE(0x10000, 76); bytes.writeUInt32LE(384, 88)
  bytes.writeUInt32LE(0x80000003, 200); bytes.writeBigUInt64LE(base + 0x1234n, 216)
  const name = Buffer.from('C:\\Users\\private-user\\token-do-not-export\\CrabotInstaller.exe', 'utf16le')
  bytes.writeUInt32LE(name.length, 384); name.copy(bytes, 388)
  await fs.writeFile(file, bytes)
  const handle = await fs.open(file, 'r+')
  try { await handle.truncate(17 * 1024 * 1024) } finally { await handle.close() }
  t.mock.method(fs, 'readFile', () => { throw new Error('Must not read the entire dump') })
  const result = await readCiCrashFrames(root)
  if (mode === 'large sparse dump') assert.deepEqual(result, [{ exception_code: '0x80000003', module: 'CrabotInstaller.exe', module_offset: '0x1234', module_names: ['CrabotInstaller.exe'] }])
  else assert.deepEqual(result, [{ unavailable: 'fixed-exception-unreadable' }])
  assert.ok(!JSON.stringify(result).includes('private-user')); assert.ok(!JSON.stringify(result).includes('token-do-not-export'))
})
