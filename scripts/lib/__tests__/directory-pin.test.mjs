import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import native from '../process-identity.cjs'
import { execFileSync } from 'node:child_process'

async function fixture(t) {
  const owned = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-directory-pin-中文 space-')))
  const root = path.join(owned, 'ancestor'), source = path.join(root, 'source'), moved = path.join(owned, 'renamed-ancestor')
  await fs.mkdir(source, { recursive: true }); await fs.writeFile(path.join(source, 'file'), 'original')
  t.after(() => fs.rm(owned, { recursive: true, force: true }))
  return { root, source, moved }
}

test('Windows pins the actual 128-bit root identity and each ancestor against replacement until explicit release', { skip: process.platform !== 'win32' }, async t => {
  const { root, source, moved } = await fixture(t), target = path.join(root, 'target')
  const sibling = path.join(root, 'sibling'), renamedSibling = path.join(root, 'renamed-sibling'); await fs.mkdir(sibling)
  const before = native.inspectDirectoryFileId(source), pin = native.pinDirectory(source)
  try {
    assert.equal(pin.identity, before); assert.match(pin.identity, /^\d+:[a-f0-9]{32}$/)
    await assert.rejects(fs.rename(source, target))
    await assert.rejects(fs.rename(root, moved))
    assert.equal(native.inspectDirectoryFileId(source), before)
    await fs.rename(sibling, renamedSibling); await fs.rename(renamedSibling, sibling)
    // A directory pin is not an execution stop or a file write fence.
    await fs.writeFile(path.join(source, 'new-file'), 'still writable')
    assert.equal(await fs.readFile(path.join(source, 'new-file'), 'utf8'), 'still writable')
  } finally { native.releaseDirectoryPin(pin) }
  native.releaseDirectoryPin(pin)
  await fs.rename(source, target); await fs.rename(target, source)
  await fs.rename(root, moved); await fs.rename(moved, root)
})

test('Windows refuses a reparse point and releases all earlier ancestor handles on failure', { skip: process.platform !== 'win32' }, async t => {
  const { root, source, moved } = await fixture(t), link = path.join(root, 'junction')
  await fs.symlink(source, link, 'junction')
  assert.throws(() => native.pinDirectory(link), { code: 'CRABOT_DIRECTORY_PIN' })
  await fs.rename(root, moved); await fs.rename(moved, root)
  assert.equal(await fs.readFile(path.join(source, 'file'), 'utf8'), 'original')
})

test('Windows pin validation never adopts relative paths, files or another Native handle type', { skip: process.platform !== 'win32' }, async t => {
  const { source } = await fixture(t)
  for (const args of [[], ['relative'], [source + '\0'], [source, 'extra'], [path.join(source, 'file')]]) {
    assert.throws(() => native.pinDirectory(...args), { code: 'CRABOT_DIRECTORY_PIN' })
  }
  for (const value of [null, {}, { identity: 'forged' }, 3, 'pin']) assert.throws(() => native.releaseDirectoryPin(value), { code: 'CRABOT_DIRECTORY_PIN' })
})

test('Windows copies pinned root ACL, attributes and timestamps without changing the source or needing a full tree mirror', { skip: process.platform !== 'win32' }, async t => {
  const { root, source } = await fixture(t), parent = path.join(root, 'private-parent'), target = path.join(parent, 'target')
  native.createPrivateDirectory(parent); await fs.mkdir(target)
  await fs.utimes(source, 1700000000, 1700000000)
  const { inspectWorkspaceFileMetadata } = await import('../workspace-file-metadata.mjs')
  const before = await inspectWorkspaceFileMetadata(source), sourcePin = native.pinDirectory(source), targetPin = native.pinDirectory(target)
  try {
    native.copyPinnedDirectoryMetadata(sourcePin, targetPin)
    const copied = await inspectWorkspaceFileMetadata(target)
    if (copied.fingerprint !== before.fingerprint) {
      const details = async directory => ({ mtime_ns: (await fs.lstat(directory, { bigint: true })).mtimeNs.toString(),
        // This controlled fixture has no user attributes or content in its directory metadata.
        metadata: native.inspectFileMetadata(directory).metadata.toString('utf8') })
      t.diagnostic(JSON.stringify({ source: await details(source), target: await details(target) }))
    }
    assert.deepEqual(copied, before)
    assert.deepEqual(await inspectWorkspaceFileMetadata(source), before)
    assert.throws(() => native.copyPinnedDirectoryMetadata(sourcePin, sourcePin), { code: 'CRABOT_DIRECTORY_METADATA' })
  } finally { native.releaseDirectoryPin(targetPin); native.releaseDirectoryPin(sourcePin) }
})

