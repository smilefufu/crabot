import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'

for (const stalled of [false, true]) test('actual sandboxed Electron window enforces local-frame IPC and direct request credential boundaries' + (stalled ? ': pending renderer evaluation is bounded' : ''), { timeout: 40_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'crabot-electron-boundary-'))
  try {
    const result = await new Promise((resolve, reject) => {
      const env = { ...process.env, CRABOT_BOUNDARY_ROOT: root, CRABOT_BOUNDARY_STALLED_EVALUATION: stalled ? '1' : '0' }; delete env.ELECTRON_RUN_AS_NODE
      const child = spawn(createRequire(import.meta.url)('electron'), [fileURLToPath(new URL('./electron-boundary.cjs', import.meta.url))], { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 })
      let output = ''
      child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
      child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal, termination_requested: child.killed, output }))
    })
    assert.equal(result.termination_requested, false, JSON.stringify({ code: result.code, signal: result.signal, termination_requested: result.termination_requested }) + '\n' + result.output)
    if (stalled) {
      assert.equal(result.code, 1, result.output)
      assert.match(result.output, /React condition 1 renderer execution exceeded its original 5000ms budget/)
      assert.doesNotMatch(result.output, /CRABOT_ELECTRON_BOUNDARY /)
      return
    }
    assert.equal(result.code, 0, JSON.stringify({ code: result.code, signal: result.signal, termination_requested: result.termination_requested }) + '\n' + result.output)
    const line = result.output.split('\n').find(line => line.startsWith('CRABOT_ELECTRON_BOUNDARY '))
    assert.ok(line, result.output)
    assert.equal(JSON.parse(line.slice('CRABOT_ELECTRON_BOUNDARY '.length)).direct_http_header, true)
    console.log(line)
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})
