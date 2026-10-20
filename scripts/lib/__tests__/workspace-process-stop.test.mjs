import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import native from '../process-identity.cjs'
import management from '../desktop-management.cjs'
import { acquireCliLock, releaseCliLock } from '../cli-lock.mjs'
import { WorkspaceCatalog } from '../../../crabot-shared/dist/workspace-catalog.js'
import * as records from '../workspace-relocation-intent.mjs'

async function fixture(t, populated = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'workspace-process-stop-')))
  const data = management.ensurePrivateDataRoot(path.join(root, 'data')), id = randomUUID()
  const catalog = new WorkspaceCatalog({ dataRoot: data, files: native }); await catalog.initialize()
  const before = await catalog.snapshot(), lock = await acquireCliLock(data, 'workspace-relocation')
  let child, ended, processes = []; const descendants = []
  t.after(async () => {
    if (child) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await ended
    }
    for (const item of descendants) native.terminateKnownProcess(item)
    releaseCliLock(lock); fs.rmSync(root, { recursive: true, force: true })
  })
  if (populated) {
    child = spawn(process.execPath, ['-e', `process.send('ready');process.on('message',()=>{const child=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},20000)'],{detached:true,stdio:'ignore'});child.unref();process.send(child.pid)});setTimeout(()=>{},20000)`], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    ended = once(child, 'exit'); await once(child, 'message')
    processes = [native.inspectProcess(child.pid)]
  }
  await records.beginWorkspaceRelocationIntent({ dataDir: data, id, target: path.join(root, 'new'), expectedRevision: before.revision, protectedRoots: [] })
  records.commitWorkspaceRelocationWorkers({ dataDir: data, id, workers: [] })
  records.commitWorkspaceRelocationProcesses({ dataDir: data, id, processes })
  records.commitWorkspaceRelocationModules({ dataDir: data, id, modules: [] })
  const file = path.join(data, 'workspace-control/relocation-process-stop.jsonl')
  return { root, data, id, lock, child, ended, processes, file, catalog, before,
    addDescendant: async () => { const ready = once(child, 'message'); child.send('spawn'); const [pid] = await ready; const item = native.inspectProcess(pid); descendants.push(item); return item },
    prepare: () => records.prepareWorkspaceRelocationProcessStops({ dataDir: data, id }),
    observe: value => records.observeWorkspaceRelocationProcesses({ dataDir: data, id, processes: value }),
    complete: () => records.completeWorkspaceRelocationProcessStops({ dataDir: data, id }) }
}

test('a process-stop attempt requires the original lock and never repeats its first dispatch', async t => {
  const f = await fixture(t)
  assert.equal(f.prepare().dispatch, 'dispatch')
  const before = fs.readFileSync(f.file)
  assert.equal(f.prepare().dispatch, 'observe'); assert.deepEqual(fs.readFileSync(f.file), before)
  assert.equal(records.readWorkspaceRelocationStops(f.data, f.id).attempt, null)
  assert.equal(records.readWorkspaceRelocationModuleStops(f.data, f.id).attempt, null)
  releaseCliLock(f.lock)
  assert.throws(f.prepare, { code: 'WORKSPACE_RELOCATION_INVALID' })
  assert.deepEqual(await f.catalog.snapshot(), f.before)
})

test('known-scope completion cannot claim a live process is stopped and preserves the first observation', async t => {
  const f = await fixture(t); f.prepare()
  f.observe(f.processes)
  assert.throws(f.complete, { code: 'WORKSPACE_RELOCATION_INVALID' })
  const before = fs.readFileSync(f.file)
  f.observe(f.processes); assert.deepEqual(fs.readFileSync(f.file), before)
  f.child.kill('SIGKILL'); await f.ended
  const completion = f.complete()
  assert.equal(completion.type, 'known_scope_exited')
  assert.deepEqual(f.complete(), completion)
  const result = records.readWorkspaceRelocationProcessStops(f.data, f.id)
  assert.deepEqual(result.observations.at(-1).processes, f.processes)
  assert.deepEqual(result.completion, completion)
  assert.equal(fs.existsSync(path.join(f.root, 'new')), false)
})

test('an empty CLI scope still needs an explicit observation and grants no module or file permission', async t => {
  const f = await fixture(t, false); f.prepare()
  assert.throws(f.complete, { code: 'WORKSPACE_RELOCATION_INVALID' })
  f.observe([]); f.complete()
  assert.equal(records.readWorkspaceRelocationModuleStops(f.data, f.id).submission, null)
  assert.deepEqual(await f.catalog.snapshot(), f.before)
})

test('observations cannot drop or replace an original process identity', async t => {
  const f = await fixture(t); f.prepare(); f.observe(f.processes)
  const before = fs.readFileSync(f.file)
  for (const processes of [[], [{ ...f.processes[0], started: 'different' }], [{ ...f.processes[0], executable: 'replacement' }]]) {
    assert.throws(() => f.observe(processes), { code: 'WORKSPACE_RELOCATION_INVALID' })
    assert.deepEqual(fs.readFileSync(f.file), before)
  }
})

for (const damage of ['truncated', 'hash', 'extra', 'hardlink', 'wrong-scope']) test('damaged process-stop evidence is never reconstructed: ' + damage, async t => {
  const f = await fixture(t); f.prepare(); f.observe(f.processes)
  if (damage === 'hardlink') fs.linkSync(f.file, path.join(f.root, 'second-link'))
  else if (damage === 'truncated') fs.appendFileSync(f.file, '{"type":')
  else {
    const lines = fs.readFileSync(f.file, 'utf8').trimEnd().split('\n').map(JSON.parse)
    if (damage === 'hash') lines[1].previous_sha256 = '0'.repeat(64)
    if (damage === 'extra') lines[1].command = 'must reject'
    if (damage === 'wrong-scope') lines[0].processes_sha256 = '0'.repeat(64)
    fs.writeFileSync(f.file, lines.map(JSON.stringify).join('\n') + '\n')
  }
  const before = fs.readFileSync(f.file)
  assert.throws(() => records.readWorkspaceRelocationProcessStops(f.data, f.id), { code: 'WORKSPACE_RELOCATION_INVALID' })
  assert.throws(f.prepare, { code: 'WORKSPACE_RELOCATION_INVALID' })
  assert.throws(f.complete, { code: 'WORKSPACE_RELOCATION_INVALID' })
  assert.deepEqual(fs.readFileSync(f.file), before)
})

