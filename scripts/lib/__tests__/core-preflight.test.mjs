import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { runCorePreflight } from '../core-preflight.mjs'
import { acquireCliLock, acquireStartupLock, releaseCliLock, cliLockToken } from '../cli-lock.mjs'
import state from '../preflight-state.cjs'
import identity from '../process-identity.cjs'

async function fixture(t, code) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'Crabot startup preflight ')))
  const data = path.join(parent, '数据'), root = path.join(parent, '核心')
  await fs.mkdir(data); await fs.mkdir(path.join(root, 'crabot-core/dist'), { recursive: true })
  await fs.writeFile(path.join(root, 'crabot-core/dist/orphan-recovery-preflight.js'), code)
  t.after(() => fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  return { parent, root, data }
}

test('registered preflight runs only under the lock and acknowledges its exact completed child', async t => {
  const f = await fixture(t, "require('fs').writeFileSync(process.env.DATA_DIR+'/ran',JSON.stringify([process.env.CRABOT_PREFLIGHT_DATA_DIR,process.env.CRABOT_PREFLIGHT_ID]));console.log('done')")
  await assert.rejects(runCorePreflight({ root: f.root, dataDir: f.data, node: process.execPath, env: process.env }), { code: 'CRABOT_PREFLIGHT_INTERRUPTED' })
  const lock = await acquireCliLock(f.data, 'test-preflight')
  try {
    const result = await runCorePreflight({ root: f.root, dataDir: f.data, node: process.execPath, env: { ...process.env, DATA_DIR: f.data } })
    assert.equal(result.exitCode, 0)
    assert.equal(await fs.readFile(path.join(f.data, 'ran'), 'utf8'), '[null,null]')
    assert.equal(state.read(f.data), null)
  } finally { releaseCliLock(lock) }
})

test('a missing program produces an acknowledged failure without bypassing the guard', async t => {
  const f = await fixture(t, '')
  await fs.rm(path.join(f.root, 'crabot-core/dist/orphan-recovery-preflight.js'))
  const lock = await acquireCliLock(f.data, 'test-preflight-error')
  try {
    const result = await runCorePreflight({ root: f.root, dataDir: f.data, node: process.execPath, env: { ...process.env, DATA_DIR: f.data } })
    assert.notEqual(result.exitCode, 0); assert.equal(state.read(f.data), null)
  } finally { releaseCliLock(lock) }
})

