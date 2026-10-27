import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import management from '../desktop-management.cjs'
import { verifyDataCompatibility } from '../data-compatibility.mjs'
import { previewMigrations, runMigrations } from '../../upgrade-lib/migrate.mjs'
import { WorkspaceCatalog } from '../../../crabot-shared/dist/workspace-catalog.js'
const identity = createRequire(import.meta.url)('../process-identity.cjs')
async function fixture(t, { catalog = true } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-compat-中文 space-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const data = management.ensurePrivateDataRoot(path.join(root, 'data')), target = path.join(root, 'target')
  await fs.mkdir(path.join(target, 'crabot-agent'), { recursive: true })
  if (catalog) await new WorkspaceCatalog({ dataRoot: data, files: identity }).initialize()
  const declaration = path.join(target, 'crabot-agent/workspace-data-compat.json')
  const declare = versions => fs.writeFile(declaration, JSON.stringify({ schema_version: 1, workspace_data_versions: versions }))
  return { root, data, target, declaration, declare, catalog: path.join(data, 'workspace-control/catalog.json') }
}
test('pre-workspace installations retain their original schema semantics without a new data marker', async t => {
  const f = await fixture(t, { catalog: false })
  assert.deepEqual(verifyDataCompatibility(f.target, f.data), [])
  assert.deepEqual(await fs.readdir(f.data), [])
})
test('new project/private runtime data requires an explicit target capability before any module migration', async t => {
  const f = await fixture(t), original = await fs.readFile(f.catalog)
  await fs.mkdir(path.join(f.target, 'crabot-memory/upgrade'), { recursive: true })
  await fs.mkdir(path.join(f.data, 'memory')); await fs.writeFile(path.join(f.data, 'memory/existing'), 'kept')
  await fs.writeFile(path.join(f.target, 'crabot-memory/schema_version'), 'v1')
  await fs.writeFile(path.join(f.target, 'crabot-memory/upgrade/from_v0_to_v1.mjs'), 'process.exit(0)')
  await assert.rejects(previewMigrations(f.target, f.data), { code: 'CRABOT_DATA_NEWER_THAN_CODE' })
  await assert.rejects(runMigrations(f.target, f.data, async () => { throw new Error('must not execute') }, console, { lockHeld: true }), { code: 'CRABOT_DATA_NEWER_THAN_CODE' })
  await assert.rejects(fs.stat(path.join(f.data, 'memory/SCHEMA_VERSION')), { code: 'ENOENT' })
  assert.deepEqual(await fs.readFile(f.catalog), original)
  await f.declare([1])
  assert.equal(verifyDataCompatibility(f.target, f.data)[0].moduleId, 'crabot-memory')
  await assert.rejects(fs.stat(path.join(f.data, 'agent/SCHEMA_VERSION')), { code: 'ENOENT' })
})
test('supported data is checked read-only and neither version strings nor malformed declarations imply support', async t => {
  const f = await fixture(t), original = await fs.readFile(f.catalog)
  for (const versions of [[2], ['1'], [], [1, 1], null]) {
    await f.declare(versions)
    assert.throws(() => verifyDataCompatibility(f.target, f.data), { code: 'CRABOT_DATA_NEWER_THAN_CODE' })
  }
  await f.declare([1])
  assert.deepEqual(verifyDataCompatibility(f.target, f.data), [])
  assert.deepEqual(await fs.readFile(f.catalog), original)
  await fs.writeFile(f.declaration, '{malformed')
  assert.throws(() => verifyDataCompatibility(f.target, f.data), { code: 'CRABOT_DATA_NEWER_THAN_CODE' })
})
test('a future workspace format cannot be relabelled by a compatible Memory version', async t => {
  const f = await fixture(t), value = JSON.parse(await fs.readFile(f.catalog, 'utf8'))
  value.version = 2; await fs.writeFile(f.catalog, JSON.stringify(value))
  await f.declare([1])
  assert.throws(() => verifyDataCompatibility(f.target, f.data), { code: 'CRABOT_DATA_NEWER_THAN_CODE' })
  assert.equal(JSON.parse(await fs.readFile(f.catalog, 'utf8')).version, 2)
})
test('lost/corrupt established workspace state and a private runtime without its catalog are not fresh data', async t => {
  const f = await fixture(t); await f.declare([1])
  await fs.writeFile(f.catalog, '{malformed')
  assert.throws(() => verifyDataCompatibility(f.target, f.data), { code: 'CRABOT_SCHEMA_VERSION_INVALID' })
  await fs.unlink(f.catalog)
  assert.throws(() => verifyDataCompatibility(f.target, f.data), { code: 'CRABOT_SCHEMA_VERSION_INVALID' })
  await fs.rm(path.join(f.data, 'workspace-control'), { recursive: true })
  await fs.mkdir(path.join(f.data, 'agent/worker-runtime'), { recursive: true })
  assert.throws(() => verifyDataCompatibility(f.target, f.data), { code: 'CRABOT_SCHEMA_VERSION_INVALID' })
  await assert.rejects(fs.stat(f.catalog), { code: 'ENOENT' })
})
test('workspace control links and hardlinked catalogs are refused before reading an unrelated scope', async t => {
  const f = await fixture(t); await f.declare([1])
  const original = await fs.readFile(f.catalog)
  await fs.link(f.catalog, path.join(f.root, 'external-link'))
  assert.throws(() => verifyDataCompatibility(f.target, f.data), { code: 'CRABOT_SCHEMA_VERSION_INVALID' })
  await fs.unlink(path.join(f.root, 'external-link'))
  await fs.rename(path.join(f.data, 'workspace-control'), path.join(f.root, 'outside'))
  await fs.symlink(path.join(f.root, 'outside'), path.join(f.data, 'workspace-control'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => verifyDataCompatibility(f.target, f.data), { code: 'CRABOT_SCHEMA_VERSION_INVALID' })
  assert.deepEqual(await fs.readFile(path.join(f.root, 'outside/catalog.json')), original)
})
