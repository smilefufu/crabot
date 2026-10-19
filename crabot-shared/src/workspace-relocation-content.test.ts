import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { verifyWorkspaceRelocationContent } from './workspace-relocation-content.js'

async function fixture(t: test.TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-copy-content-中文 space-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const source = path.join(root, 'source'), target = path.join(root, 'target')
  await fs.mkdir(source)
  return { root, source, target }
}

test('content verification includes hidden and dependency bytes, internal relative links and hard-link topology without writing either tree', async t => {
  const { source, target } = await fixture(t)
  await fs.mkdir(path.join(source, '.git')); await fs.mkdir(path.join(source, 'node_modules'))
  await fs.writeFile(path.join(source, '.git/config'), '[core]\n')
  await fs.writeFile(path.join(source, 'node_modules/dependency'), Buffer.from([0, 13, 255, 0]))
  await fs.symlink('node_modules/dependency', path.join(source, 'relative'))
  await fs.link(path.join(source, '.git/config'), path.join(source, 'same-file'))
  await fs.cp(source, target, { recursive: true, verbatimSymlinks: true })
  await fs.unlink(path.join(target, 'same-file'))
  await fs.link(path.join(target, '.git/config'), path.join(target, 'same-file'))
  const before = await fs.lstat(path.join(source, '.git/config'), { bigint: true })
  const result = await verifyWorkspaceRelocationContent(source, target)
  assert.equal(result.files, 3); assert.equal(result.verified_bytes, 18)
  assert.match(result.source_fingerprint, /^[a-f0-9]{64}$/)
  assert.match(result.target_fingerprint, /^[a-f0-9]{64}$/)
  const after = await fs.lstat(path.join(source, '.git/config'), { bigint: true })
  assert.equal(after.mtimeNs, before.mtimeNs); assert.equal(after.ctimeNs, before.ctimeNs)
  assert.deepEqual(await fs.readFile(path.join(target, 'node_modules/dependency')), Buffer.from([0, 13, 255, 0]))
})

for (const change of ['same-size corruption', 'missing file', 'unexpected file']) {
  test('an incomplete copy is rejected: ' + change, async t => {
    const { source, target } = await fixture(t)
    await fs.writeFile(path.join(source, 'important'), 'original')
    await fs.cp(source, target, { recursive: true })
    if (change === 'same-size corruption') await fs.writeFile(path.join(target, 'important'), 'modified')
    if (change === 'missing file') await fs.unlink(path.join(target, 'important'))
    if (change === 'unexpected file') await fs.writeFile(path.join(target, 'unexpected'), 'keep this user content')
    await assert.rejects(verifyWorkspaceRelocationContent(source, target), { code: 'WORKSPACE_COPY_UNVERIFIED' })
    assert.equal(await fs.readFile(path.join(source, 'important'), 'utf8'), 'original')
    if (change === 'unexpected file') assert.equal(await fs.readFile(path.join(target, 'unexpected'), 'utf8'), 'keep this user content')
  })
}

test('equal bytes do not excuse a lost internal hard-link relationship', async t => {
  const { source, target } = await fixture(t)
  await fs.writeFile(path.join(source, 'first'), 'same bytes')
  await fs.link(path.join(source, 'first'), path.join(source, 'second'))
  await fs.cp(source, target, { recursive: true })
  await assert.rejects(verifyWorkspaceRelocationContent(source, target), { code: 'WORKSPACE_COPY_UNVERIFIED' })
})

test('external links, a linked root and overlapping roots cannot become a verified copy', async t => {
  const { root, source, target } = await fixture(t)
  await fs.mkdir(target); await fs.writeFile(path.join(root, 'external'), 'must not be read')
  await fs.symlink('../external', path.join(source, 'escape'))
  await fs.symlink('../external', path.join(target, 'escape'))
  await assert.rejects(verifyWorkspaceRelocationContent(source, target), { code: 'WORKSPACE_COPY_UNVERIFIED' })
  const alias = path.join(root, 'alias'); await fs.symlink(source, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(verifyWorkspaceRelocationContent(source, alias))
  await assert.rejects(verifyWorkspaceRelocationContent(source, source), { code: 'WORKSPACE_COPY_UNVERIFIED' })
  await assert.rejects(verifyWorkspaceRelocationContent(root, source), { code: 'WORKSPACE_COPY_UNVERIFIED' })
})

test('cancellation is explicit and leaves source and an unverified destination intact', async t => {
  const { source, target } = await fixture(t)
  await fs.writeFile(path.join(source, 'kept'), 'keep'); await fs.cp(source, target, { recursive: true })
  const controller = new AbortController(); controller.abort()
  await assert.rejects(verifyWorkspaceRelocationContent(source, target, { signal: controller.signal }), { code: 'WORKSPACE_SCAN_CANCELLED' })
  assert.equal(await fs.readFile(path.join(source, 'kept'), 'utf8'), 'keep')
  assert.equal(await fs.readFile(path.join(target, 'kept'), 'utf8'), 'keep')
})


test('cancelling after a real content chunk closes its file handle before returning', async t => {
  const { source, target } = await fixture(t), file = path.join(source, 'large')
  await fs.writeFile(file, Buffer.alloc(4 * 1024 * 1024, 7))
  await fs.cp(source, target, { recursive: true })
  const controller = new AbortController(), open = fs.open.bind(fs)
  let read = false, closed = false
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args)
    if (args[0] === file) {
      const createReadStream = handle.createReadStream.bind(handle), close = handle.close.bind(handle)
      handle.createReadStream = options => {
        const stream = createReadStream(options)
        stream.once('data', () => { read = true; controller.abort() })
        return stream
      }
      handle.close = async () => { await close(); closed = true }
    }
    return handle
  })
  await assert.rejects(verifyWorkspaceRelocationContent(source, target, { signal: controller.signal }), { code: 'WORKSPACE_SCAN_CANCELLED' })
  assert.equal(read, true); assert.equal(closed, true)
  assert.equal((await fs.stat(file)).size, 4 * 1024 * 1024)
})
