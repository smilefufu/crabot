import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { WorkspaceCatalog, projectWorkspaceCatalogRelocation } from './workspace-catalog.js'

const files = createRequire(import.meta.url)('../../scripts/lib/process-identity.cjs')
async function fixture(t: test.TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'catalog-relocation-中文-'))), data = path.join(root, 'data')
  if (process.platform === 'win32') files.createPrivateDirectory(data)
  else await fs.mkdir(data, { mode: 0o700 })
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const catalog = new WorkspaceCatalog({ dataRoot: data, files })
  const project = await catalog.createProject({ workspace_id: randomUUID(), name: '项目', description: 'keep description' })
  const outside = path.join(root, 'outside'); await fs.mkdir(outside)
  await catalog.createProject({ workspace_id: randomUUID(), name: 'outside', root: outside })
  await catalog.markUsed(project.workspace.workspace_id, '2026-10-19T00:00:00.000Z')
  const before = await catalog.snapshot(), target = path.join(root, 'new-root'), file = path.join(data, 'workspace-control/catalog.json')
  await fs.writeFile(path.join(project.workspace.root, 'kept'), 'original project files')
  return { root, data, catalog, project, outside, before, target, file }
}

test('one immutable projection preserves project identity, metadata and root-external projects', async t => {
  const f = await fixture(t), saved = structuredClone(f.before), after = projectWorkspaceCatalogRelocation(f.before, f.target)
  assert.deepEqual(f.before, saved)
  assert.equal(after.revision, f.before.revision + 1)
  assert.equal(after.storage_root, f.target)
  for (const [index, old] of f.before.workspaces.entries()) {
    const expected = old.root === f.outside ? old.root : path.join(f.target, path.relative(f.before.storage_root, old.root))
    assert.deepEqual(after.workspaces[index], { ...old, root: expected })
  }
  await assert.rejects(fs.stat(f.target), { code: 'ENOENT' })
})

test('commit changes only the catalog after actual files exist, and repeated/cold observation does not rewrite it', async t => {
  const f = await fixture(t); await fs.rename(f.before.storage_root, f.target)
  const first = await f.catalog.commitRelocation(f.before, f.target, async () => {})
  assert.equal(first.dispatch, 'dispatch')
  assert.deepEqual(first.snapshot, projectWorkspaceCatalogRelocation(f.before, f.target))
  const bytes = await fs.readFile(f.file), stat = await fs.stat(f.file, { bigint: true })
  assert.equal((await f.catalog.commitRelocation(f.before, f.target, async () => {})).dispatch, 'observe')
  assert.deepEqual(await fs.readFile(f.file), bytes)
  const again = await fs.stat(f.file, { bigint: true }); assert.equal(again.ino, stat.ino); assert.equal(again.mtimeNs, stat.mtimeNs)
  assert.deepEqual(await new WorkspaceCatalog({ dataRoot: f.data, files }).snapshot(), first.snapshot)
  assert.equal(await fs.readFile(path.join(first.snapshot.workspaces.find(item => item.workspace_id === f.project.workspace.workspace_id)!.root, 'kept'), 'utf8'), 'original project files')
  await assert.rejects(fs.stat(f.before.storage_root), { code: 'ENOENT' })
})

for (const change of ['metadata', 'same revision different bytes', 'missing target', 'missing project', 'explicit root', 'missing verifier']) test('invalid or changed fixed inputs never select an empty/replacement root: ' + change, async t => {
  const f = await fixture(t), original = await fs.readFile(f.file)
  if (change === 'metadata') await f.catalog.update(f.project.workspace.workspace_id, { expected_revision: f.before.revision, name: 'newer', description: '' })
  if (change === 'same revision different bytes') { const invalid = JSON.parse(original.toString()); invalid.workspaces[0].description = 'changed'; await fs.writeFile(f.file, JSON.stringify(invalid)) }
  if (change !== 'missing target') await fs.rename(f.before.storage_root, f.target)
  if (change === 'missing project') await fs.rm(path.join(f.target, path.relative(f.before.storage_root, f.project.workspace.root)), { recursive: true })
  const bytes = await fs.readFile(f.file)
  const catalog = change === 'explicit root' ? new WorkspaceCatalog({ dataRoot: f.data, storageRoot: f.before.storage_root, files }) : f.catalog
  await assert.rejects(catalog.commitRelocation(f.before, f.target, change === 'missing verifier' ? undefined as any : async () => {}))
  assert.deepEqual(await fs.readFile(f.file), bytes)
  assert.equal((await f.catalog.snapshot()).storage_root, f.before.storage_root)
})

