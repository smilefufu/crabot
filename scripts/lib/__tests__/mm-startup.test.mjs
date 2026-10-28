import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInstanceRuntime, recordMmProcess, readInstanceRuntime } from '../instance-runtime.mjs'

for (const registered of [false, true, 'delayed']) test('actual MM entry refuses data initialization until its exact PID is registered: ' + registered, { timeout: 12_000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'crabot-mm-bootstrap-'))), data = join(root, 'data'), marker = join(root, 'would-write-data')
  mkdirSync(data); mkdirSync(join(root, 'crabot-core'))
  const entry = fileURLToPath(new URL('../../../crabot-core/dist/main.js', import.meta.url)), preload = join(root, 'preload.cjs')
  // Execute the real compiled entry, but replace the business MM and venv writer.
  // No modules, listeners, models or actual business MM run on this live host.
  writeFileSync(preload, `const Module=require('node:module'),fs=require('node:fs');const load=Module._load;Module._load=function(request,parent,...rest){if(parent?.filename===${JSON.stringify(entry)}){if(request==='./index.js')return class{async start(){process.exit(0)}async stop(){}};if(request==='./agent-venv.js')return{ensureAgentVenv(){fs.writeFileSync(process.env.TEST_MARKER,'initialized');return null}}}return load.call(this,request,parent,...rest)}`)
  const record = createInstanceRuntime({ root, dataDir: data, mmPort: 19000 })
  const child = spawn(process.execPath, ['--require', preload, entry], { cwd: join(root, 'crabot-core'), env: { ...process.env,
    DATA_DIR: data, CRABOT_INSTANCE_GENERATION: record.generation, CRABOT_PRODUCT_REQUIRED: '0', CRABOT_DEV: 'false',
    CRABOT_PORT_OFFSET: '0', CRABOT_ORPHAN_RECOVERY_INTERACTIVE: '0', TEST_MARKER: marker }, stdio: ['ignore', 'ignore', 'pipe'] })
  const exited = once(child, 'exit'); let output = ''
  child.stderr.on('data', bytes => { output = (output + bytes).slice(-4096) })
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
  await once(child, 'spawn')
  if (registered === 'delayed') {
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(existsSync(marker), false, 'A live parent is not a substitute for the exact MM registration')
  }
  if (registered) recordMmProcess(data, record.generation, child.pid)
  const [code] = await exited
  assert.equal(existsSync(marker), !!registered, output)
  assert.equal(code, registered ? 0 : 1, output)
  assert.equal(readInstanceRuntime(data).generation, record.generation)
})
