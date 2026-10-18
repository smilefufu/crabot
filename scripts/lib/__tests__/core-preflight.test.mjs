import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { runCorePreflight } from '../core-preflight.mjs'
import { acquireCliLock, acquireStartupLock, releaseCliLock } from '../cli-lock.mjs'
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
  const f = await fixture(t, "const fs=require('fs'),data=process.env.DATA_DIR;fs.writeFileSync(data+'/ready','yes');const deadline=setTimeout(()=>clearInterval(gate),8000);const gate=setInterval(()=>{if(fs.existsSync(data+'/finish')){clearInterval(gate);clearTimeout(deadline);fs.writeFileSync(data+'/late','preserved')}},20)")
  const parentCode = `import{acquireCliLock}from${JSON.stringify(new URL('../cli-lock.mjs', import.meta.url).href)};import{runCorePreflight}from${JSON.stringify(new URL('../core-preflight.mjs', import.meta.url).href)};await acquireCliLock(process.argv[1],'parent');await runCorePreflight({root:process.argv[2],dataDir:process.argv[1],node:process.execPath,env:{...process.env,DATA_DIR:process.argv[1]}})`
  const parent = spawn(process.execPath, ['--input-type=module', '-e', parentCode, f.data, f.root], { stdio: ['ignore', 'ignore', 'inherit'] })
  t.after(() => { if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL') })
  const deadline = Date.now() + 7000
  while (!(await fs.stat(path.join(f.data, 'ready')).catch(() => null))) {
    if (Date.now() > deadline || parent.exitCode !== null) assert.fail('Controlled preflight did not start')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const receipt = state.read(f.data), exited = once(parent, 'exit')
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
