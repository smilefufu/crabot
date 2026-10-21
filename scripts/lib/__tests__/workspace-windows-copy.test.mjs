import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import vm from 'node:vm'
import native from '../process-identity.cjs'
import knownExit from '../known-process-exit.cjs'
import { copyWorkspaceTreePinned } from '../workspace-windows-copy.mjs'

function fixture(t, { privateSource = false } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'crabot-win-driver-中文-')))
  const source = path.join(root, 'source'), container = path.join(root, 'stage'), tree = path.join(container, 'tree')
  if (privateSource) native.createPrivateDirectory(source)
  else fs.mkdirSync(source)
  native.createPrivateDirectory(container); native.createPrivateDirectory(tree)
  fs.mkdirSync(path.join(source, 'empty')); fs.writeFileSync(path.join(source, 'retained'), 'original bytes')
  const pins = [source, tree, container].map(file => native.pinDirectory(file))
  t.after(() => {
    for (const pin of pins.reverse()) native.releaseDirectoryPin(pin)
    for (const file of [path.join(source, 'retained'), path.join(tree, 'retained')]) try { fs.chmodSync(file, 0o666) } catch {}
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { source, tree, container, pins }
}

for (const privateSource of [false, true]) test('Windows fixed driver journals one copy and preserves exact metadata (private source=' + privateSource + ')', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const f = fixture(t, { privateSource }), file = path.join(f.source, 'retained')
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


test('workspace metadata bridge retains both original opaque pins even with non-enumerable Native methods', () => {
  const source = {}, target = {}, calls = [], backend = {}, module = { exports: {} }
  Object.defineProperty(backend, 'copyPinnedWorkspaceMetadata', { value(...pins) { calls.push(pins) } })
  vm.runInNewContext(fs.readFileSync(new URL('../process-identity.cjs', import.meta.url), 'utf8'), {
    module, process: { platform: 'win32' }, require: name => name === 'node:path' ? path.win32 : name === 'node:fs' ? fs : backend,
  })
  module.exports.copyPinnedWorkspaceMetadata(source, target)
  assert.deepEqual(calls, [[source, target]])
})

for (const side of ['source', 'target']) test('Windows metadata restoration rejects a ' + side + ' junction without touching outside files and releases handles', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t), outside = path.join(f.source, '..', 'outside'), sentinel = path.join(outside, 'sentinel')
  fs.mkdirSync(outside); fs.writeFileSync(sentinel, 'outside retained')
  fs.mkdirSync(path.join(f.tree, 'empty')); fs.writeFileSync(path.join(f.tree, 'retained'), 'original bytes')
  for (const [name, root] of [['source', f.source], ['target', f.tree]]) {
    if (name === side) fs.symlinkSync(outside, path.join(root, 'junction'), 'junction')
    else fs.mkdirSync(path.join(root, 'junction'))
  }
  const before = native.inspectFileMetadata(sentinel).metadata
  assert.throws(() => native.copyPinnedWorkspaceMetadata(f.pins[0], f.pins[1]), { code: 'CRABOT_WORKSPACE_METADATA' })
  assert.deepEqual(native.inspectFileMetadata(sentinel).metadata, before)
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside retained')
  for (const pin of f.pins) native.releaseDirectoryPin(pin)
  fs.renameSync(f.tree, f.tree + '-released'); fs.renameSync(f.tree + '-released', f.tree)
})

test('Windows metadata restoration rejects forged, overlapping and closed pins before tree writes', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t)
  for (const pins of [[null, f.pins[1]], [f.pins[0], {}], [f.pins[0], f.pins[0]]]) {
    assert.throws(() => native.copyPinnedWorkspaceMetadata(...pins), { code: 'CRABOT_WORKSPACE_METADATA' })
  }
  native.releaseDirectoryPin(f.pins[1])
  assert.throws(() => native.copyPinnedWorkspaceMetadata(f.pins[0], f.pins[1]), { code: 'CRABOT_WORKSPACE_METADATA' })
  assert.deepEqual(fs.readdirSync(f.tree), [])
  assert.equal(fs.readFileSync(path.join(f.source, 'retained'), 'utf8'), 'original bytes')
})
