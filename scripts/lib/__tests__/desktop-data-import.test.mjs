import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { copyDesktopData, importDesktopData, discoverDesktopDataSource } from '../desktop-data-import.mjs'

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-import-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const source = path.join(root, 'old/data'), target = path.join(root, 'new/data'), code = path.join(root, 'core')
  await fs.mkdir(source, { recursive: true, mode: 0o700 }); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.mkdir(code)
  await fs.mkdir(path.join(source, 'agent')); await fs.writeFile(path.join(source, 'agent/history.json'), '{"original":true}')
  return { root, source, target, code }
}
test('copy preserves original bytes and counts data without a second scan or copying the source lock', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.source, 'cli.lock'), 'source lock')
  const value = await copyDesktopData(f.source, f.target)
  assert.equal(value.files, 1)
  assert.equal(await fs.readFile(path.join(f.target, 'agent/history.json'), 'utf8'), '{"original":true}')
  assert.equal(await fs.readFile(path.join(f.source, 'agent/history.json'), 'utf8'), '{"original":true}')
  await assert.rejects(fs.stat(path.join(f.target, 'cli.lock')), { code: 'ENOENT' })
})
test('overlap and existing target data are rejected without overwriting either copy', async t => {
  const f = await fixture(t)
  await assert.rejects(copyDesktopData(f.source, path.join(f.source, 'nested')), /重叠/)
  await fs.mkdir(f.target); await fs.writeFile(path.join(f.target, 'keep'), 'keep')
  await assert.rejects(copyDesktopData(f.source, f.target), /非空/)
  assert.equal(await fs.readFile(path.join(f.target, 'keep'), 'utf8'), 'keep')
})
test('discovery accepts user data without a historical program-byte whitelist', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(path.dirname(f.source), 'VERSION'), 'v2026.10.14.1\n')
  const result = await discoverDesktopDataSource({ root: path.dirname(f.source) })
  assert.equal(result.dataRoot, f.source); assert.equal(result.version, 'v2026.10.14.1')
})
test('stop precedes copy; migrate receives only the new data and old operational receipts are retained as history', async t => {
  const f = await fixture(t), events = []
  await fs.writeFile(path.join(f.source, 'desktop-maintenance.json'), '{"phase":"installing"}')
  await importDesktopData({ source: { installRoot: path.dirname(f.source), dataRoot: f.source }, root: f.code, target: f.target,
    stop: async () => { events.push('stop'); await assert.rejects(fs.stat(f.target), { code: 'ENOENT' }) },
    migrate: async target => { events.push('migrate'); assert.equal(target, f.target); await fs.writeFile(path.join(target, 'agent/new'), 'new') } })
  assert.deepEqual(events, ['stop', 'migrate'])
  await assert.rejects(fs.stat(path.join(f.source, 'agent/new')), { code: 'ENOENT' })
  assert.equal(await fs.readFile(path.join(f.source, 'desktop-maintenance.json'), 'utf8'), '{"phase":"installing"}')
  await fs.stat(path.join(f.target, 'imported-source-state/desktop-maintenance.json'))
  await assert.rejects(fs.stat(path.join(f.target, 'desktop-maintenance.json')), { code: 'ENOENT' })
})
test('migration failure exposes its real phase and cause while preserving the source', async t => {
  const f = await fixture(t)
  await assert.rejects(importDesktopData({ source: { dataRoot: f.source }, root: f.code, target: f.target,
    stop: async () => {}, migrate: async () => { throw new Error('specific migration failure') } }),
    error => error.code === 'CRABOT_DATA_IMPORT_FAILED' && /迁移数据.*specific migration failure/.test(error.message))
  assert.equal(await fs.readFile(path.join(f.source, 'agent/history.json'), 'utf8'), '{"original":true}')
})

test('workspace paths inside copied data move while external project paths and source catalog remain unchanged', async t => {
  const f = await fixture(t), directory = path.join(f.source, 'workspace-control')
  await fs.mkdir(directory, { mode: 0o700 })
  await fs.mkdir(path.join(f.code, 'crabot-agent'))
  await fs.writeFile(path.join(f.code, 'crabot-agent/workspace-data-compat.json'), '{"schema_version":1,"workspace_data_versions":[1]}')
  const catalog = { version: 1, revision: 2, storage_root: path.join(f.source, 'workspaces'), workspaces: [
    { workspace_id: 'default', root: path.join(f.source, 'workspaces/default') },
    { workspace_id: 'external', root: path.join(f.root, 'external-project') } ] }
  await fs.writeFile(path.join(directory, 'catalog.json'), JSON.stringify(catalog), { mode: 0o600 })
  await importDesktopData({ source: { dataRoot: f.source }, root: f.code, target: f.target, stop: async () => {}, migrate: async () => {} })
  const copied = JSON.parse(await fs.readFile(path.join(f.target, 'workspace-control/catalog.json'), 'utf8'))
  assert.equal(copied.storage_root, path.join(f.target, 'workspaces'))
  assert.equal(copied.workspaces[0].root, path.join(f.target, 'workspaces/default'))
  assert.equal(copied.workspaces[1].root, catalog.workspaces[1].root)
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'catalog.json'), 'utf8')), catalog)
})

test('an unfinished source migration is retained and never rerun in a new copy', async t => {
  const f = await fixture(t), transaction = path.join(f.source, '.upgrade-migrations/task')
  await fs.mkdir(transaction, { recursive: true }); await fs.writeFile(path.join(transaction, 'state.json'), '{"phase":"running"}')
  await assert.rejects(importDesktopData({ source: { dataRoot: f.source }, root: f.code, target: f.target,
    stop: async () => {}, migrate: async () => assert.fail('Unknown migration must not execute again') }), /尚未确认完成/)
  assert.equal(await fs.readFile(path.join(transaction, 'state.json'), 'utf8'), '{"phase":"running"}')
})
