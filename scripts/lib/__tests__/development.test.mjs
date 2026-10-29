import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { developmentEnvironment, developmentPorts, isDevelopmentTree } from '../development-environment.mjs'
import { developmentBuildState } from '../development-build.mjs'
import { inspectDevelopment, readDevelopmentStatus, stopDevelopment, assertDevelopmentPortsAvailable, assertDevelopmentBuildAllowed } from '../development.mjs'
import { createInstanceRuntime, recordMmProcess, clearInstanceRuntime, readInstanceRuntime } from '../instance-runtime.mjs'

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'crabot-dev-中文 space-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}
test('production context and credentials cannot redirect developer commands', t => {
  const root = fixture(t), source = { PATH: 'tools', DATA_DIR: '/production/data', WORKSPACE_DIR: '/production/work',
    CRABOT_ADMIN_DATA_DIR: '/production/admin', CRABOT_MM_PORT: '19000', CRABOT_PORT_OFFSET: '300',
    CRABOT_CLI_LOCK_HELD: 'foreign-lock', CRABOT_INSTANCE_GENERATION: 'foreign', CRABOT_JWT_SECRET: 'production-secret',
    CRABOT_PRODUCT_REQUIRED: '1', PORT: '19000', PORT_RANGE_START: '19002' }
  const env = developmentEnvironment(root, source)
  assert.equal(env.DATA_DIR, join(root, 'data')); assert.equal(env.PORT, '29000')
  assert.equal(env.CRABOT_ADMIN_WEB_PORT, '13000'); assert.equal(env.CRABOT_PORT_OFFSET, '10000')
  for (const key of ['WORKSPACE_DIR', 'CRABOT_ADMIN_DATA_DIR', 'CRABOT_CLI_LOCK_HELD', 'CRABOT_INSTANCE_GENERATION', 'CRABOT_JWT_SECRET']) assert.equal(env[key], undefined)
  assert.equal(env.PATH, 'tools'); assert.equal(source.DATA_DIR, '/production/data')
  writeFileSync(join(root, 'core-release.json'), '{}')
  assert.throws(() => developmentEnvironment(root), /发行程序/)
})
test('incremental receipts invalidate source additions, deletions and shared dependencies', t => {
  const root = fixture(t); mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'package.json'), '{}'); writeFileSync(join(root, 'src/a.ts'), 'first')
  const state = developmentBuildState(root, ['sdk-one']); assert.equal(state.ready, false); state.commit()
  assert.equal(developmentBuildState(root, ['sdk-one']).ready, true)
  writeFileSync(join(root, 'src/a.ts'), 'second'); assert.equal(developmentBuildState(root, ['sdk-one']).ready, false)
  developmentBuildState(root, ['sdk-one']).commit()
  writeFileSync(join(root, 'src/new.ts'), 'new'); assert.equal(developmentBuildState(root, ['sdk-one']).ready, false)
  rmSync(join(root, 'src/new.ts')); assert.equal(developmentBuildState(root, ['sdk-one']).ready, true)
  assert.equal(developmentBuildState(root, ['sdk-two']).ready, false)
  writeFileSync(join(root, '.env'), 'production-secret'); assert.equal(developmentBuildState(root, ['sdk-one']).ready, true)
})
test('stop with no developer instance leaves an unrelated real process alive', async t => {
  const root = fixture(t), child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
  await once(child, 'spawn'); const exited = once(child, 'exit')
  t.after(async () => { child.kill(); await exited })
  await stopDevelopment(root, { log() {} })
  assert.equal(child.exitCode, null); assert.equal((await inspectDevelopment(root)).state, 'stopped')
})
test('a release or other checkout record in developer data is refused without stopping its process', async t => {
  const root = fixture(t), foreign = fixture(t), data = join(root, 'data'); mkdirSync(data)
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
  await once(child, 'spawn'); const exited = once(child, 'exit')
  t.after(async () => { child.kill(); await exited })
  const record = createInstanceRuntime({ root: foreign, dataDir: data, controllerPid: child.pid, mmPort: 19000 })
  await assert.rejects(stopDevelopment(root, { log() {} }), { code: 'CRABOT_DEV_INSTANCE' })
  assert.equal(child.exitCode, null); assert.equal(readInstanceRuntime(data).generation, record.generation)
  clearInstanceRuntime(data, record.generation)
  const sameRootRelease = createInstanceRuntime({ root, dataDir: data, controllerPid: child.pid, mmPort: 19000 })
  await assert.rejects(stopDevelopment(root, { log() {} }), { code: 'CRABOT_DEV_INSTANCE' })
  assert.equal(child.exitCode, null); clearInstanceRuntime(data, sameRootRelease.generation)
})
test('a real developer port conflict is reported without terminating its owner', async () => {
  const server = createServer(); server.listen(developmentPorts.temporary, '127.0.0.1'); await once(server, 'listening')
  try { await assert.rejects(assertDevelopmentPortsAvailable(), /29099/); assert.equal(server.listening, true) }
  finally { await new Promise(done => server.close(done)) }
})

