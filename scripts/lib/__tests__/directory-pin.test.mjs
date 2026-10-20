import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import native from '../process-identity.cjs'

async function fixture(t) {
  const owned = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-directory-pin-中文 space-')))
  const root = path.join(owned, 'ancestor'), source = path.join(root, 'source'), moved = path.join(owned, 'renamed-ancestor')
  await fs.mkdir(source, { recursive: true }); await fs.writeFile(path.join(source, 'file'), 'original')
  t.after(() => fs.rm(owned, { recursive: true, force: true }))
  return { root, source, moved }
}

test('Windows pins the actual 128-bit root identity and each ancestor against replacement until explicit release', { skip: process.platform !== 'win32' }, async t => {
  const { root, source, moved } = await fixture(t), target = path.join(root, 'target')
  const before = native.inspectDirectoryFileId(source), pin = native.pinDirectory(source)
  try {
    assert.equal(pin.identity, before); assert.match(pin.identity, /^\d+:[a-f0-9]{32}$/)
    await assert.rejects(fs.rename(source, target))
    await assert.rejects(fs.rename(root, moved))
    assert.equal(native.inspectDirectoryFileId(source), before)
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
