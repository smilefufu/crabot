import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { WorkspaceCatalog } from './workspace-catalog.js'

const nativePath = fileURLToPath(new URL('../../scripts/lib/process-identity.cjs', import.meta.url))
const files = createRequire(import.meta.url)(nativePath)

async function fixture(t: test.TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-project-中文 space-')))
  const data = path.join(root, 'data')
  await fs.mkdir(data, { mode: 0o700 })
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return { root, data, catalog: new WorkspaceCatalog({ files, dataRoot: data }) }
}

test('read-only discovery does not create storage; initialization has exactly one default workspace', async t => {
  const f = await fixture(t)
  assert.equal((await f.catalog.snapshot()).workspaces.length, 0)
  await assert.rejects(fs.stat(path.join(f.data, 'workspace-control')), { code: 'ENOENT' })
  await f.catalog.initialize()
  const state = await f.catalog.snapshot()
  assert.equal(state.workspaces.length, 1)
  assert.equal(state.workspaces[0].workspace_id, 'default')
  assert.equal((await fs.stat(state.workspaces[0].root)).isDirectory(), true)
  const a = await f.catalog.resolveDefaultTask('worker-a'), b = await f.catalog.resolveDefaultTask('worker-b')
  assert.notEqual(a.root, b.root)
  assert.equal(a.workspace_id, 'default'); assert.equal(b.workspace_id, 'default')
  assert.equal((await f.catalog.snapshot()).workspaces.length, 1)
  assert.equal(await fs.realpath(a.root), path.join(state.workspaces[0].root, 'tasks', 'worker-a'))
})

test('one project is reused by stable identity and canonical directory, not by its display name', async t => {
  const f = await fixture(t), id = randomUUID()
  const original = await f.catalog.createProject({ workspace_id: id, name: 'Crabot 项目', description: 'desktop' })
  await fs.writeFile(path.join(original.workspace.root, 'work.txt'), 'project content')
  const again = await f.catalog.createProject({ workspace_id: id, name: 'Crabot 项目' })
  assert.equal(again.workspace.workspace_id, id)
  const duplicateRoot = await f.catalog.createProject({ workspace_id: randomUUID(), name: 'another label', root: original.workspace.root })
  assert.equal(duplicateRoot.workspace.workspace_id, id)
  const sameLabel = await f.catalog.createProject({ workspace_id: randomUUID(), name: 'Crabot 项目' })
  assert.notEqual(sameLabel.workspace.workspace_id, id)
  assert.notEqual(sameLabel.workspace.root, original.workspace.root)
  const cold = new WorkspaceCatalog({ files, dataRoot: f.data })
  assert.equal((await cold.snapshot()).workspaces.length, 3)
  assert.equal(await fs.readFile(path.join((await cold.get(id)).root, 'work.txt'), 'utf8'), 'project content')
})

test('concurrent registrars preserve every project and stale metadata edits never overwrite a newer revision', async t => {
  const f = await fixture(t)
  await f.catalog.initialize()
  const records = await Promise.all(Array.from({ length: 5 }, (_, i) => new WorkspaceCatalog({ files, dataRoot: f.data })
    .createProject({ workspace_id: randomUUID(), name: 'project-' + i })))
  const state = await f.catalog.snapshot()
  assert.equal(state.workspaces.length, 6)
  const selected = records[0].workspace
  const updated = await f.catalog.update(selected.workspace_id, { expected_revision: state.revision, name: 'renamed', description: 'project purpose' })
  await assert.rejects(f.catalog.update(selected.workspace_id, { expected_revision: state.revision, name: 'stale', description: '' }), { code: 'WORKSPACE_REVISION_CONFLICT' })
  assert.equal((await f.catalog.get(selected.workspace_id)).name, 'renamed')
  assert.equal(updated.workspace.root, selected.root)
  assert.ok(updated.revision > state.revision)
})

test('a missing project never turns into an empty replacement or a default task; traversal is rejected', async t => {
  const f = await fixture(t)
  const created = await f.catalog.createProject({ workspace_id: randomUUID(), name: 'existing project' })
  await fs.rm(created.workspace.root, { recursive: true })
  await assert.rejects(f.catalog.resolveProject(created.workspace.workspace_id), { code: 'WORKSPACE_DIRECTORY_MISSING' })
  await assert.rejects(fs.stat(created.workspace.root), { code: 'ENOENT' })
  await assert.rejects(f.catalog.resolveDefaultTask('../another-task'), { code: 'WORKSPACE_INVALID_REQUEST' })
  await assert.rejects(f.catalog.createProject({ workspace_id: randomUUID(), name: 'private data', root: f.data }), { code: 'WORKSPACE_INVALID_REQUEST' })
})

