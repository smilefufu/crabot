import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import native from '../process-identity.cjs'

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'workspace-copy-job-中文 space &-'))), source = path.join(root, 'source'), target = path.join(root, 'target')
  fs.mkdirSync(source); native.createPrivateDirectory(target)
  fs.mkdirSync(path.join(source, 'empty')); fs.writeFileSync(path.join(source, '.hidden'), 'original bytes')
  const a = native.pinDirectory(source), b = native.pinDirectory(target), jobs = []
  t.after(() => { for (const job of jobs) native.closeWorkspaceCopyJob(job); native.releaseDirectoryPin(a); native.releaseDirectoryPin(b); fs.rmSync(root, { recursive: true, force: true }) })
  return { root, source, target, a, b, jobs }
}
const wait = async predicate => {
  const deadline = Date.now() + 10000
  while (!predicate()) { assert.ok(Date.now() < deadline, 'finite Windows copy observation'); await new Promise(resolve => setTimeout(resolve, 20)) }
}

test('Windows copy is suspended and retains private root locks before one explicit resume', { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  const f = fixture(t), file = path.join(f.source, '.hidden')
  const longRelative = path.join(...Array(12).fill('long-目录-segment'), 'preserved.txt'), longSource = path.join(f.source, longRelative)
  assert.ok(longSource.length > 260); fs.mkdirSync(path.dirname(longSource), { recursive: true }); fs.writeFileSync(longSource, 'long path bytes')
  fs.writeFileSync(file + ':Zone.Identifier', '[ZoneTransfer]\r\nZoneId=3\r\n'); fs.chmodSync(file, 0o444)
  execFileSync(path.join(process.env.SystemRoot, 'System32/attrib.exe'), ['+H', file])
  const job = native.createWorkspaceCopyJob(f.a, f.b); f.jobs.push(job)
  const before = native.inspectWorkspaceCopyJob(job)
  assert.equal(before.state, 'suspended'); assert.equal(before.exit_code, null); assert.equal(before.process.parent, process.pid)
  assert.equal(native.isProcessExited(before.process.pid), false); assert.deepEqual(fs.readdirSync(f.target), [])
  native.releaseDirectoryPin(f.a); native.releaseDirectoryPin(f.b)
  assert.throws(() => native.renameDirectoryNoReplace(f.target, path.join(f.root, 'moved')), { code: 'CRABOT_DIRECTORY_MOVE' })
  native.resumeWorkspaceCopyJob(job)
  assert.throws(() => native.resumeWorkspaceCopyJob(job), { code: 'CRABOT_WINDOWS_COPY_ACTOR' })
  await wait(() => native.inspectWorkspaceCopyJob(job).state === 'exited')
  const result = native.inspectWorkspaceCopyJob(job)
  assert.ok(result.exit_code >= 0 && result.exit_code <= 7, JSON.stringify(result)); assert.deepEqual(result.process, before.process)
  assert.equal(fs.readFileSync(path.join(f.target, '.hidden'), 'utf8'), 'original bytes')
  assert.equal(fs.readFileSync(path.join(f.target, longRelative), 'utf8'), 'long path bytes')
  assert.equal(fs.readFileSync(path.join(f.target, '.hidden:Zone.Identifier'), 'utf8'), '[ZoneTransfer]\r\nZoneId=3\r\n')
  assert.equal(fs.statSync(path.join(f.target, '.hidden')).mode & 0o200, 0)
  assert.deepEqual(fs.readdirSync(path.join(f.target, 'empty')), []); assert.equal(fs.readFileSync(file, 'utf8'), 'original bytes')
  const sourceAgain = native.pinDirectory(f.source), targetAgain = native.pinDirectory(f.target)
  try { native.copyPinnedDirectoryMetadata(sourceAgain, targetAgain) } finally { native.releaseDirectoryPin(sourceAgain); native.releaseDirectoryPin(targetAgain) }
  assert.deepEqual(native.inspectFileMetadata(path.join(f.target, '.hidden')).metadata, native.inspectFileMetadata(file).metadata)
  native.closeWorkspaceCopyJob(job); native.closeWorkspaceCopyJob(job)
  assert.throws(() => native.inspectWorkspaceCopyJob(job), { code: 'CRABOT_WINDOWS_COPY_ACTOR' })
  fs.renameSync(f.target, path.join(f.root, 'released-target'))
})

