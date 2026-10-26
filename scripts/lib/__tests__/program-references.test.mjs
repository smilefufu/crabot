import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import native from '../process-identity.cjs'
import { buildReferenceHolder } from './fixtures/program-reference-build.mjs'

for (const mode of ['open', 'closed', 'near-prefix']) test('native reference query observes only related finite processes without changing them: ' + mode, { timeout: 30000 }, async t => {
  assert.equal(typeof native.inspectProgramReferences, 'function')
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-reference-中文 ')))
  let child, exited
  t.after(async () => { if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await exited }; await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
  const root = path.join(temporary, 'program'), other = root + '-other'
  await fs.mkdir(root); await fs.mkdir(other)
  const file = path.join(root, 'bytes.txt'), outside = path.join(other, 'bytes.txt')
  await fs.writeFile(file, 'original program bytes'); await fs.writeFile(outside, 'unrelated bytes')
  child = spawn(process.execPath, ['-e', 'const fs=require("node:fs");const fd=fs.openSync(process.argv[1],"r");if(process.argv[2]==="closed")fs.closeSync(fd);process.send("ready");process.on("message",()=>process.exit(0));', mode === 'near-prefix' ? outside : file, mode], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  exited = once(child, 'exit')
  await once(child, 'message'); const original = native.inspectProcess(child.pid)
  const input = { roots: [root], files: [file] }
  const result = await native.inspectProgramReferences(input)
  assert.equal(typeof result.incomplete, 'boolean')
  assert.equal(result.complete, !result.incomplete && result.unknown_pids.length === 0)
  assert.equal(Object.values(result.unknown_stages).reduce((sum, count) => sum + count, 0), result.unknown_pids.length)
  assert.deepEqual(result.unknown_details.map(item => item.pid).sort((a, b) => a - b), result.unknown_pids)
  assert.ok(result.unknown_details.every(item => /^[a-z_]+$/.test(item.stage) && Number.isInteger(item.os_error)))
  assert.equal(typeof result.complete, 'boolean'); assert.ok(Array.isArray(result.unknown_pids)); assert.ok(Array.isArray(result.processes))
  const holder = result.processes.find(value => value.pid === child.pid)
  if (mode === 'open') { assert.ok(holder, JSON.stringify(result)); assert.equal(native.sameProcess(holder, original), true) }
  else assert.equal(holder, undefined)
  assert.equal(native.sameProcess(original, native.inspectProcess(child.pid)), true)
  assert.equal(await fs.readFile(file, 'utf8'), 'original program bytes'); assert.equal(await fs.readFile(outside, 'utf8'), 'unrelated bytes')
  child.send('exit'); await exited
  const after = await native.inspectProgramReferences(input)
  assert.equal(after.processes.some(value => value.pid === child.pid), false)
})

test('native reference query rejects unbounded or malformed inputs without a process action', () => {
  assert.equal(typeof native.inspectProgramReferences, 'function')
  for (const input of [null, {}, { roots: [], files: [], extra: true }, { roots: ['relative'], files: [] }, { roots: [path.resolve(tmpdir(), 'x') + '/..'], files: [] }, { roots: [], files: ['bad\0path'] }, { roots: Array(9).fill('/tmp/test'), files: [] }, { roots: [], files: Array(100001).fill('/tmp/test') }]) {
    assert.throws(() => native.inspectProgramReferences(input))
  }
})

let holder, holderDirectory
async function referenceHolder() {
  if (!holder) {
    holderDirectory = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-reference-compiler-')))
    holder = buildReferenceHolder(holderDirectory)
  }
  return holder
}
after(async () => { if (holderDirectory) await fs.rm(holderDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
for (const mode of ['mapped', 'cwd', 'fileport', 'library', 'protected']) test('actual native reference actor: ' + mode, {
  skip: mode === 'fileport' ? process.platform !== 'darwin' : mode === 'library' ? process.platform !== 'win32' : mode === 'protected' ? process.platform !== 'linux' : process.platform === 'win32', timeout: 90000,
}, async t => {
  const actor = await referenceHolder(), temporary = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-reference-actor-')))
  let child, exited
  t.after(async () => { if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await exited }; await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
  const file = path.join(temporary, mode === 'library' ? 'reference.dll' : 'program.txt')
  if (mode === 'library') await fs.copyFile(actor.library, file)
  else await fs.writeFile(file, Buffer.alloc(4096, 120))
  const originalBytes = await fs.readFile(file)
  child = spawn(actor.executable, [mode === 'cwd' ? temporary : file, mode], { stdio: ['pipe', 'pipe', 'inherit'] })
  exited = once(child, 'exit')
  const ready = await Promise.race([once(child.stdout, 'data').then(([bytes]) => bytes.toString().trim()), exited.then(([code]) => { throw new Error('Finite actor failed: ' + code) })]); assert.equal(ready, 'ready')
  const result = await native.inspectProgramReferences({ roots: [temporary], files: [file] })
  if (mode === 'protected') { assert.equal(result.complete, false); assert.ok(result.unknown_pids.includes(child.pid)) }
  else assert.ok(result.processes.some(value => value.pid === child.pid), JSON.stringify(result))
  assert.equal(child.exitCode, null); assert.equal(child.signalCode, null); assert.deepEqual(await fs.readFile(file), originalBytes)
  child.stdin.end('x'); assert.equal((await exited)[0], 0)
  const after = await native.inspectProgramReferences({ roots: [temporary], files: [file] })
  assert.equal(after.processes.some(value => value.pid === child.pid), false)
})

test('native reference observation queries newly listed processes instead of requiring a static desktop', { skip: process.platform === 'win32', timeout: 30000 }, async t => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-reference-churn-')))
  const children = [], create = () => {
    if (children.length >= 48) return
    const related = children.length % 2 === 0
    const child = spawn('/bin/sleep', ['3'], { cwd: related ? temporary : tmpdir(), stdio: 'ignore' })
    children.push({ child, related, end: once(child, 'exit') })
  }
  let timer
  t.after(async () => {
    clearInterval(timer)
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill()
    await Promise.all(children.map(value => value.end))
    await fs.rm(temporary, { recursive: true, force: true })
  })
  create(); timer = setInterval(create, 50)
  const result = await native.inspectProgramReferences({ roots: [temporary], files: [] })
  clearInterval(timer)
  const ours = new Map(children.map(value => [value.child.pid, value.related]))
  const unqueried = result.unknown_details.filter(value => ours.has(value.pid) && value.stage === 'process_list_changed')
  assert.equal(unqueried.length, 0, 'Newly listed owned processes must actually be queried: ' + JSON.stringify(unqueried))
  assert.ok(result.processes.some(value => ours.get(value.pid) === true), 'Actual CWD holders remain reported')
  assert.ok(result.processes.every(value => !ours.has(value.pid) || ours.get(value.pid)), 'Unrelated actors are not file holders')
})

test('macOS fileport observation handles inactive IPC spaces while retaining actual CWD holders', { skip: process.platform !== 'darwin', timeout: 30000 }, async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-reference-exec-')))
  const child = spawn('/bin/bash', ["-c", "for ((i=0;i<100;i++)); do /bin/sh -c 'echo $$; exec /bin/sleep 0.05'; done"], { cwd: directory, stdio: ['ignore', 'pipe', 'inherit'] })
  const ended = once(child, 'exit')
  t.after(async () => { await ended; await fs.rm(directory, { recursive: true, force: true }) })
  await once(child.stdout, 'data')
  let observed = false
  for (let pass = 0; pass < 3; pass++) {
    const receipt = await native.inspectProgramReferences({ roots: [directory], files: [] })
    const unknowns = receipt.unknown_details.filter(item => item.stage === 'fileport_list' && item.os_error === 3
      || item.stage === 'mappings' && item.os_error === 22)
    assert.deepEqual(unknowns, [], 'Inactive IPC or empty VM namespaces have no corresponding resource; other checks must still run')
    observed ||= receipt.processes.some(item => item.pid === child.pid)
  }
  assert.equal(observed, true, 'The real shell holding this CWD must remain reported')
})