test('parent crash keeps a live preflight protected, and its unacknowledged exit remains interrupted', { timeout: 15000 }, async t => {
  let f, parent, receipt
  t.after(async () => {
    if (f) await fs.writeFile(path.join(f.data, 'finish'), 'settle-controlled-child').catch(() => {})
    if (parent && parent.exitCode === null && parent.signalCode === null) { const ended = once(parent, 'exit'); parent.kill('SIGKILL'); await ended }
    const deadline = Date.now() + 2000
    while (receipt?.child && Date.now() < deadline) {
      try { if (!identity.sameProcess(receipt.child, identity.inspectProcess(receipt.child.pid))) break }
      catch (error) { if (error.code !== 'CRABOT_PROCESS_IDENTITY') throw error }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  })
  f = await fixture(t, "const fs=require('fs'),data=process.env.DATA_DIR;fs.writeFileSync(data+'/ready','yes');const deadline=setTimeout(()=>clearInterval(gate),8000);const gate=setInterval(()=>{if(fs.existsSync(data+'/finish')){clearInterval(gate);clearTimeout(deadline);fs.writeFileSync(data+'/late','preserved')}},20)")
  const parentCode = `
    import path from 'node:path';
    import {keepControlledChildAfterParentExit} from ${JSON.stringify(new URL('./fixtures/controlled-orphan.mjs', import.meta.url).href)};
    import {acquireCliLock} from ${JSON.stringify(new URL('../cli-lock.mjs', import.meta.url).href)};
    import {runCorePreflight} from ${JSON.stringify(new URL('../core-preflight.mjs', import.meta.url).href)};
    const [dataDir,root] = process.argv.slice(1);
    keepControlledChildAfterParentExit(path.join(root,'crabot-core/dist/orphan-recovery-preflight.js'));
    await acquireCliLock(dataDir,'parent');
    await runCorePreflight({root,dataDir,node:process.execPath,env:{...process.env,DATA_DIR:dataDir}});
  `
  parent = spawn(process.execPath, ['--input-type=module', '-e', parentCode, f.data, f.root], { stdio: ['ignore', 'ignore', 'inherit'] })
  const deadline = Date.now() + 7000
  while (!(await fs.stat(path.join(f.data, 'ready')).catch(() => null))) {
    if (Date.now() > deadline || parent.exitCode !== null) assert.fail('Controlled preflight did not start')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  receipt = state.read(f.data)
  const exited = once(parent, 'exit')
  parent.kill('SIGKILL'); await exited
  assert.ok(identity.sameProcess(receipt.child, identity.inspectProcess(receipt.child.pid)))
  await assert.rejects(acquireCliLock(f.data, 'next-operation', 0), { code: 'CRABOT_PREFLIGHT_BUSY' })
  await assert.rejects(acquireStartupLock(f.data, 'recover-start', 0), { code: 'CRABOT_PREFLIGHT_BUSY' })
  await fs.writeFile(path.join(f.data, 'finish'), 'complete-this-controlled-preflight')
  while (identity.sameProcess(receipt.child, identity.inspectProcess(receipt.child.pid))) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(await fs.readFile(path.join(f.data, 'late'), 'utf8'), 'preserved')
  await assert.rejects(acquireCliLock(f.data, 'after-exit', 0), { code: 'CRABOT_PREFLIGHT_INTERRUPTED' })
  assert.equal(state.read(f.data).id, receipt.id)
  await fs.writeFile(path.join(f.root, 'crabot-core/dist/orphan-recovery-preflight.js'), "require('fs').writeFileSync(process.env.DATA_DIR+'/rechecked','yes')")
  const lock = await acquireStartupLock(f.data, 'explicit-recheck', 0)
  try {
    assert.equal((await runCorePreflight({ root: f.root, dataDir: f.data, node: process.execPath,
      env: { ...process.env, DATA_DIR: f.data } })).exitCode, 0)
    assert.equal(await fs.readFile(path.join(f.data, 'rechecked'), 'utf8'), 'yes')
    assert.equal(await fs.readFile(path.join(f.data, 'late'), 'utf8'), 'preserved')
    assert.equal(state.read(f.data), null)
  } finally { releaseCliLock(lock) }
})

test('a timed-out registered preflight retains its interrupted receipt', { timeout: 10000 }, async t => {
  const f = await fixture(t, 'setInterval(()=>{},1000)')
  const lock = await acquireCliLock(f.data, 'timeout')
  try {
    await assert.rejects(runCorePreflight({ root: f.root, dataDir: f.data, node: process.execPath,
      env: { ...process.env, DATA_DIR: f.data }, timeoutMs: 100 }), { code: 'CRABOT_PREFLIGHT_TIMEOUT' })
    assert.ok(state.read(f.data).child)
  } finally { releaseCliLock(lock) }
  await assert.rejects(acquireCliLock(f.data, 'after-timeout', 0), { code: 'CRABOT_PREFLIGHT_INTERRUPTED' })
})

test('an unregistered direct launch cannot reach the preflight entry', async t => {
  const f = await fixture(t, "require('fs').writeFileSync(process.env.DATA_DIR+'/unauthorized','must-not-run')")
  const child = spawn(process.execPath, ['--import', new URL('../preflight-child.mjs', import.meta.url).href,
    path.join(f.root, 'crabot-core/dist/orphan-recovery-preflight.js')], { stdio: 'ignore', env: { ...process.env, DATA_DIR: f.data,
      CRABOT_PREFLIGHT_DATA_DIR: f.data, CRABOT_PREFLIGHT_ID: 'unregistered' } })
  const [code] = await once(child, 'exit')
  assert.notEqual(code, 0)
  assert.equal(await fs.stat(path.join(f.data, 'unauthorized')).catch(() => null), null)
  assert.equal(state.read(f.data), null)
})

test('a corrupt receipt refuses a new operation and releases the OS handle without altering data', async t => {
  const f = await fixture(t, '')
  await fs.writeFile(path.join(f.data, 'startup-preflight.json'), '{}', { mode: 0o600 })
  await assert.rejects(acquireCliLock(f.data, 'corrupt', 0), { code: 'CRABOT_PREFLIGHT_INTERRUPTED' })
  const held = identity.tryFileLock(path.join(f.data, 'cli.lock'), '{}')
  assert.ok(held); identity.releaseFileLock(held)
  assert.equal(await fs.readFile(path.join(f.data, 'startup-preflight.json'), 'utf8'), '{}')
})

test('failed child registration never reaches the entry and can be explicitly rechecked', async t => {
  const f = await fixture(t, "require('fs').writeFileSync(process.env.DATA_DIR+'/must-not-run','no')")
  const publish = state.publish
  t.mock.method(state, 'publish', (directory, record, previous) => {
    if (record.child) throw Object.assign(new Error('Registration could not publish'), { code: 'EIO' })
    return publish(directory, record, previous)
  })
  const lock = await acquireCliLock(f.data, 'registration-failure')
  try {
    await assert.rejects(runCorePreflight({ root: f.root, dataDir: f.data, node: process.execPath,
      env: { ...process.env, DATA_DIR: f.data } }), { code: 'EIO' })
    assert.equal(await fs.stat(path.join(f.data, 'must-not-run')).catch(() => null), null)
    assert.equal(state.read(f.data).child, null)
  } finally { releaseCliLock(lock); t.mock.restoreAll() }
  await assert.rejects(acquireCliLock(f.data, 'ordinary', 0), { code: 'CRABOT_PREFLIGHT_INTERRUPTED' })
  await fs.writeFile(path.join(f.root, 'crabot-core/dist/orphan-recovery-preflight.js'), '')
  const recovery = await acquireStartupLock(f.data, 'explicit-recovery', 0)
  try {
    assert.equal((await runCorePreflight({ root: f.root, dataDir: f.data, node: process.execPath,
      env: { ...process.env, DATA_DIR: f.data } })).exitCode, 0)
    assert.equal(state.read(f.data), null)
  } finally { releaseCliLock(recovery) }
})

test('failed spawn has no possible child writer and acknowledges only its own receipt', async t => {
  const f = await fixture(t, '')
  const lock = await acquireCliLock(f.data, 'spawn-failure')
  try {
    await assert.rejects(runCorePreflight({ root: f.root, dataDir: f.data, node: path.join(f.root, 'no-such-node'),
      env: { ...process.env, DATA_DIR: f.data } }), { code: 'ENOENT' })
    assert.equal(state.read(f.data), null)
  } finally { releaseCliLock(lock) }
})


test('unknown child identity keeps the receipt protected and releases the attempted OS lock', async t => {
  let child
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill(); await ended }
  })
  const f = await fixture(t, '')
  child = spawn(process.execPath, ['-e', 'process.send("ready");setInterval(()=>{},1000)'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  await once(child, 'message')
  const lock = await acquireCliLock(f.data, 'controlled-unknown-child')
  const record = { schema_version: 1, kind: 'orphan_preflight', id: randomUUID(), lock_token: cliLockToken(lock),
    owner: identity.inspectProcess(process.pid), child: identity.inspectProcess(child.pid) }
  try { state.publish(f.data, record) } finally { releaseCliLock(lock) }
  const inspect = identity.inspectProcess
  t.mock.method(identity, 'inspectProcess', pid => {
    if (pid === child.pid) throw Object.assign(new Error('Controlled unknown identity'), { code: 'CRABOT_PROCESS_IDENTITY' })
    return inspect(pid)
  })
  await assert.rejects(acquireCliLock(f.data, 'unknown-child', 0), { code: 'CRABOT_PROCESS_IDENTITY' })
  const attempted = identity.tryFileLock(path.join(f.data, 'cli.lock'), '{}')
  assert.ok(attempted); identity.releaseFileLock(attempted)
  assert.equal(state.read(f.data).id, record.id)
  t.mock.restoreAll()
  await assert.rejects(acquireCliLock(f.data, 'still-live', 0), { code: 'CRABOT_PREFLIGHT_BUSY' })
  const ended = once(child, 'exit'); child.kill(); await ended
  const deadline = Date.now() + 2000
  for (;;) {
    try { assert.equal(identity.inspectProcess(child.pid), null); break }
    catch (error) { if (error.code !== 'CRABOT_PROCESS_IDENTITY' || Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 10)) }
  }
  await assert.rejects(acquireCliLock(f.data, 'exited-without-ack', 0), { code: 'CRABOT_PREFLIGHT_INTERRUPTED' })
  assert.equal(state.read(f.data).id, record.id)
})