test('Windows close terminates only its original suspended process and permits idempotent release', { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
  const f = fixture(t), job = native.createWorkspaceCopyJob(f.a, f.b); f.jobs.push(job)
  const actor = native.inspectWorkspaceCopyJob(job).process
  native.closeWorkspaceCopyJob(job)
  await wait(() => native.isProcessExited(actor.pid))
  assert.deepEqual(fs.readdirSync(f.target), []); assert.equal(fs.readFileSync(path.join(f.source, '.hidden'), 'utf8'), 'original bytes')
  for (const value of [null, {}, f.a]) {
    assert.throws(() => native.resumeWorkspaceCopyJob(value), { code: 'CRABOT_WINDOWS_COPY_ACTOR' })
    assert.throws(() => native.closeWorkspaceCopyJob(value), { code: 'CRABOT_WINDOWS_COPY_ACTOR' })
  }
})

test('Windows does not resume when new content appears in the initially empty private staging root', { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
  const f = fixture(t), job = native.createWorkspaceCopyJob(f.a, f.b); f.jobs.push(job)
  fs.writeFileSync(path.join(f.target, 'keep'), 'new user content')
  assert.throws(() => native.resumeWorkspaceCopyJob(job), { code: 'CRABOT_WINDOWS_COPY_ACTOR' })
  assert.equal(native.inspectWorkspaceCopyJob(job).state, 'suspended')
  assert.equal(fs.readFileSync(path.join(f.target, 'keep'), 'utf8'), 'new user content'); assert.equal(fs.existsSync(path.join(f.target, '.hidden')), false)
})

test('Windows rejects forged, released, overlapping and nonempty targets before creating a copy process', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t), before = native.listChildProcessIds(process.pid)
  for (const args of [[null, f.b], [f.a, {}], [f.a, f.a], [f.a, f.b, 'extra']]) assert.throws(() => native.createWorkspaceCopyJob(...args), { code: 'CRABOT_WINDOWS_COPY_ACTOR' })
  const nested = path.join(f.source, 'nested-target'); native.createPrivateDirectory(nested)
  const nestedPin = native.pinDirectory(nested)
  try { assert.throws(() => native.createWorkspaceCopyJob(f.a, nestedPin), { code: 'CRABOT_WINDOWS_COPY_ACTOR' }) } finally { native.releaseDirectoryPin(nestedPin) }
  fs.writeFileSync(path.join(f.target, 'keep'), 'user bytes')
  assert.throws(() => native.createWorkspaceCopyJob(f.a, f.b), { code: 'CRABOT_WINDOWS_COPY_ACTOR' })
  native.releaseDirectoryPin(f.b)
  assert.throws(() => native.createWorkspaceCopyJob(f.a, f.b), { code: 'CRABOT_WINDOWS_COPY_ACTOR' })
  assert.deepEqual(native.listChildProcessIds(process.pid), before); assert.equal(fs.readFileSync(path.join(f.target, 'keep'), 'utf8'), 'user bytes')
})

test('Windows kills its suspended copy on unexpected host exit without needing a later PID-based cleanup', { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  const f = fixture(t), module = new URL('../process-identity.cjs', import.meta.url).href
  const code = `import native from ${JSON.stringify(module)};const source=native.pinDirectory(${JSON.stringify(f.source)}),target=native.pinDirectory(${JSON.stringify(f.target)});const job=native.createWorkspaceCopyJob(source,target);process.send(native.inspectWorkspaceCopyJob(job).process);setTimeout(()=>native.closeWorkspaceCopyJob(job),30000);`
  const host = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }), exited = once(host, 'exit')
  let stderr = ''; host.stderr.on('data', bytes => { stderr += bytes })
  t.after(async () => { if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL'); await exited })
  const [actor] = await Promise.race([once(host, 'message'), exited.then(() => { throw new Error('Windows job fixture exited before ready: ' + stderr) })])
  assert.equal(actor.parent, host.pid); assert.equal(native.isProcessExited(actor.pid), false)
  host.kill('SIGKILL'); await exited
  await wait(() => native.isProcessExited(actor.pid))
  assert.deepEqual(fs.readdirSync(f.target), [], stderr); assert.equal(fs.readFileSync(path.join(f.source, '.hidden'), 'utf8'), 'original bytes')
})
