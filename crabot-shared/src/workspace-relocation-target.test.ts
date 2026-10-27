import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
const native = createRequire(import.meta.url)('../../scripts/lib/process-identity.cjs')
import { inspectWorkspaceRelocationTarget } from './workspace-relocation-target.js'

async function fixture(t: test.TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-target-中文 space-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const source = path.join(root, 'source'); await fs.mkdir(source)
  await fs.writeFile(path.join(source, 'kept'), 'original')
  return { root, source, protectedRoots: [path.join(root, 'private-state')], inspectTargetAccess: native.inspectDirectoryWriteAccess }
}

test('same-volume preflight resolves a missing nested destination without creating it or modifying source', async t => {
  const f = await fixture(t), target = path.join(f.root, 'not-created', 'new workspace')
  const result = await inspectWorkspaceRelocationTarget(f.source, target, f)
  assert.equal(result.mode, 'rename'); assert.equal(result.source, f.source); assert.equal(result.target, target)
  assert.equal(result.usage.logical_bytes, 8); assert.deepEqual(result.inspection.issues, [])
  assert.ok(result.available_bytes > 0n)
  await assert.rejects(fs.stat(path.dirname(target)), { code: 'ENOENT' })
  assert.equal(await fs.readFile(path.join(f.source, 'kept'), 'utf8'), 'original')
})

test('an existing empty destination is observed; a nonempty user destination is never accepted or cleared', async t => {
  const f = await fixture(t), target = path.join(f.root, 'destination')
  await fs.mkdir(target)
  const observed = await inspectWorkspaceRelocationTarget(f.source, target, f)
  assert.equal(observed.target_exists, true)
  await fs.writeFile(path.join(target, 'user-file'), 'do not overwrite')
  await assert.rejects(inspectWorkspaceRelocationTarget(f.source, target, f), { code: 'WORKSPACE_DIRECTORY_CONFLICT' })
  assert.equal(await fs.readFile(path.join(target, 'user-file'), 'utf8'), 'do not overwrite')
})

for (const relation of ['within source', 'contains source', 'private child', 'private parent']) {
  test('preflight rejects unsafe placement: ' + relation, async t => {
    const f = await fixture(t)
    const target = relation === 'within source' ? path.join(f.source, 'child')
      : relation === 'contains source' ? f.root : relation === 'private child' ? path.join(f.protectedRoots[0], 'child') : f.protectedRoots[0]
    await assert.rejects(inspectWorkspaceRelocationTarget(f.source, target, f), { code: 'WORKSPACE_INVALID_REQUEST' })
    assert.equal(await fs.readFile(path.join(f.source, 'kept'), 'utf8'), 'original')
  })
}

test('a destination link is not silently treated as an empty ordinary folder', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'outside'), target = path.join(f.root, 'alias')
  await fs.mkdir(outside); await fs.symlink(outside, target, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(inspectWorkspaceRelocationTarget(f.source, target, f), { code: 'WORKSPACE_INVALID_REQUEST' })
  assert.deepEqual(await fs.readdir(outside), [])
})

test('known source blockers stay visible in the preview and cancellation does not create a destination', async t => {
  const f = await fixture(t), target = path.join(f.root, 'destination')
  await fs.mkdir(path.join(f.source, 'environment')); await fs.writeFile(path.join(f.source, 'environment/pyvenv.cfg'), 'home = /old/base')
  const result = await inspectWorkspaceRelocationTarget(f.source, target, f)
  assert.ok(result.inspection.issues.some(item => item.reason === 'python_environment'))
  const controller = new AbortController(); controller.abort()
  await assert.rejects(inspectWorkspaceRelocationTarget(f.source, target, { ...f, signal: controller.signal }), { code: 'WORKSPACE_SCAN_CANCELLED' })
  await assert.rejects(fs.stat(target), { code: 'ENOENT' })
})

test('Linux existing different filesystems select copy without mounting or writing the selected destination', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t)
  let parent: string
  try { parent = await fs.realpath(await fs.mkdtemp('/dev/shm/crabot-copy-preview-')) }
  catch { t.skip('No writable second filesystem available'); return }
  t.after(() => fs.rm(parent, { recursive: true, force: true }))
  if ((await fs.stat(f.source)).dev === (await fs.stat(parent)).dev) { t.skip('Temporary paths share one filesystem'); return }
  const target = path.join(parent, 'not-created')
  assert.equal((await inspectWorkspaceRelocationTarget(f.source, target, f)).mode, 'copy')
  await assert.rejects(fs.stat(target), { code: 'ENOENT' })
})


test('selecting the current root is an explicit no-op rather than permission to stop or move', async t => {
  const f = await fixture(t)
  assert.deepEqual(await inspectWorkspaceRelocationTarget(f.source, f.source, f), { mode: 'unchanged', source: f.source, target: f.source })
  assert.equal(await fs.readFile(path.join(f.source, 'kept'), 'utf8'), 'original')
})


test('a source replaced between the initial identity check and the tree inspection is rejected', async t => {
  const f = await fixture(t), target = path.join(f.root, 'destination'), realpath = fs.realpath.bind(fs)
  let replaced = false
  t.mock.method(fs, 'realpath', async (...args: Parameters<typeof fs.realpath>) => {
    const result = await realpath(...args)
    if (args[0] === f.source && !replaced) {
      replaced = true
      await fs.rename(f.source, path.join(f.root, 'original-source'))
      await fs.mkdir(f.source); await fs.writeFile(path.join(f.source, 'kept'), 'new copy')
    }
    return result
  })
  await assert.rejects(inspectWorkspaceRelocationTarget(f.source, target, f), { code: 'WORKSPACE_SCAN_STALE' })
  assert.equal(replaced, true)
  assert.equal(await fs.readFile(path.join(f.root, 'original-source/kept'), 'utf8'), 'original')
  await assert.rejects(fs.stat(target), { code: 'ENOENT' })
})