test('user project files survive registration; corrupt and missing established catalogs fail without rewriting', async t => {
  const f = await fixture(t), existing = path.join(f.root, '用户项目')
  await fs.mkdir(existing)
  await fs.writeFile(path.join(existing, '.mcp.json'), 'user configuration')
  await f.catalog.createProject({ workspace_id: randomUUID(), name: 'my project', root: existing })
  assert.equal(await fs.readFile(path.join(existing, '.mcp.json'), 'utf8'), 'user configuration')
  const file = path.join(f.data, 'workspace-control', 'catalog.json'), before = await fs.readFile(file)
  await fs.writeFile(file, '{invalid')
  await assert.rejects(f.catalog.initialize(), { code: 'WORKSPACE_STATE_INVALID' })
  assert.equal(await fs.readFile(file, 'utf8'), '{invalid')
  await fs.writeFile(file, before)
  await fs.rm(file)
  await assert.rejects(f.catalog.initialize(), { code: 'WORKSPACE_STATE_INVALID' })
  await assert.rejects(fs.stat(file), { code: 'ENOENT' })
})


test('independent Node processes serialize catalog changes through the OS lock', { timeout: 15_000 }, async t => {
  const f = await fixture(t)
  const script = `const { createRequire } = await import('node:module');const files=createRequire(import.meta.url)(process.argv[4]);const { WorkspaceCatalog } = await import(process.argv[1]);const catalog=new WorkspaceCatalog({files,dataRoot:process.argv[2]});await catalog.createProject({workspace_id:process.argv[3],name:'parallel project'});`
  const loader = new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href
  await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath,
    ['--import', loader, '--input-type=module', '-e', script, new URL('./workspace-catalog.ts', import.meta.url).href, f.data, randomUUID(), nativePath],
    { timeout: 10_000 })))
  const state = await f.catalog.snapshot()
  assert.equal(state.workspaces.length, 5)
  assert.equal(new Set(state.workspaces.map(record => record.root)).size, 5)
})

test('default task symlink replacement cannot redirect writes or grant another task root', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'outside')
  await fs.mkdir(outside)
  const assigned = await f.catalog.resolveDefaultTask('original')
  await fs.rmdir(assigned.root)
  await fs.symlink(outside, assigned.root, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(f.catalog.resolveDefaultTask('original'), { code: 'WORKSPACE_STATE_INVALID' })
  assert.deepEqual(await fs.readdir(outside), [])
})

test('an explicit storage root conflicting with the persistent binding cannot create a second catalog', async t => {
  const f = await fixture(t)
  await f.catalog.initialize()
  const before = await fs.readFile(path.join(f.data, 'workspace-control/catalog.json'))
  const conflicting = new WorkspaceCatalog({ files, dataRoot: f.data, storageRoot: path.join(f.root, 'other-root') })
  await assert.rejects(conflicting.initialize(), { code: 'WORKSPACE_STATE_INVALID' })
  assert.deepEqual(await fs.readFile(path.join(f.data, 'workspace-control/catalog.json')), before)
  await assert.rejects(fs.lstat(path.join(f.root, 'other-root')), { code: 'ENOENT' })
})

test('a replaced data root cannot redirect a live catalog to another instance', async t => {
  const f = await fixture(t), second = path.join(f.root, 'second'), retained = path.join(f.root, 'retained')
  await f.catalog.initialize()
  await fs.mkdir(second, { mode: 0o700 })
  await new WorkspaceCatalog({ files, dataRoot: second }).initialize()
  await fs.rename(f.data, retained)
  await fs.symlink(second, f.data, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(f.catalog.snapshot(), { code: 'WORKSPACE_STATE_INVALID' })
})

test('distinct stable project IDs with the same short prefix cannot collide on a managed directory', async t => {
  const f = await fixture(t)
  const a = await f.catalog.createProject({ workspace_id: '12345678-0000-4000-8000-000000000001', name: '同名' })
  const b = await f.catalog.createProject({ workspace_id: '12345678-0000-4000-8000-000000000002', name: '同名' })
  assert.notEqual(a.workspace.root, b.workspace.root)
})

test('a private catalog larger than the native small-file limit remains readable on every platform', async t => {
  const f = await fixture(t)
  for (let i = 0; i < 36; i++) await f.catalog.createProject({ workspace_id: randomUUID(), name: 'project-' + i, description: 'a'.repeat(2000) })
  const stat = await fs.stat(path.join(f.data, 'workspace-control/catalog.json'))
  assert.ok(stat.size > 65536)
  assert.equal((await new WorkspaceCatalog({ files, dataRoot: f.data }).snapshot()).workspaces.length, 37)
})

test('a project cannot contain application control data and private executor profiles', async t => {
  const f = await fixture(t)
  await assert.rejects(f.catalog.createProject({ workspace_id: randomUUID(), name: 'parent of application data', root: f.root }), { code: 'WORKSPACE_INVALID_REQUEST' })
})

test('a missing established default root is reported and never recreated for new tasks', async t => {
  const f = await fixture(t)
  await f.catalog.initialize()
  const root = (await f.catalog.get('default')).root
  await fs.rm(root, { recursive: true, force: true })
  await f.catalog.initialize()
  await assert.rejects(f.catalog.resolveDefaultTask('new-task'), { code: 'WORKSPACE_DIRECTORY_MISSING' })
  await assert.rejects(fs.stat(root), { code: 'ENOENT' })
})