test('a new process-stop attempt cannot start after Worker stop dispatch was already prepared', async t => {
  const f = await fixture(t)
  records.prepareWorkspaceRelocationStops({ dataDir: f.data, id: f.id, workers: [] })
  assert.throws(f.prepare, { code: 'WORKSPACE_RELOCATION_INVALID' })
  assert.equal(fs.existsSync(f.file), false)
})


test('the cumulative journal keeps a detached descendant after the original parent exits', async t => {
  const f = await fixture(t); f.prepare(); f.observe(f.processes)
  const descendant = await f.addDescendant(), processes = [...f.processes, descendant].sort((a, b) => a.pid - b.pid)
  f.observe(processes)
  f.child.kill('SIGKILL'); await f.ended
  assert.throws(f.complete, { code: 'WORKSPACE_RELOCATION_INVALID' })
  native.terminateKnownProcess(descendant)
  const deadline = Date.now() + 5000
  while (!native.isProcessExited(descendant.pid)) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10)) }
  f.complete()
  assert.deepEqual(records.readWorkspaceRelocationProcessStops(f.data, f.id).observations.at(-1).processes, processes)
})

test('unknown Native observation cannot append an exited completion', async t => {
  const f = await fixture(t); f.prepare(); f.observe(f.processes)
  f.child.kill('SIGKILL'); await f.ended
  const inspect = native.inspectProcess, exited = native.isProcessExited
  const readMock = t.mock.method(native, 'inspectProcess', pid => pid === f.child.pid ? null : inspect(pid))
  const exitMock = t.mock.method(native, 'isProcessExited', pid => pid === f.child.pid ? false : exited(pid))
  const before = fs.readFileSync(f.file)
  try { assert.throws(f.complete, { code: 'WORKSPACE_RELOCATION_INVALID' }); assert.deepEqual(fs.readFileSync(f.file), before) }
  finally { readMock.mock.restore(); exitMock.mock.restore() }
})

test('a partially written observation is retained and never truncated to resume dispatch', async t => {
  const f = await fixture(t); f.prepare()
  const write = fs.writeSync
  const writeMock = t.mock.method(fs, 'writeSync', (fd, bytes, offset, length) => {
    write(fd, bytes, offset, Math.min(length, 9)); throw Object.assign(new Error('finite write failure'), { code: 'EIO' })
  })
  try { assert.throws(() => f.observe(f.processes), { code: 'EIO' }) } finally { writeMock.mock.restore() }
  const retained = fs.readFileSync(f.file)
  assert.throws(f.prepare, { code: 'WORKSPACE_RELOCATION_INVALID' })
  assert.throws(f.complete, { code: 'WORKSPACE_RELOCATION_INVALID' })
  assert.deepEqual(fs.readFileSync(f.file), retained)
  assert.equal(native.isProcessExited(f.child.pid), false)
})


test('an acknowledgement retry syncs the original append after an earlier file-sync failure', async t => {
  const f = await fixture(t); f.prepare()
  const sync = fs.fsyncSync, inode = fs.lstatSync(f.file, { bigint: true }).ino
  const failed = t.mock.method(fs, 'fsyncSync', fd => {
    if (fs.fstatSync(fd, { bigint: true }).ino === inode) throw Object.assign(new Error('finite sync failure'), { code: 'EIO' })
    return sync(fd)
  })
  try { assert.throws(() => f.observe(f.processes), { code: 'EIO' }) } finally { failed.mock.restore() }
  const before = fs.readFileSync(f.file); let synced = 0
  const observed = t.mock.method(fs, 'fsyncSync', fd => { if (fs.fstatSync(fd, { bigint: true }).ino === inode) synced++; return sync(fd) })
  try { f.observe(f.processes); assert.ok(synced > 0); assert.deepEqual(fs.readFileSync(f.file), before) }
  finally { observed.mock.restore() }
})


for (const file of ['relocation-workers.json', 'relocation-worker-processes.json', 'relocation-modules.json']) test('missing original material cannot recapture around a process-stop journal: ' + file, async t => {
  const f = await fixture(t); f.prepare(); f.observe(f.processes)
  fs.unlinkSync(path.join(f.data, 'workspace-control', file))
  const before = fs.readFileSync(f.file)
  assert.throws(f.prepare, { code: 'WORKSPACE_RELOCATION_INVALID' })
  if (file === 'relocation-workers.json') assert.throws(() => records.commitWorkspaceRelocationWorkers({ dataDir: f.data, id: f.id, workers: [] }), { code: 'WORKSPACE_RELOCATION_INVALID' })
  if (file === 'relocation-worker-processes.json') assert.throws(() => records.commitWorkspaceRelocationProcesses({ dataDir: f.data, id: f.id, processes: f.processes }), { code: 'WORKSPACE_RELOCATION_INVALID' })
  if (file === 'relocation-modules.json') assert.throws(() => records.commitWorkspaceRelocationModules({ dataDir: f.data, id: f.id, modules: [] }), { code: 'WORKSPACE_RELOCATION_INVALID' })
  assert.deepEqual(fs.readFileSync(f.file), before)
})