test('target-only private exclusions keep the existing default source valid but reject other private destinations', async t => {
  const f = await fixture(t), options = { ...f, protectedTargets: [f.root] }
  assert.equal((await inspectWorkspaceRelocationTarget(f.source, f.source, options)).mode, 'unchanged')
  await assert.rejects(inspectWorkspaceRelocationTarget(f.source, path.join(f.root, 'other-state'), options), { code: 'WORKSPACE_INVALID_REQUEST' })
  const outside = path.join(path.dirname(f.root), 'outside-workspace-' + path.basename(f.root))
  assert.equal((await inspectWorkspaceRelocationTarget(f.source, outside, options)).mode, 'rename')
  await assert.rejects(fs.stat(outside), { code: 'ENOENT' })
})


test('an unwritable target ancestor is rejected before tasks stop or a destination is created', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const f = await fixture(t), parent = path.join(f.root, 'readonly-target'), target = path.join(parent, 'missing')
  await fs.mkdir(parent); await fs.chmod(parent, 0o500)
  try {
    await assert.rejects(inspectWorkspaceRelocationTarget(f.source, target, f), { code: 'WORKSPACE_UNAVAILABLE' })
    await assert.rejects(fs.stat(target), { code: 'ENOENT' })
    assert.equal(await fs.readFile(path.join(f.source, 'kept'), 'utf8'), 'original')
  } finally { await fs.chmod(parent, 0o700) }
})

test('only the host fixed default target can return below protected data/program ancestors', async t => {
  const f = await fixture(t), data = path.join(f.root, 'private-data'), target = path.join(data, 'workspaces')
  await fs.mkdir(data)
  const options = { ...f, protectedRoots: [path.join(data, 'workspace-control')], protectedTargets: [data, f.root], managedDefaultTarget: target }
  const preview = await inspectWorkspaceRelocationTarget(f.source, target, options)
  assert.equal(preview.mode, 'rename'); assert.equal(preview.target, target)
  for (const denied of [data, path.join(data, 'agent'), path.join(target, 'child'), f.root]) {
    await assert.rejects(inspectWorkspaceRelocationTarget(f.source, denied, options), { code: 'WORKSPACE_INVALID_REQUEST' })
  }
  await assert.rejects(inspectWorkspaceRelocationTarget(f.source, target, { ...options, protectedRoots: [path.join(target, 'actual-state')] }), { code: 'WORKSPACE_INVALID_REQUEST' })
  await assert.rejects(inspectWorkspaceRelocationTarget(f.source, target, { ...options, protectedTargets: [target] }), { code: 'WORKSPACE_INVALID_REQUEST' })
  await assert.rejects(inspectWorkspaceRelocationTarget(f.source, target, { ...options, protectedTargets: [path.join(target, 'program')] }), { code: 'WORKSPACE_INVALID_REQUEST' })
  await assert.rejects(fs.stat(target), { code: 'ENOENT' })
  assert.equal(await fs.readFile(path.join(f.source, 'kept'), 'utf8'), 'original')
})
test('the host default exception uses the exact canonical result and rejects a redirected default directory', async t => {
  const f = await fixture(t), data = path.join(f.root, 'private-data'), target = path.join(data, 'workspaces'), alias = path.join(f.root, 'data-alias')
  await fs.mkdir(data)
  const options = { ...f, protectedTargets: [data], managedDefaultTarget: target }
  await fs.symlink(data, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await inspectWorkspaceRelocationTarget(f.source, path.join(alias, 'workspaces'), options)).target, target)
  const privateState = path.join(data, 'actual-state'); await fs.mkdir(privateState)
  await fs.symlink(privateState, target, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(inspectWorkspaceRelocationTarget(f.source, target, options), { code: 'WORKSPACE_INVALID_REQUEST' })
  assert.deepEqual(await fs.readdir(privateState), [])
})

test('a default path replaced by a link between initial stat and canonicalization never exempts private state', async t => {
  const f = await fixture(t), data = path.join(f.root, 'private-data'), target = path.join(data, 'workspaces'), privateState = path.join(data, 'actual-state')
  await fs.mkdir(data); await fs.mkdir(privateState)
  const original = fs.lstat.bind(fs); let changed = false
  t.mock.method(fs, 'lstat', async (...args: any[]) => {
    try { return await original(...args as Parameters<typeof fs.lstat>) }
    catch (error) {
      if (!changed && args[0] === target && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        changed = true; await fs.symlink(privateState, target, process.platform === 'win32' ? 'junction' : 'dir')
      }
      throw error
    }
  })
  await assert.rejects(inspectWorkspaceRelocationTarget(f.source, target, { ...f, protectedTargets: [data], managedDefaultTarget: target }), { code: 'WORKSPACE_INVALID_REQUEST' })
  assert.equal(changed, true); assert.deepEqual(await fs.readdir(privateState), [])
  assert.equal(await fs.readFile(path.join(f.source, 'kept'), 'utf8'), 'original')
})
