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
import { acquireCliLock, acquireWorkspaceRelocationLock, releaseCliLock } from '../cli-lock.mjs'
import { beginWorkspaceRelocationIntent, commitWorkspaceRelocationCoordinator, readWorkspaceRelocationCoordinator } from '../workspace-relocation-intent.mjs'
import { WorkspaceCatalog } from '../../../crabot-shared/dist/workspace-catalog.js'
import { sha256CanonicalJson } from '../../../crabot-shared/dist/canonical-json.js'

async function fixture(t, { ipc = true, failReadyReply = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'crabot-coordinator-gate-'))), marker = path.join(root, 'entered')
  const data = management.ensurePrivateDataRoot(path.join(root, 'data')), id = randomUUID()
  const catalog = new WorkspaceCatalog({ dataRoot: data, files: native }); await catalog.initialize()
  let lock = await acquireCliLock(data, 'workspace-relocation')
  await beginWorkspaceRelocationIntent({ dataDir: data, id, target: path.join(root, 'new'), expectedRevision: (await catalog.snapshot()).revision, protectedRoots: [] })
  const entry = new URL('../workspace-coordinator-entry.mjs', import.meta.url).href
  const code = `import fs from 'node:fs';import{enterWorkspaceRelocationCoordinator}from ${JSON.stringify(entry)};
    if(${failReadyReply}&&process.send){const send=process.send.bind(process);process.send=(message,callback)=>message.kind==='workspace_relocation_ready'?(callback(new Error('fixture lost reply')),false):send(message,callback)}
    try{const context=await enterWorkspaceRelocationCoordinator();fs.writeFileSync(${JSON.stringify(marker)},'entered');
      try{await enterWorkspaceRelocationCoordinator();process.send({kind:'unexpected-reentry'})}catch(error){process.send({kind:'reentry',code:error.code})}
      process.on('message',message=>{if(message.kind==='fixture-exit'){context.release();process.exit(0)}});
      setTimeout(()=>process.exit(3),30000);
    }catch(error){if(process.connected)await new Promise(resolve=>process.send({kind:'rejected',code:error.code},()=>resolve()));process.exit(2)}`
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stderr.on('data', bytes => { output += bytes.toString() })
  const messages = []; child.on('message', message => messages.push(message))
  const exited = once(child, 'exit'); void exited.catch(() => {})
  t.after(async () => {
    releaseCliLock(lock)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
    fs.rmSync(root, { recursive: true, force: true })
  })
  await once(child, 'spawn')
  const input = { kind: 'workspace_relocation_start', data_dir: data, intent_id: id, launch_id: randomUUID() }
  const publish = (coordinator = native.inspectProcess(child.pid)) => {
    const launch = commitWorkspaceRelocationCoordinator({ dataDir: data, id, launchId: input.launch_id, coordinator })
    return { ...input, launch_sha256: sha256CanonicalJson(launch) }
  }
  const wait = async predicate => {
    const deadline = Date.now() + 10000
    while (!predicate()) { if (Date.now() > deadline) throw new Error('finite coordinator fixture timeout: ' + output); await new Promise(resolve => setTimeout(resolve, 10)) }
  }
  return { root, data, id, marker, child, messages, exited, input, publish, wait, unlock: () => releaseCliLock(lock) }
}

test('coordinator entry is importable before any job effects', async () => {
  const entry = await import('../workspace-coordinator-entry.mjs')
  assert.equal(typeof entry.enterWorkspaceRelocationCoordinator, 'function')
})

