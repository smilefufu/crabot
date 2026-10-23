import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { revealWorkspaceFolder } from '../dist/workspace-folder.js'

async function fixture(t, onRead = async () => {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-folder-中文 ')))
  const project = path.join(root, 'project'); await fs.mkdir(project)
  let reads = 0, scope
  const record = { workspace_id: 'default', kind: 'default', name: '默认工作区', description: '', root: project, source: 'managed', created_at: new Date().toISOString() }
  const item = { workspace: record, directory_status: 'ready', usage: { status: 'pending', file_count: 0, skipped_entries: 0 }, execution: { status: 'unknown' } }
  const server = createServer((req, res) => { void (async () => {
    assert.equal(req.url, '/api/workspaces/default'); assert.equal(req.headers.authorization, 'Bearer fixture-private')
    reads++; await onRead({ reads, item, root, project, setScope: value => { scope = value }, scope })
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ revision: 1, item }))
  })().catch(error => { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })) }) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  scope = { instance_id: 'a'.repeat(64), generation: randomUUID(), admin_url: `http://127.0.0.1:${server.address().port}`, connection_epoch: 1 }
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }) })
  const host = { context: () => scope && ({ ...scope }), credential: async () => scope && ({ ...scope, token: 'fixture-private' }) }
  const opened = [], open = async directory => { opened.push(directory); return '' }
  return { host, open, opened, project, get reads() { return reads } }
}

test('fixed native folder opening checks HTTP identity, actual directory and unchanged binding before opening', async t => {
  const f = await fixture(t)
  assert.equal(await revealWorkspaceFolder(f.host, 'default', f.open), true)
  assert.deepEqual(f.opened, [f.project]); assert.equal(f.reads, 2)
  assert.equal(await revealWorkspaceFolder(f.host, '/arbitrary/path', f.open), false)
  assert.equal(f.reads, 2); assert.equal(f.opened.length, 1)
})
test('a generation change or retargeted project never opens an old or unrelated directory', async t => {
  for (const mode of ['generation', 'binding', 'wrong-identity']) {
    const f = await fixture(t, async ({ reads, item, scope, setScope, root }) => {
      if (reads !== 2 && mode !== 'wrong-identity') return
      if (mode === 'generation') setScope({ ...scope, generation: randomUUID() })
      if (mode === 'binding') item.workspace.root = root
      if (mode === 'wrong-identity') item.workspace = { ...item.workspace, workspace_id: randomUUID(), kind: 'project' }
    })
    assert.equal(await revealWorkspaceFolder(f.host, 'default', f.open), false, mode)
    assert.deepEqual(f.opened, [])
  }
})
test('directory replacement, missing roots and native failure remain explicit false results', async t => {
  const linked = await fixture(t, async ({ reads, root, project }) => {
    if (reads !== 2) return
    await fs.rename(project, path.join(root, 'original'))
    await fs.symlink(path.join(root, 'original'), project, process.platform === 'win32' ? 'junction' : 'dir')
  })
  assert.equal(await revealWorkspaceFolder(linked.host, 'default', linked.open), false)
  assert.deepEqual(linked.opened, [])
  const missing = await fixture(t); await fs.rmdir(missing.project)
  assert.equal(await revealWorkspaceFolder(missing.host, 'default', missing.open), false)
  const failed = await fixture(t)
  assert.equal(await revealWorkspaceFolder(failed.host, 'default', async () => 'native open failed'), false)
  assert.equal(await revealWorkspaceFolder({ context: () => null, credential: async () => null }, 'default', failed.open), false)
})

test('a context change between asynchronous token resolution and fetch sends no stale credential', async t => {
  const f = await fixture(t), original = f.host.context
  let reads = 0
  const changed = randomUUID()
  f.host.context = () => { const scope = original(); return ++reads <= 2 ? scope : { ...scope, generation: changed } }
  assert.equal(await revealWorkspaceFolder(f.host, 'default', f.open), false)
  assert.equal(f.reads, 0)
  assert.deepEqual(f.opened, [])
})


test('native workspace directory selection returns only a current single absolute path and cancels without effects', async () => {
  const { selectWorkspaceDirectory } = await import('../dist/workspace-folder.js')
  assert.equal(typeof selectWorkspaceDirectory, 'function')
  const scope = { instance_id: 'a'.repeat(64), generation: randomUUID(), admin_url: 'http://127.0.0.1:3000', connection_epoch: 1 }
  const host = { context: () => ({ ...scope }) }, directory = path.join(tmpdir(), '中文 selected folder')
  assert.equal(await selectWorkspaceDirectory(host, async () => directory), directory)
  assert.equal(await selectWorkspaceDirectory(host, async () => null), null)
  for (const invalid of ['', 'relative/path', 'bad\0path', 'x'.repeat(32769), { path: directory }, [directory]]) {
    assert.equal(await selectWorkspaceDirectory(host, async () => invalid), null)
  }
})
test('a disconnected or changed desktop connection never delivers a stale selected directory', async () => {
  const { selectWorkspaceDirectory } = await import('../dist/workspace-folder.js')
  assert.equal(typeof selectWorkspaceDirectory, 'function')
  let scope = { instance_id: 'a'.repeat(64), generation: randomUUID(), admin_url: 'http://127.0.0.1:3000', connection_epoch: 1 }, calls = 0
  const host = { context: () => scope && ({ ...scope }) }, choose = async () => { calls++; return tmpdir() }
  scope = null
  assert.equal(await selectWorkspaceDirectory(host, choose), null); assert.equal(calls, 0)
  scope = { instance_id: 'a'.repeat(64), generation: randomUUID(), admin_url: 'http://127.0.0.1:3000', connection_epoch: 1 }
  assert.equal(await selectWorkspaceDirectory(host, async () => { scope = { ...scope, connection_epoch: 2 }; return tmpdir() }), null)
  assert.equal(await selectWorkspaceDirectory(host, async () => { throw new Error('native dialog unavailable') }), null)
})
