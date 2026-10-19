import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { scanWorkspaceUsage, scanWorkspaceSetUsage } from './workspace-usage.js'

async function fixture(t: test.TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'workspace-usage-中文 space-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

test('directory usage includes hidden files and dependencies, deduplicates hard links and does not follow an outside link', async t => {
  const parent = await fixture(t), root = path.join(parent, 'project'), outside = path.join(parent, 'outside')
  await fs.mkdir(root); await fs.mkdir(outside)
  await fs.mkdir(path.join(root, 'node_modules'))
  await fs.writeFile(path.join(root, '.hidden'), Buffer.alloc(11))
  await fs.writeFile(path.join(root, 'node_modules', 'dependency'), Buffer.alloc(23))
  await fs.link(path.join(root, '.hidden'), path.join(root, 'same-file'))
  await fs.writeFile(path.join(outside, 'must-not-count'), Buffer.alloc(999))
  await fs.symlink(outside, path.join(root, 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
  const usage = await scanWorkspaceUsage(root)
  assert.equal(usage.status, 'complete')
  assert.equal(usage.logical_bytes, 34)
  assert.equal(usage.file_count, 2)
  assert.ok(usage.measured_at)
  if (process.platform === 'win32') assert.equal(usage.allocated_bytes, undefined)
  else assert.equal(typeof usage.allocated_bytes, 'number')
})

test('missing and cancelled scans are explicit failures rather than a zero-size successful workspace', async t => {
  const root = await fixture(t)
  await assert.rejects(scanWorkspaceUsage(path.join(root, 'missing')), { code: 'WORKSPACE_DIRECTORY_MISSING' })
  const controller = new AbortController(); controller.abort()
  await assert.rejects(scanWorkspaceUsage(root, { signal: controller.signal }), { code: 'WORKSPACE_SCAN_CANCELLED' })
})


test('an unreadable directory is a partial result rather than a successful zero omission', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const root = await fixture(t), locked = path.join(root, 'locked')
  await fs.mkdir(locked)
  await fs.writeFile(path.join(locked, 'private'), Buffer.alloc(1024))
  await fs.writeFile(path.join(root, 'visible'), Buffer.alloc(17))
  await fs.chmod(locked, 0)
  try {
    const usage = await scanWorkspaceUsage(root)
    assert.equal(usage.status, 'partial')
    assert.equal(usage.logical_bytes, 17)
    assert.ok(usage.skipped_entries > 0)
  } finally { await fs.chmod(locked, 0o700) }
})

test('a registered root replaced by a link cannot become a scan of an unrelated project', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'workspace-replaced-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const outside = path.join(root, 'outside'), selected = path.join(root, 'selected')
  await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'private.bin'), Buffer.alloc(99))
  await fs.symlink(outside, selected, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(scanWorkspaceUsage(selected), { code: 'WORKSPACE_SCAN_STALE' })
})

test('aggregate usage deduplicates overlapping roots and hard links across separate projects', async t => {
  const root = await fixture(t), a = path.join(root, 'a'), b = path.join(root, 'b')
  await fs.mkdir(a); await fs.mkdir(b); await fs.mkdir(path.join(a, 'nested'))
  await fs.writeFile(path.join(a, 'one'), Buffer.alloc(13)); await fs.writeFile(path.join(a, 'nested/two'), Buffer.alloc(17))
  await fs.link(path.join(a, 'one'), path.join(b, 'shared'))
  const usage = await scanWorkspaceSetUsage([a, path.join(a, 'nested'), b, a])
  assert.equal(usage.logical_bytes, 30); assert.equal(usage.file_count, 2); assert.equal(usage.status, 'complete')
  assert.equal((await scanWorkspaceUsage(a)).logical_bytes, 30)
})
test('aggregate missing roots are partial, but an entirely unavailable set never becomes successful zero', async t => {
  const root = await fixture(t), missing = path.join(root, 'missing')
  await fs.writeFile(path.join(root, 'visible'), Buffer.alloc(11))
  const usage = await scanWorkspaceSetUsage([root, missing])
  assert.equal(usage.status, 'partial'); assert.equal(usage.logical_bytes, 11); assert.ok(usage.skipped_entries > 0)
  await assert.rejects(scanWorkspaceSetUsage([missing]), { code: 'WORKSPACE_DIRECTORY_MISSING' })
})

// The workflow runs this in a private Linux mount namespace; never mount on a developer host.
test('Linux same-device bind mounts stay outside workspace statistics', {
  skip: process.platform !== 'linux' || process.getuid?.() !== 0 || process.env.GITHUB_ACTIONS !== 'true',
}, async t => {
  const root = await fixture(t), project = path.join(root, 'project'), outside = path.join(root, 'outside')
  const mounted = path.join(project, 'mounted space'), run = promisify(execFile)
  await fs.mkdir(project); await fs.mkdir(outside); await fs.mkdir(mounted)
  await fs.writeFile(path.join(project, 'visible'), Buffer.alloc(13))
  await fs.writeFile(path.join(outside, 'must-not-follow'), Buffer.alloc(999))
  await run('mount', ['--bind', outside, mounted])
  try {
    assert.equal((await fs.stat(project)).dev, (await fs.stat(mounted)).dev)
    const usage = await scanWorkspaceUsage(project)
    assert.equal(usage.logical_bytes, 13); assert.equal(usage.file_count, 1)
    assert.equal(usage.status, 'partial'); assert.ok(usage.skipped_entries > 0)
    const union = await scanWorkspaceSetUsage([project, outside])
    assert.equal(union.logical_bytes, 1012); assert.equal(union.file_count, 2)
  } finally { await run('umount', [mounted]) }
})
