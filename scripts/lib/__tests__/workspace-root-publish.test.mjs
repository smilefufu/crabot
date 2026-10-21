import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import native from '../process-identity.cjs'
import { publishWorkspaceRoot } from '../workspace-root-publish.mjs'

const identity = file => { const stat = fs.lstatSync(file, { bigint: true }); return { path: file, dev: stat.dev.toString(), ino: stat.ino.toString(), native_id: process.platform === 'win32' ? native.inspectDirectoryFileId(file) : null } }
function fixture(t, empty = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'workspace-publish-中文 space-'))), id = randomUUID()
  const container = path.join(root, '.crabot-workspace-' + id), tree = path.join(container, 'tree'), target = path.join(root, 'new'), hold = path.join(root, '.crabot-workspace-empty-' + id)
  if (process.platform === 'win32') native.createPrivateDirectory(container)
  else fs.mkdirSync(container, { mode: 0o700 })
  fs.mkdirSync(tree); fs.writeFileSync(path.join(tree, '.hidden'), 'original work')
  if (empty) fs.mkdirSync(target)
  const plan = { intent_id: id, container: identity(container), tree: identity(tree), target, target_parent: identity(root), empty_target: empty ? identity(target) : null }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, plan, container, tree, target, hold }
}
for (const empty of [false, true]) test('publishes the exact original tree without overwriting and repeats only observation: empty=' + empty, async t => {
  const f = fixture(t, empty), result = await publishWorkspaceRoot({ plan: f.plan, verify: async () => {} })
  assert.equal(result.dispatch, 'dispatch'); assert.equal(result.target.ino, f.plan.tree.ino)
  assert.equal(fs.existsSync(f.tree), false); assert.equal(fs.readFileSync(path.join(f.target, '.hidden'), 'utf8'), 'original work')
  assert.deepEqual(fs.readdirSync(f.container), [])
  if (empty) { assert.equal(identity(f.hold).ino, f.plan.empty_target.ino); assert.deepEqual(fs.readdirSync(f.hold), []) }
  else assert.equal(fs.existsSync(f.hold), false)
  const before = fs.statSync(f.target, { bigint: true })
  assert.equal((await publishWorkspaceRoot({ plan: f.plan, verify: async () => {} })).dispatch, 'observe')
  const after = fs.statSync(f.target, { bigint: true }); assert.equal(after.ino, before.ino); assert.equal(after.ctimeNs, before.ctimeNs)
})

test('a lost acknowledgement after preserving the old empty target resumes with the same two original directories', async t => {
  const f = fixture(t, true)
  await assert.rejects(publishWorkspaceRoot({ plan: f.plan, verify: async () => { if (fs.existsSync(f.hold)) throw new Error('confirmation lost') } }))
  assert.equal(fs.readFileSync(path.join(f.tree, '.hidden'), 'utf8'), 'original work'); assert.equal(identity(f.hold).ino, f.plan.empty_target.ino)
  assert.equal(fs.existsSync(f.target), false)
  assert.equal((await publishWorkspaceRoot({ plan: f.plan, verify: async () => {} })).dispatch, 'dispatch')
  assert.equal(identity(f.target).ino, f.plan.tree.ino); assert.equal(identity(f.hold).ino, f.plan.empty_target.ino)
})
for (const empty of [false, true]) test('a lost final acknowledgement never repeats a directory move: empty=' + empty, async t => {
  const f = fixture(t, empty)
  await assert.rejects(publishWorkspaceRoot({ plan: f.plan, verify: async () => { if (!fs.existsSync(f.tree)) throw new Error('final confirmation lost') } }))
  assert.equal(identity(f.target).ino, f.plan.tree.ino)
  assert.equal((await publishWorkspaceRoot({ plan: f.plan, verify: async () => {} })).dispatch, 'observe')
})
for (const change of ['unknown empty target', 'new target file during verification', 'source replaced', 'missing source', 'unknown hold', 'container replaced', 'parent binding', 'old empty target gained file']) test('unknown/replaced evidence never overwrites user files: ' + change, async t => {
  const f = fixture(t, change === 'old empty target gained file'), original = structuredClone(f.plan)
  let calls = 0
  if (change === 'unknown empty target') fs.mkdirSync(f.target)
  if (change === 'source replaced') { fs.renameSync(f.tree, path.join(f.root, 'original-kept')); fs.mkdirSync(f.tree) }
  if (change === 'missing source') fs.renameSync(f.tree, path.join(f.root, 'original-kept'))
  if (change === 'unknown hold') fs.mkdirSync(f.hold)
  if (change === 'container replaced') { fs.renameSync(f.container, path.join(f.root, 'original-kept')); fs.mkdirSync(f.container) }
  if (change === 'parent binding') original.target_parent.ino = '999999999999'
  await assert.rejects(publishWorkspaceRoot({ plan: original, verify: async () => {
    if (++calls === 2 && change === 'new target file during verification') { fs.mkdirSync(f.target); fs.writeFileSync(path.join(f.target, 'new-work'), 'preserve') }
    if (calls === 2 && change === 'old empty target gained file') fs.writeFileSync(path.join(f.target, 'new-work'), 'preserve')
  } }))
  if (fs.existsSync(path.join(f.target, 'new-work'))) assert.equal(fs.readFileSync(path.join(f.target, 'new-work'), 'utf8'), 'preserve')
  const locations = [f.tree, path.join(f.root, 'original-kept'), path.join(f.root, 'original-kept/tree')]
  assert.ok(locations.some(directory => fs.existsSync(path.join(directory, '.hidden'))))
})

