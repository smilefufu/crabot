import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { inspectWorkspaceRelocationTree } from './workspace-relocation-files.js'

async function fixture(t: test.TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-move-check-中文 space-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const source = path.join(root, 'source'); await fs.mkdir(source)
  return { root, source }
}
test('migration binding inspection is read-only, includes hidden dependencies, and preserves internal relative links', async t => {
  const { source } = await fixture(t)
  await fs.mkdir(path.join(source, '.git')); await fs.mkdir(path.join(source, 'node_modules'))
  await fs.writeFile(path.join(source, 'node_modules/dependency'), 'kept dependency')
  await fs.symlink('node_modules/dependency', path.join(source, 'relative-link'))
  const result = await inspectWorkspaceRelocationTree(source, 'copy')
  assert.deepEqual(result.issues, []); assert.equal(result.files, 1); assert.equal(result.links, 1)
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/)
  assert.deepEqual(await inspectWorkspaceRelocationTree(source, 'copy'), result)
  assert.equal(await fs.readlink(path.join(source, 'relative-link')), 'node_modules/dependency')
  assert.equal(await fs.readFile(path.join(source, 'node_modules/dependency'), 'utf8'), 'kept dependency')
})
test('known absolute/escaping links, linked Git layouts and Python venvs are reported before any move', async t => {
  const { root, source } = await fixture(t)
  await fs.mkdir(path.join(source, 'clone')); await fs.mkdir(path.join(source, 'venv'))
  await fs.writeFile(path.join(source, 'clone/.git'), 'gitdir: /unrelated/private/repository')
  await fs.writeFile(path.join(source, 'venv/pyvenv.cfg'), 'home = /old/interpreter')
  await fs.symlink(root, path.join(source, 'absolute'), process.platform === 'win32' ? 'junction' : 'dir')
  await fs.symlink('../outside', path.join(source, 'escape'))
  const result = await inspectWorkspaceRelocationTree(source, 'rename')
  assert.deepEqual(result.issues.map(issue => [issue.path, issue.reason]).sort(), [
    ['absolute', 'absolute_link'], ['clone/.git', 'git_worktree'], ['escape', 'external_link'], ['venv/pyvenv.cfg', 'python_environment'],
  ])
  assert.equal(await fs.readFile(path.join(source, 'clone/.git'), 'utf8'), 'gitdir: /unrelated/private/repository')
})
test('a Git common directory with registered worktrees is distinct from an ordinary Git repository', async t => {
  const { source } = await fixture(t)
  await fs.mkdir(path.join(source, '.git/worktrees/other'), { recursive: true })
  await fs.writeFile(path.join(source, '.git/worktrees/other/gitdir'), '/outside/worktree/.git')
  const result = await inspectWorkspaceRelocationTree(source, 'copy')
  assert.ok(result.issues.some(issue => issue.path === '.git/worktrees' && issue.reason === 'git_worktree'))
})
test('copy detects external hard links without rejecting a closed internal hard-link group', async t => {
  const { root, source } = await fixture(t)
  await fs.writeFile(path.join(source, 'inside'), 'same inode')
  await fs.link(path.join(source, 'inside'), path.join(source, 'second'))
  assert.deepEqual((await inspectWorkspaceRelocationTree(source, 'copy')).issues, [])
  await fs.link(path.join(source, 'inside'), path.join(root, 'outside'))
  assert.ok((await inspectWorkspaceRelocationTree(source, 'copy')).issues.some(issue => issue.reason === 'external_hardlink'))
  assert.deepEqual((await inspectWorkspaceRelocationTree(source, 'rename')).issues, [])
})
test('missing/replaced roots and cancellation never create an empty replacement or a successful observation', async t => {
  const { root, source } = await fixture(t), missing = path.join(root, 'missing')
  await assert.rejects(inspectWorkspaceRelocationTree(missing, 'copy'))
  await assert.rejects(fs.stat(missing), { code: 'ENOENT' })
  const alias = path.join(root, 'alias'); await fs.symlink(source, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(inspectWorkspaceRelocationTree(alias, 'copy'), { code: 'WORKSPACE_SCAN_STALE' })
  const controller = new AbortController(); controller.abort()
  await assert.rejects(inspectWorkspaceRelocationTree(source, 'copy', { signal: controller.signal }), { code: 'WORKSPACE_SCAN_CANCELLED' })
})

test('inspection fingerprints detect metadata replacement without requiring file-body access', { skip: process.platform === 'win32' }, async t => {
  const { source } = await fixture(t), file = path.join(source, 'private-content')
  await fs.writeFile(file, 'must not be read by the inspector')
  await fs.chmod(file, 0)
  try {
    const first = await inspectWorkspaceRelocationTree(source, 'copy')
    assert.equal(first.files, 1); assert.deepEqual(first.issues, [])
    await fs.rename(file, path.join(source, 'original'))
    await fs.writeFile(file, 'different inode with the same role')
    assert.notEqual((await inspectWorkspaceRelocationTree(source, 'copy')).fingerprint, first.fingerprint)
  } finally { await fs.chmod(path.join(source, 'original'), 0o600).catch(() => undefined) }
})

test('unreadable directories and special files are explicit blockers without opening file contents', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async t => {
  const { source } = await fixture(t), locked = path.join(source, 'locked')
  await fs.mkdir(locked); await fs.writeFile(path.join(locked, 'kept'), 'private')
  await promisify(execFile)('mkfifo', [path.join(source, 'pipe')])
  await fs.chmod(locked, 0)
  try {
    const result = await inspectWorkspaceRelocationTree(source, 'copy')
    assert.ok(result.issues.some(issue => issue.path === 'locked' && issue.reason === 'unreadable'))
    assert.ok(result.issues.some(issue => issue.path === 'pipe' && issue.reason === 'special_file'))
  } finally { await fs.chmod(locked, 0o700) }
})