test('a source-only development marker does not bypass a sealed or required release', t => {
  const root = fixture(t); mkdirSync(join(root, 'crabot-desktop'))
  writeFileSync(join(root, 'crabot-desktop/package.json'), '{"crabotDesktopDevelopment":true}')
  assert.equal(isDevelopmentTree(root, { CRABOT_DEV: 'true' }), true)
  assert.equal(isDevelopmentTree(root, { CRABOT_DEV: 'true', CRABOT_PRODUCT_REQUIRED: '1' }), false)
  writeFileSync(join(root, 'core-release.json'), '{}')
  assert.equal(isDevelopmentTree(root, { CRABOT_DEV: 'true' }), false)
})

test('developer status reports its own real health separately from process ownership', { timeout: 10000 }, async t => {
  const root = fixture(t), data = join(root, 'data'); mkdirSync(data)
  assert.equal((await readDevelopmentStatus(root)).health, null)
  const child = spawn(process.execPath, ['-e', `const http=require('node:http');const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({success:true,data:{status:'degraded'}}))});server.listen(29000,'127.0.0.1',()=>process.send('ready'));`], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const exited = once(child, 'exit')
  let record
  try {
    await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('Finite health fixture exited before listening') })])
    record = createInstanceRuntime({ root, dataDir: data, mmPort: 29000 })
    recordMmProcess(data, record.generation, child.pid)
    const status = await readDevelopmentStatus(root)
    assert.equal(status.state, 'running'); assert.equal(status.health, 'degraded')
    assert.equal(status.record.generation, record.generation); assert.equal(status.dataDir, data)
  } finally {
    if (record) clearInstanceRuntime(data, record.generation)
    child.kill(); await exited
  }
})


test('a registered source deployment blocks rebuilding its live root even when mm.pid is its controller', async t => {
  const root = fixture(t), home = fixture(t), data = join(home, '.crabot/data')
  mkdirSync(data, { recursive: true }); mkdirSync(join(root, 'crabot-core/dist'), { recursive: true })
  const entry = join(root, 'crabot-core/dist/main.js'); writeFileSync(entry, 'setInterval(()=>{},1000)')
  const child = spawn(process.execPath, [entry], { stdio: 'ignore' }), exited = once(child, 'exit')
  await once(child, 'spawn')
  const record = createInstanceRuntime({ root, dataDir: data, mmPort: 19000 })
  recordMmProcess(data, record.generation, child.pid)
  const original = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = home; process.env.USERPROFILE = home
  try {
    assert.equal(readFileSync(join(data, 'mm.pid'), 'utf8'), String(process.pid))
    await assert.rejects(assertDevelopmentBuildAllowed(root), { code: 'CRABOT_DEV_INSTANCE' })
    assert.equal(child.exitCode, null, 'The guard never stops the existing deployment')
  } finally {
    for (const [key, value] of Object.entries(original)) if (value === undefined) delete process.env[key]; else process.env[key] = value
    clearInstanceRuntime(data, record.generation); child.kill(); await exited
  }
})