test('new files in the preserved old target stop publication and are never cleared', async t => {
  const f = fixture(t, true)
  await assert.rejects(publishWorkspaceRoot({ plan: f.plan, verify: async () => { if (fs.existsSync(f.hold)) { fs.writeFileSync(path.join(f.hold, 'new-work'), 'preserve'); throw new Error('unknown old target contents') } } }))
  await assert.rejects(publishWorkspaceRoot({ plan: f.plan, verify: async () => {} }))
  assert.equal(fs.readFileSync(path.join(f.hold, 'new-work'), 'utf8'), 'preserve'); assert.equal(fs.readFileSync(path.join(f.tree, '.hidden'), 'utf8'), 'original work')
})

test('known final target without the required original empty target is not accepted as completed', async t => {
  const f = fixture(t, true); await publishWorkspaceRoot({ plan: f.plan, verify: async () => {} }); fs.renameSync(f.hold, path.join(f.root, 'kept-empty'))
  await assert.rejects(publishWorkspaceRoot({ plan: f.plan, verify: async () => {} }))
  assert.equal(fs.readFileSync(path.join(f.target, '.hidden'), 'utf8'), 'original work')
})

test('failure of the original verifier has no directory effects', async t => {
  const f = fixture(t, true)
  await assert.rejects(publishWorkspaceRoot({ plan: f.plan, verify: async () => { throw new Error('original role unavailable') } }))
  assert.equal(fs.readFileSync(path.join(f.tree, '.hidden'), 'utf8'), 'original work'); assert.equal(fs.existsSync(f.hold), false)
})

test('caller mutation during the first await cannot change fixed locations', async t => {
  const f = fixture(t), originalTarget = f.target
  const result = await publishWorkspaceRoot({ plan: f.plan, verify: async () => { f.plan.target = path.join(f.root, 'unselected') } })
  assert.equal(result.target.path, originalTarget); assert.equal(fs.existsSync(path.join(f.root, 'unselected')), false)
})


test('unexpected container entries are retained and block publication', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.container, 'unrelated'), 'preserve')
  await assert.rejects(publishWorkspaceRoot({ plan: f.plan, verify: async () => {} }))
  assert.equal(fs.readFileSync(path.join(f.container, 'unrelated'), 'utf8'), 'preserve')
  assert.equal(fs.readFileSync(path.join(f.tree, '.hidden'), 'utf8'), 'original work'); assert.equal(fs.existsSync(f.target), false)
})
for (const field of ['dev', 'ino']) test('technical identity rejects non-string ' + field + ' before invoking the original verifier', async t => {
  const f = fixture(t); f.plan.tree[field] = Number(f.plan.tree[field]); let calls = 0
  await assert.rejects(publishWorkspaceRoot({ plan: f.plan, verify: async () => { calls++ } }))
  assert.equal(calls, 0); assert.equal(fs.readFileSync(path.join(f.tree, '.hidden'), 'utf8'), 'original work')
})
for (const which of ['source', 'target']) test('directory links do not redirect the fixed root effect: ' + which, async t => {
  const f = fixture(t), outside = path.join(f.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'kept'), 'external work')
  if (which === 'source') fs.renameSync(f.tree, path.join(f.root, 'source-kept'))
  fs.symlinkSync(outside, which === 'source' ? f.tree : f.target, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(publishWorkspaceRoot({ plan: f.plan, verify: async () => {} }))
  assert.equal(fs.readFileSync(path.join(outside, 'kept'), 'utf8'), 'external work')
})

test('cancellation between the two moves preserves both original objects', async t => {
  const f = fixture(t, true), controller = new AbortController()
  await assert.rejects(publishWorkspaceRoot({ plan: f.plan, signal: controller.signal, verify: async () => { if (fs.existsSync(f.hold)) controller.abort() } }))
  assert.equal(fs.existsSync(f.target), false); assert.equal(identity(f.hold).ino, f.plan.empty_target.ino)
  assert.equal(fs.readFileSync(path.join(f.tree, '.hidden'), 'utf8'), 'original work')
})