test('Windows root metadata rejects closed or forged pins before modifying a target', { skip: process.platform !== 'win32' }, async t => {
  const { source } = await fixture(t), pin = native.pinDirectory(source)
  native.releaseDirectoryPin(pin)
  for (const values of [[pin, pin], [null, pin], [{ identity: 'forged' }, pin], [pin, {}, 'extra']]) {
    assert.throws(() => native.copyPinnedDirectoryMetadata(...values), { code: 'CRABOT_DIRECTORY_METADATA' })
  }
})


test('Windows preserves a protected root access ACL and explicit integrity label with unchanged source evidence', { skip: process.platform !== 'win32' }, async t => {
  const { root, source } = await fixture(t), parent = path.join(root, 'private-parent'), target = path.join(parent, 'target')
  native.createPrivateDirectory(parent); await fs.mkdir(target)
  const icacls = path.join(process.env.SystemRoot, 'System32/icacls.exe')
  execFileSync(icacls, [source, '/inheritance:d'])
  execFileSync(icacls, [source, '/setintegritylevel', 'L'])
  const { inspectWorkspaceFileMetadata } = await import('../workspace-file-metadata.mjs')
  const before = await inspectWorkspaceFileMetadata(source), a = native.pinDirectory(source), b = native.pinDirectory(target)
  try {
    native.copyPinnedDirectoryMetadata(a, b)
    assert.deepEqual(await inspectWorkspaceFileMetadata(target), before)
    assert.deepEqual(await inspectWorkspaceFileMetadata(source), before)
  } finally { native.releaseDirectoryPin(b); native.releaseDirectoryPin(a) }
})

for (const style of ['legacy', 'modern', 'protected']) test('Windows retains ' + style + ' ACL model when a private staging root has a different parent', { skip: process.platform !== 'win32' }, async t => {
  const { root, source } = await fixture(t), parent = path.join(root, 'private-parent'), target = path.join(parent, 'target')
  native.createPrivateDirectory(parent); native.createPrivateDirectory(target)
  const icacls = path.join(process.env.SystemRoot, 'System32/icacls.exe')
  if (style !== 'legacy') execFileSync(icacls, [source, '/inheritance:' + (style === 'modern' ? 'e' : 'd')])
  await fs.utimes(source, 1700000000, 1700000000)
  const { inspectWorkspaceFileMetadata } = await import('../workspace-file-metadata.mjs')
  const before = await inspectWorkspaceFileMetadata(source), a = native.pinDirectory(source), b = native.pinDirectory(target)
  try {
    native.copyPinnedDirectoryMetadata(a, b)
    const after = await inspectWorkspaceFileMetadata(target)
    if (after.fingerprint !== before.fingerprint) t.diagnostic(JSON.stringify({ style,
      source: native.inspectFileMetadata(source).metadata.toString('utf8'), target: native.inspectFileMetadata(target).metadata.toString('utf8') }))
    assert.deepEqual(after, before)
    assert.deepEqual(await inspectWorkspaceFileMetadata(source), before)
  } finally { native.releaseDirectoryPin(b); native.releaseDirectoryPin(a) }
})

test('Windows never silently removes a preexisting target access label', { skip: process.platform !== 'win32' }, async t => {
  const { root, source } = await fixture(t), target = path.join(root, 'target'); native.createPrivateDirectory(target)
  execFileSync(path.join(process.env.SystemRoot, 'System32/icacls.exe'), [target, '/setintegritylevel', 'L'])
  const { inspectWorkspaceFileMetadata } = await import('../workspace-file-metadata.mjs')
  const before = await inspectWorkspaceFileMetadata(target), a = native.pinDirectory(source), b = native.pinDirectory(target)
  try {
    assert.throws(() => native.copyPinnedDirectoryMetadata(a, b), { code: 'CRABOT_DIRECTORY_METADATA' })
    assert.deepEqual(await inspectWorkspaceFileMetadata(target), before)
  } finally { native.releaseDirectoryPin(b); native.releaseDirectoryPin(a) }
})
