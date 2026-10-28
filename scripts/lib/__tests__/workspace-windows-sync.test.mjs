import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import syncFs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import vm from 'node:vm'
import { execFileSync } from 'node:child_process'
import native from '../process-identity.cjs'

test('Windows sync bridge preserves the actual opaque pin without filesystem path conversion', () => {
  const pin = { identity: 'actual owned pin' }, calls = [], module = { exports: {} }
  const backend = {}
  Object.defineProperty(backend, 'syncPinnedWorkspaceTree', { value(value) { calls.push(value); return { files: 2, directories: 1, streams: 1 } } })
  vm.runInNewContext(syncFs.readFileSync(new URL('../process-identity.cjs', import.meta.url), 'utf8'), {
    module, process: { platform: 'win32' }, require: name => name === 'node:path' ? path.win32 : name === 'node:fs' ? syncFs : backend,
  })
  assert.deepEqual(module.exports.syncPinnedWorkspaceTree(pin), { files: 2, directories: 1, streams: 1 })
  assert.deepEqual(calls, [pin])
})

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-win-sync-中文-')))
  t.after(async () => {
    for (const file of ['stage/nested/readonly.txt', 'outside/sentinel']) await fs.chmod(path.join(root, file), 0o666).catch(() => {})
    await fs.rm(root, { recursive: true, force: true })
  })
  const directory = path.join(root, 'stage'), nested = path.join(directory, 'nested')
  await fs.mkdir(nested, { recursive: true })
  await fs.writeFile(path.join(directory, '.hidden.txt'), 'ordinary retained bytes')
  await fs.writeFile(path.join(nested, 'readonly.txt'), 'readonly retained bytes')
  return { root, directory, nested }
}

test('Windows syncs the actual pinned tree and ADS while preserving readonly metadata and bytes', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), readonly = path.join(f.nested, 'readonly.txt'), file = path.join(f.directory, '.hidden.txt')
  execFileSync(path.join(process.env.SystemRoot, 'System32/attrib.exe'), ['+H', file], { stdio: 'pipe' })
  await fs.writeFile(file + ':retained', 'retained stream')
  await fs.utimes(readonly, 1700000000, 1700000000); await fs.chmod(readonly, 0o444)
  const { inspectWorkspaceFileMetadata } = await import('../workspace-file-metadata.mjs')
  const paths = [f.directory, f.nested, readonly, file], before = await Promise.all(paths.map(item => inspectWorkspaceFileMetadata(item)))
  const pin = native.pinDirectory(f.directory)
  try {
    assert.deepEqual(native.syncPinnedWorkspaceTree(pin), { files: 2, directories: 2, streams: 1 })
    assert.deepEqual(await Promise.all(paths.map(item => inspectWorkspaceFileMetadata(item))), before)
    assert.equal(await fs.readFile(readonly, 'utf8'), 'readonly retained bytes')
    assert.equal(await fs.readFile(file + ':retained', 'utf8'), 'retained stream')
    assert.equal(native.inspectDirectoryFileId(f.directory), pin.identity)
  } finally { native.releaseDirectoryPin(pin) }
})

test('Windows sync refuses forged/closed pins and never follows a junction to external files', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), outside = path.join(f.root, 'outside'), sentinel = path.join(outside, 'sentinel')
  await fs.mkdir(outside); await fs.writeFile(sentinel, 'outside retained'); await fs.chmod(sentinel, 0o444)
  const before = await fs.stat(sentinel, { bigint: true })
  await fs.symlink(outside, path.join(f.directory, 'junction'), 'junction')
  for (const value of [null, {}, { identity: 'forged' }, 3]) assert.throws(() => native.syncPinnedWorkspaceTree(value), { code: 'WORKSPACE_SYNC_UNVERIFIED' })
  const pin = native.pinDirectory(f.directory)
  try { assert.throws(() => native.syncPinnedWorkspaceTree(pin), { code: 'WORKSPACE_SYNC_UNVERIFIED' }) }
  finally { native.releaseDirectoryPin(pin) }
  assert.throws(() => native.syncPinnedWorkspaceTree(pin), { code: 'WORKSPACE_SYNC_UNVERIFIED' })
  const after = await fs.stat(sentinel, { bigint: true })
  assert.equal(after.ino, before.ino); assert.equal(after.mode, before.mode); assert.equal(after.mtimeNs, before.mtimeNs)
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'outside retained')
  const moved = path.join(f.root, 'moved'); await fs.rename(f.directory, moved); await fs.rename(moved, f.directory)
})

test('Windows sync supports deep Unicode names under the original directory pin', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), deep = path.join(f.directory, ...Array.from({ length: 20 }, (_, index) => 'directory-中文-' + index))
  assert.ok(deep.length > 300); await fs.mkdir(path.toNamespacedPath(deep), { recursive: true })
  await fs.writeFile(path.toNamespacedPath(path.join(deep, 'retained.txt')), 'deep retained')
  const pin = native.pinDirectory(f.directory)
  try { assert.deepEqual(native.syncPinnedWorkspaceTree(pin), { files: 3, directories: 22, streams: 0 }) }
  finally { native.releaseDirectoryPin(pin) }
  assert.equal(await fs.readFile(path.toNamespacedPath(path.join(deep, 'retained.txt')), 'utf8'), 'deep retained')
})
