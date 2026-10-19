import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { scanWorkspaceUsage } from './workspace-usage.js'

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