test('the fixed entry waits for independent lock handoff and durable readiness before entering once', async t => {
  const f = await fixture(t), input = f.publish()
  f.child.send(input)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(fs.existsSync(f.marker), false); assert.equal(readWorkspaceRelocationCoordinator(f.data, f.id).ready, null)
  f.unlock()
  await f.wait(() => f.messages.some(message => message.kind === 'reentry'))
  const result = readWorkspaceRelocationCoordinator(f.data, f.id)
  assert.deepEqual(f.messages[0], { kind: 'workspace_relocation_ready', intent_id: f.id, launch_id: input.launch_id, ready_sha256: sha256CanonicalJson(result.ready) })
  assert.equal(f.messages[1].code, 'CRABOT_WORKSPACE_COORDINATOR')
  assert.equal(fs.readFileSync(f.marker, 'utf8'), 'entered')
  await assert.rejects(acquireWorkspaceRelocationLock(f.data, f.id, 0), /another crabot CLI operation/)
  f.child.send({ kind: 'fixture-exit' }); assert.equal((await f.exited)[0], 0)
  assert.deepEqual(readWorkspaceRelocationCoordinator(f.data, f.id), result)
  const lock = await acquireWorkspaceRelocationLock(f.data, f.id, 0); releaseCliLock(lock)
})

for (const kind of ['unpublished', 'hash', 'extra', 'id']) test('entry rejects an unverified initialization without running the following graph: ' + kind, async t => {
  const f = await fixture(t)
  let input = kind === 'unpublished' ? { ...f.input, launch_sha256: '0'.repeat(64) } : f.publish()
  if (kind === 'hash') input.launch_sha256 = '0'.repeat(64)
  if (kind === 'extra') input.entry = 'arbitrary-script'
  if (kind === 'id') input.intent_id = randomUUID()
  f.unlock(); f.child.send(input)
  assert.equal((await f.exited)[0], 2)
  assert.equal(fs.existsSync(f.marker), false)
  assert.equal(f.messages[0]?.kind, 'rejected')
  assert.equal(f.messages[0]?.code, 'CRABOT_WORKSPACE_COORDINATOR')
  assert.equal(readWorkspaceRelocationCoordinator(f.data, f.id).ready, null)
})

test('a process without a parent IPC channel cannot enter the coordinator', async t => {
  const f = await fixture(t, { ipc: false }); f.unlock()
  assert.equal((await f.exited)[0], 2)
  assert.equal(fs.existsSync(f.marker), false)
})

test('a disconnected initialization does not run or publish readiness', async t => {
  const f = await fixture(t); f.publish(); f.unlock(); f.child.disconnect()
  assert.equal((await f.exited)[0], 2)
  assert.equal(fs.existsSync(f.marker), false)
  assert.equal(readWorkspaceRelocationCoordinator(f.data, f.id).ready, null)
})

test('a launch for a different real child cannot enter this process even with the correct record digest', async t => {
  const f = await fixture(t), other = await fixture(t)
  const input = f.publish(native.inspectProcess(other.child.pid)); f.unlock(); f.child.send(input)
  assert.equal((await f.exited)[0], 2)
  assert.equal(fs.existsSync(f.marker), false)
  assert.equal(readWorkspaceRelocationCoordinator(f.data, f.id).ready, null)
  assert.equal(fs.existsSync(other.marker), false)
})

test('missing initial handoff is bounded and leaves the private job without readiness', { timeout: 15000 }, async t => {
  const f = await fixture(t); f.publish(); f.unlock()
  assert.equal((await f.exited)[0], 2)
  assert.equal(f.messages[0]?.code, 'CRABOT_WORKSPACE_COORDINATOR')
  assert.equal(fs.existsSync(f.marker), false)
  assert.equal(readWorkspaceRelocationCoordinator(f.data, f.id).ready, null)
})

test('a lost ready reply retains the first durable receipt and releases the lock without running the graph', async t => {
  const f = await fixture(t, { failReadyReply: true }), input = f.publish()
  f.unlock(); f.child.send(input)
  assert.equal((await f.exited)[0], 2)
  assert.equal(fs.existsSync(f.marker), false)
  assert.equal(f.messages[0]?.kind, 'rejected')
  const state = readWorkspaceRelocationCoordinator(f.data, f.id)
  assert.equal(state.launch.launch_id, input.launch_id)
  assert.ok(state.ready)
  const lock = await acquireWorkspaceRelocationLock(f.data, f.id, 0); releaseCliLock(lock)
})
