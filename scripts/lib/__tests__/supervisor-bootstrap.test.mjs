import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInstanceRuntime, inspectInstance, identity } from '../instance-runtime.mjs'
import { stopInstance } from '../instance-controller.mjs'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(file) {
  const deadline = Date.now() + 5000
  while (!existsSync(file)) { if (Date.now() >= deadline) throw new Error('Fixture did not become ready'); await pause(10) }
}

for (const scenario of ['missing IPC', 'parent disconnect', 'wrong generation', 'valid claim']) test('supervisor bootstrap: ' + scenario, { timeout: 10_000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'crabot-bootstrap-'))), data = join(root, 'data'), marker = join(root, 'claimed')
  mkdirSync(data)
  const bootstrap = new URL('../supervisor-bootstrap.mjs', import.meta.url).href
  const source = `import{claimSupervisorStart}from${JSON.stringify(bootstrap)};import{writeFileSync}from"node:fs";try{await claimSupervisorStart({root:process.env.TEST_ROOT,dataDir:process.env.TEST_DATA,mmPort:19000});writeFileSync(process.env.TEST_MARKER,'claimed');process.exit(0)}catch{process.exit(2)}`
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env,
    TEST_ROOT: root, TEST_DATA: data, TEST_MARKER: marker }, stdio: ['ignore', 'ignore', 'inherit', ...(scenario === 'missing IPC' ? [] : ['ipc'])] })
  const exited = once(child, 'exit')
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; rmSync(root, { recursive: true, force: true }) })
  if (scenario === 'missing IPC') { assert.equal((await exited)[0], 2); assert.equal(existsSync(marker), false); return }
  const [ready] = await once(child, 'message')
  assert.deepEqual(ready, { type: 'crabot-supervisor-awaiting' })
  assert.equal(existsSync(marker), false)
  const record = createInstanceRuntime({ root, dataDir: data, controllerPid: child.pid, mmPort: 19000 })
  if (scenario === 'parent disconnect') child.disconnect()
  else {
    const claimed = scenario === 'valid claim' ? once(child, 'message') : null
    child.send({ type: 'crabot-supervisor-start', generation: scenario === 'valid claim' ? record.generation : 'stale' })
    if (claimed) assert.deepEqual((await claimed)[0], { type: 'crabot-supervisor-claimed', generation: record.generation })
  }
  assert.equal((await exited)[0], scenario === 'valid claim' ? 0 : 2)
  assert.equal(existsSync(marker), scenario === 'valid claim')
  assert.equal(inspectInstance(data).record.generation, record.generation, 'A failed claim must not erase runtime evidence')
})

test('stop reports busy for a registered controller which has not spawned its MM', { timeout: 10_000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'crabot-starting-stop-'))), data = join(root, 'data')
  mkdirSync(data)
  const child = spawn(process.execPath, ['-e', 'process.send("ready");setInterval(()=>{},1000)'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  const exited = once(child, 'exit')
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; rmSync(root, { recursive: true, force: true }) })
  await once(child, 'message')
  const record = createInstanceRuntime({ root, dataDir: data, controllerPid: child.pid, mmPort: 19000 })
  await assert.rejects(stopInstance(data), { code: 'CRABOT_INSTANCE_STARTING' })
  assert.equal(inspectInstance(data).record.generation, record.generation)
  assert.equal(identity.sameProcess(record.controller, identity.inspectProcess(child.pid)), true)
})

test('the launching frontend registers the detached controller before it can outlive that frontend', { timeout: 15_000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'crabot-unclaimed-start-'))), data = join(root, 'data'), pidFile = join(root, 'child.pid')
  mkdirSync(data); mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'crabot-core/dist'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  // Deliberately hold the supervisor before any child-side runtime registration.
  // It never starts a business MM or even a TCP server.
  writeFileSync(join(root, 'scripts/supervisor.mjs'), 'import{writeFileSync}from"node:fs";writeFileSync(process.env.TEST_CHILD_PID,String(process.pid));setInterval(()=>{},1000)')
  const launch = new URL('../background-core.mjs', import.meta.url).href, locks = new URL('../cli-lock.mjs', import.meta.url).href
  const source = `import{launchBackgroundCore}from${JSON.stringify(launch)};import{acquireCliLock}from${JSON.stringify(locks)};await acquireCliLock(process.env.TEST_DATA,"fixture-start");await launchBackgroundCore({root:process.env.TEST_ROOT,dataDir:process.env.TEST_DATA,env:process.env,mmPort:19000,webPort:3000})`
  const frontend = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, TEST_ROOT: root, TEST_DATA: data, TEST_CHILD_PID: pidFile }, stdio: ['ignore', 'ignore', 'inherit'],
  })
  const exited = once(frontend, 'exit')
  let controller
  t.after(async () => {
    if (frontend.exitCode === null && frontend.signalCode === null) frontend.kill('SIGKILL')
    await exited
    if (controller && identity.sameProcess(controller, identity.inspectProcess(controller.pid))) process.kill(controller.pid, 'SIGKILL')
    const deadline = Date.now() + 2000
    while (controller && identity.sameProcess(controller, identity.inspectProcess(controller.pid)) && Date.now() < deadline) await pause(10)
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  await waitFor(pidFile); controller = identity.inspectProcess(Number(readFileSync(pidFile, 'utf8')))
  frontend.kill('SIGKILL'); await exited
  assert.equal(inspectInstance(data).state, 'starting')
  await assert.rejects(stopInstance(data), { code: 'CRABOT_INSTANCE_STARTING' })
  assert.equal(identity.sameProcess(controller, identity.inspectProcess(controller.pid)), true)
})
