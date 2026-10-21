import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import native from '../process-identity.cjs'
import knownExit from '../known-process-exit.cjs'
import { copyWorkspaceTreePinned } from '../workspace-windows-copy.mjs'

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'crabot-win-driver-中文-')))
  const source = path.join(root, 'source'), container = path.join(root, 'stage'), tree = path.join(container, 'tree')
  fs.mkdirSync(source); native.createPrivateDirectory(container); native.createPrivateDirectory(tree)
  fs.mkdirSync(path.join(source, 'empty')); fs.writeFileSync(path.join(source, 'retained'), 'original bytes')
  const pins = [source, tree, container].map(file => native.pinDirectory(file))
  t.after(() => {
    for (const pin of pins.reverse()) native.releaseDirectoryPin(pin)
    for (const file of [path.join(source, 'retained'), path.join(tree, 'retained')]) try { fs.chmodSync(file, 0o666) } catch {}
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { source, tree, container, pins }
}

test('Windows fixed driver journals its suspended copy before one resume and syncs preserved bytes and metadata', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const f = fixture(t), file = path.join(f.source, 'retained')
  fs.writeFileSync(file + ':retained-stream', 'original stream'); fs.chmodSync(file, 0o444)
  const { inspectWorkspaceFileMetadata, verifyWorkspaceRelocationCopy } = await import('../workspace-file-metadata.mjs')
  const before = await inspectWorkspaceFileMetadata(file), rootBefore = await inspectWorkspaceFileMetadata(f.source)
  let actor
  const calls = [], journal = {
    async register(tools) {
      calls.push('register'); assert.equal(tools.length, 1); assert.equal(tools[0].role, 'copy')
      actor = tools[0].process; assert.equal(actor.parent, process.pid)
      assert.equal(knownExit.probeKnownProcessExit([actor]).state, 'running')
      assert.deepEqual(fs.readdirSync(f.tree), []); return { dispatch: 'dispatch' }
    },
    async permit() { calls.push('permit'); assert.deepEqual(fs.readdirSync(f.tree), []); return { dispatch: 'dispatch' } },
    async complete() { calls.push('complete'); assert.equal(knownExit.probeKnownProcessExit([actor]).state, 'stopped'); return { dispatch: 'dispatch' } },
  }
  await copyWorkspaceTreePinned(...f.pins, { journal })
  assert.deepEqual(calls, ['register', 'permit', 'complete'])
  assert.equal(fs.readFileSync(path.join(f.tree, 'retained'), 'utf8'), 'original bytes')
  assert.equal(fs.readFileSync(path.join(f.tree, 'retained:retained-stream'), 'utf8'), 'original stream')
  assert.deepEqual(await inspectWorkspaceFileMetadata(path.join(f.tree, 'retained')), before)
  assert.deepEqual(await inspectWorkspaceFileMetadata(f.tree), rootBefore)
  assert.deepEqual(await inspectWorkspaceFileMetadata(file), before)
  assert.ok((await verifyWorkspaceRelocationCopy(f.source, f.tree)).metadata_entries >= 3)
})

for (const mode of ['rejected', 'observe', 'cancelled']) test('Windows fixed driver never resumes after permission is ' + mode, { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  const f = fixture(t), controller = new AbortController(); let actor, completed = 0
  const journal = {
    async register(tools) { actor = tools[0].process; return { dispatch: 'dispatch' } },
    async permit() {
      assert.deepEqual(fs.readdirSync(f.tree), [])
      if (mode === 'rejected') throw new Error('original permission rejection')
      if (mode === 'cancelled') controller.abort()
      return { dispatch: mode === 'observe' ? 'observe' : 'dispatch' }
    },
    async complete() { completed++; assert.equal(knownExit.probeKnownProcessExit([actor]).state, 'stopped') },
  }
  await assert.rejects(copyWorkspaceTreePinned(...f.pins, { journal, signal: controller.signal }))
  assert.equal(completed, 1)
  assert.equal(knownExit.probeKnownProcessExit([actor]).state, 'stopped')
  assert.deepEqual(fs.readdirSync(f.tree), [])
  assert.equal(fs.readFileSync(path.join(f.source, 'retained'), 'utf8'), 'original bytes')
})

test('fixed Windows copy rejects missing authority and prior cancellation without creating an actor', async () => {
  const controller = new AbortController(); controller.abort()
  await assert.rejects(copyWorkspaceTreePinned(null, null, null), { code: 'WORKSPACE_COPY_UNVERIFIED' })
  await assert.rejects(copyWorkspaceTreePinned(null, null, null, { journal: {}, signal: controller.signal }), { code: 'WORKSPACE_COPY_UNVERIFIED' })
})
