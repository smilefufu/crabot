import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { inspectInstance, identity } from '../instance-runtime.mjs'
import { stopInstance } from '../instance-controller.mjs'

test('detached shared core survives its launching frontend being killed; stop remains stopped', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'crabot-background-中文 space-')))
  const data = join(root, 'data'), marker = join(root, 'stopped')
  mkdirSync(data); mkdirSync(join(root, 'crabot-core', 'dist'), { recursive: true }); mkdirSync(join(root, 'scripts'))
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  copyFileSync(new URL('./fixtures/core.mjs', import.meta.url), join(root, 'crabot-core', 'dist', 'main.js'))
  const managed = new URL('../managed-core.mjs', import.meta.url).href
  const bootstrap = new URL('../supervisor-bootstrap.mjs', import.meta.url).href
  writeFileSync(join(root, 'scripts', 'supervisor.mjs'), `import {runManagedCore} from ${JSON.stringify(managed)};import{claimSupervisorStart}from${JSON.stringify(bootstrap)};const context={root:process.env.TEST_CORE_ROOT,dataDir:process.env.TEST_DATA_DIR,mmPort:Number(process.env.TEST_PORT)};const record=await claimSupervisorStart(context);await runManagedCore({...context,adoptGeneration:record.generation,env:process.env,stdio:['ignore','ignore','ignore'],cleanup:code=>process.exit(code)})`)
  const probe = createServer().listen(0, '127.0.0.1'); await once(probe, 'listening')
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  const locks = new URL('../cli-lock.mjs', import.meta.url).href
  const source = `import {launchBackgroundCore} from ${JSON.stringify(new URL('../background-core.mjs', import.meta.url).href)};import{acquireCliLock,releaseCliLock}from${JSON.stringify(locks)};const lock=await acquireCliLock(process.env.TEST_DATA_DIR,'fixture-start');await launchBackgroundCore({root:process.env.TEST_CORE_ROOT,dataDir:process.env.TEST_DATA_DIR,env:process.env,mmPort:Number(process.env.TEST_PORT),webPort:Number(process.env.TEST_PORT)});releaseCliLock(lock);process.send('ready');setInterval(()=>{},1000)`
  const frontend = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, TEST_CORE_ROOT: root, TEST_DATA_DIR: data, TEST_PORT: String(port), TEST_MARKER: marker, TEST_READY: join(root, 'ready') },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  })
  t.after(() => {
    frontend.kill('SIGKILL')
    let record
    try { record = inspectInstance(data).record } catch {}
    for (const target of [record?.mm, record?.controller]) if (target && identity.sameProcess(target, identity.inspectProcess(target.pid))) process.kill(target.pid, 'SIGKILL')
    rmSync(root, { recursive: true, force: true })
  })
  await Promise.race([once(frontend, 'message'), once(frontend, 'exit').then(([code]) => { throw new Error('frontend failed ' + code) })])
  const exited = once(frontend, 'exit'); frontend.kill('SIGKILL'); await exited
  assert.equal(inspectInstance(data).state, 'running')
  await stopInstance(data)
  assert.equal(readFileSync(marker, 'utf8'), 'graceful')
  assert.equal(inspectInstance(data).state, 'stopped')
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(inspectInstance(data).state, 'stopped')
})


test('only the verified Admin UI upgrader survives core stop, including its stop CLI', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/ui-maintenance.mjs', import.meta.url))
  const checkout = fileURLToPath(new URL('../../../', import.meta.url))
  for (const mode of ['updater', 'extra-args', 'agent-parent', 'unreadable', 'cleanup-race', 'registration-delay']) {
    const result = await promisify(execFile)(process.execPath, [fixture, checkout, mode], { timeout: 20_000 })
    assert.match(result.stdout, /CONTROLLED_UI_MAINTENANCE_STOP/)
  }
})
