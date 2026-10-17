import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
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
  writeFileSync(join(root, 'scripts', 'supervisor.mjs'), `import {runManagedCore} from ${JSON.stringify(managed)};await runManagedCore({root:process.env.TEST_CORE_ROOT,dataDir:process.env.TEST_DATA_DIR,mmPort:Number(process.env.TEST_PORT),env:process.env,stdio:['ignore','ignore','ignore'],cleanup:code=>process.exit(code)})`)
  const probe = createServer().listen(0, '127.0.0.1'); await once(probe, 'listening')
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  const source = `import {launchBackgroundCore} from ${JSON.stringify(new URL('../background-core.mjs', import.meta.url).href)};await launchBackgroundCore({root:process.env.TEST_CORE_ROOT,dataDir:process.env.TEST_DATA_DIR,env:process.env,mmPort:Number(process.env.TEST_PORT),webPort:Number(process.env.TEST_PORT)});process.send('ready');setInterval(()=>{},1000)`
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
