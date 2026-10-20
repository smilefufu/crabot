import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { assertWorkspaceExecutionAllowed, workspaceMaintenancePending } from './workspace-maintenance.js'

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'crabot-workspace-fence-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const control = path.join(root, 'workspace-control'), record = path.join(control, 'relocation.json')
  return { root, control, record }
}

test('discovery permits an absent job without writing directories or records', async t => {
  const f = await fixture(t)
  assertWorkspaceExecutionAllowed(f.root)
  assert.deepEqual(await fs.readdir(f.root), [])
  await fs.mkdir(f.control)
  await fs.writeFile(path.join(f.control, 'catalog.json'), '{}')
  assertWorkspaceExecutionAllowed(f.root)
  assert.deepEqual(await fs.readdir(f.control), ['catalog.json'])
})

for (const content of ['{"schema_version":1}', 'broken', '', '{"phase":"completed"}']) {
  test('an active record blocks regardless of its claimed phase or parseability: ' + JSON.stringify(content), async t => {
    const f = await fixture(t)
    await fs.mkdir(f.control); await fs.writeFile(f.record, content)
    assert.throws(() => assertWorkspaceExecutionAllowed(f.root), { code: 'WORKSPACE_MAINTENANCE' })
    assert.equal(await fs.readFile(f.record, 'utf8'), content)
  })
}

test('a late record is observed on every admission and another instance is independent', async t => {
  const f = await fixture(t), other = await fixture(t)
  assertWorkspaceExecutionAllowed(f.root)
  await fs.mkdir(f.control); await fs.writeFile(f.record, '{}')
  assert.throws(() => assertWorkspaceExecutionAllowed(f.root), { code: 'WORKSPACE_MAINTENANCE' })
  assertWorkspaceExecutionAllowed(other.root)
})

test('a directory or dangling link at the activity location cannot bypass the gate', async t => {
  const f = await fixture(t)
  await fs.mkdir(f.control); await fs.mkdir(f.record)
  assert.throws(() => assertWorkspaceExecutionAllowed(f.root), { code: 'WORKSPACE_MAINTENANCE' })
  await fs.rmdir(f.record)
  await fs.symlink(path.join(f.root, 'missing'), f.record, process.platform === 'win32' ? 'junction' : 'file')
  assert.throws(() => assertWorkspaceExecutionAllowed(f.root), { code: 'WORKSPACE_MAINTENANCE' })
})

test('a control directory replaced with a file or a link fails closed without following it', async t => {
  const f = await fixture(t)
  await fs.writeFile(f.control, '')
  assert.throws(() => assertWorkspaceExecutionAllowed(f.root), { code: 'WORKSPACE_MAINTENANCE' })
  await fs.rm(f.control)
  const other = await fixture(t)
  await fs.symlink(other.root, f.control, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => assertWorkspaceExecutionAllowed(f.root), { code: 'WORKSPACE_MAINTENANCE' })
  assert.deepEqual(await fs.readdir(other.root), [])
})


test('an unreadable control directory blocks rather than claiming no job', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const f = await fixture(t)
  await fs.mkdir(f.control, { mode: 0o700 })
  await fs.chmod(f.control, 0)
  try { assert.throws(() => assertWorkspaceExecutionAllowed(f.root), { code: 'WORKSPACE_MAINTENANCE' }) }
  finally { await fs.chmod(f.control, 0o700) }
})


test('the independent bootstrap guard matches Shared on absent, malformed, and replaced control paths', async t => {
  const bootstrap = createRequire(import.meta.url)('../../scripts/lib/workspace-maintenance.cjs')
  const f = await fixture(t)
  const compare = (expected: boolean) => {
    assert.equal(workspaceMaintenancePending(f.root), expected)
    assert.equal(bootstrap.workspaceMaintenancePending(f.root), expected)
    if (expected) assert.throws(() => bootstrap.assertWorkspaceExecutionAllowed(f.root), { code: 'WORKSPACE_MAINTENANCE' })
    else bootstrap.assertWorkspaceExecutionAllowed(f.root)
  }
  compare(false)
  await fs.mkdir(f.control); compare(false)
  await fs.writeFile(f.record, 'broken'); compare(true)
  await fs.rm(f.record); await fs.mkdir(f.record); compare(true)
  await fs.rmdir(f.record); await fs.symlink(path.join(f.root, 'missing'), f.record, process.platform === 'win32' ? 'junction' : 'file'); compare(true)
  await fs.rm(f.record); await fs.rmdir(f.control); await fs.writeFile(f.control, 'replaced'); compare(true)
})


for (const record of ['relocation-workers.json', 'relocation-stop-attempt.json', 'relocation-stop-submission.json', 'relocation-modules.json', 'relocation-module-stop-attempt.json', 'relocation-module-processes', 'relocation-module-stop-submission.json'])
for (const kind of ['file', 'directory', 'link']) test('orphaned evidence keeps both guards closed: ' + record + '/' + kind, async t => {
  const f = await fixture(t), scope = path.join(f.control, record)
  const bootstrap = createRequire(import.meta.url)('../../scripts/lib/workspace-maintenance.cjs')
  await fs.mkdir(f.control)
  if (kind === 'file') await fs.writeFile(scope, 'unverified fixed set')
  if (kind === 'directory') await fs.mkdir(scope)
  if (kind === 'link') await fs.symlink(path.join(f.root, 'missing'), scope, process.platform === 'win32' ? 'junction' : 'file')
  assert.throws(() => assertWorkspaceExecutionAllowed(f.root), { code: 'WORKSPACE_MAINTENANCE' })
  assert.throws(() => bootstrap.assertWorkspaceExecutionAllowed(f.root), { code: 'WORKSPACE_MAINTENANCE' })
  await fs.rm(scope, { recursive: kind === 'directory' })
  assertWorkspaceExecutionAllowed(f.root); bootstrap.assertWorkspaceExecutionAllowed(f.root)
})
