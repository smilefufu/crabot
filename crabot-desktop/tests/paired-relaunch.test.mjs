import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { tmpdir } from 'node:os'

test('actual Electron relaunch waits for the source exit and reacquires its private single-instance lock', { timeout: 45_000 }, async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'crabot-pair-relaunch-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS
  const result = await new Promise((resolve, reject) => {
    const child = spawn(createRequire(import.meta.url)('electron'), [fileURLToPath(new URL('./paired-relaunch.cjs', import.meta.url)), root, 'source'],
      { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 })
    let output = ''
    child.stdout.on('data', bytes => { output = (output + bytes).slice(-32_768) })
    child.stderr.on('data', bytes => { output = (output + bytes).slice(-32_768) })
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, output }))
  })
  assert.equal(result.code, 0, result.output)
  let evidence
  const deadline = Date.now() + 25_000
  while (!evidence && Date.now() < deadline) {
    try { evidence = JSON.parse(await fs.readFile(path.join(root, 'result.json'), 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw error; await new Promise(resolve => setTimeout(resolve, 100)) }
  }
  assert.deepEqual(evidence, { previous_exited: true, target_single_instance_lock: true, ordinary_stop_calls: 0,
    business_mm_started: false, different_gui_binary: false }, result.output)
  console.log('CRABOT_PAIR_RELAUNCH ' + JSON.stringify(evidence))
})