for (const boundary of [1, 2, 3]) test('fresh original-role refusal at verification ' + boundary + ' preserves the old selection', async t => {
  const f = await fixture(t), original = await fs.readFile(f.file); await fs.rename(f.before.storage_root, f.target)
  let calls = 0
  await assert.rejects(f.catalog.commitRelocation(f.before, f.target, async () => { if (++calls === boundary) throw new Error('original role unavailable') }))
  assert.equal(calls, boundary); assert.deepEqual(await fs.readFile(f.file), original)
  assert.equal(await fs.readFile(path.join(f.target, path.relative(f.before.storage_root, f.project.workspace.root), 'kept'), 'utf8'), 'original project files')
})

for (const boundary of [4, 5]) test('lost final confirmation retains the new selection and a repeat only observes it: ' + boundary, async t => {
  const f = await fixture(t); await fs.rename(f.before.storage_root, f.target)
  let calls = 0
  await assert.rejects(f.catalog.commitRelocation(f.before, f.target, async () => { if (++calls === boundary) throw new Error('lost confirmation') }))
  assert.equal((await f.catalog.snapshot()).storage_root, f.target)
  assert.equal((await f.catalog.commitRelocation(f.before, f.target, async () => {})).dispatch, 'observe')
})

for (const change of ['same root', 'nested target', 'ancestor target', 'relative target', 'unnormalized target', 'NUL target', 'revision overflow', 'duplicate projected root']) test('pure relocation rejects unsafe or ambiguous projection: ' + change, async t => {
  const f = await fixture(t), before = structuredClone(f.before)
  let target = f.target
  if (change === 'same root') target = before.storage_root
  if (change === 'nested target') target = path.join(before.storage_root, 'nested')
  if (change === 'ancestor target') target = path.dirname(before.storage_root)
  if (change === 'relative target') target = 'relative'
  if (change === 'unnormalized target') target += path.sep + '..' + path.sep + 'different'
  if (change === 'NUL target') target += '\0suffix'
  if (change === 'revision overflow') before.revision = Number.MAX_SAFE_INTEGER
  if (change === 'duplicate projected root') before.workspaces.find(item => item.root === f.outside)!.root = path.join(target, 'default')
  const bytes = await fs.readFile(f.file)
  assert.throws(() => projectWorkspaceCatalogRelocation(before, target))
  assert.deepEqual(await fs.readFile(f.file), bytes)
})

test('path-prefix siblings remain external and explicit new metadata is preserved field by field', async t => {
  const f = await fixture(t), before = structuredClone(f.before), external = before.workspaces.find(item => item.root === f.outside)!
  external.root = before.storage_root + '-sibling'
  const projected = projectWorkspaceCatalogRelocation(before, f.target)
  assert.deepEqual(projected.workspaces.find(item => item.workspace_id === external.workspace_id), external)
})

for (const boundary of [2, 3]) test('replacement while authorization waits cannot publish a stale target at boundary ' + boundary, async t => {
  const f = await fixture(t), original = await fs.readFile(f.file); await fs.rename(f.before.storage_root, f.target)
  let calls = 0
  await assert.rejects(f.catalog.commitRelocation(f.before, f.target, async () => {
    if (++calls === boundary) { await fs.rename(f.target, f.target + '-preserved'); await fs.mkdir(f.target) }
  }))
  assert.deepEqual(await fs.readFile(f.file), original)
  assert.equal(await fs.readFile(path.join(f.target + '-preserved', path.relative(f.before.storage_root, f.project.workspace.root), 'kept'), 'utf8'), 'original project files')
})


test('a fixed migration target cannot silently resolve through a new directory link', async t => {
  const f = await fixture(t), original = await fs.readFile(f.file); await fs.rename(f.before.storage_root, f.target)
  const alias = path.join(f.root, 'target-alias')
  await fs.symlink(f.target, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(f.catalog.commitRelocation(f.before, alias, async () => {}))
  assert.deepEqual(await fs.readFile(f.file), original)
})


test('typed snapshots need no private catalog-file version field to commit', async t => {
  const f = await fixture(t), { revision, storage_root, workspaces } = f.before
  await fs.rename(storage_root, f.target)
  const result = await f.catalog.commitRelocation({ revision, storage_root, workspaces }, f.target, async () => {})
  assert.equal(result.dispatch, 'dispatch'); assert.equal(result.snapshot.storage_root, f.target)
})
