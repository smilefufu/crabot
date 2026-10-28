import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import identity from '../../scripts/lib/process-identity.cjs'
import { stopKnownProcessScope } from '../../scripts/lib/known-process-stop.cjs'

for (const { stalled, suffix } of [{ stalled: false, suffix: '' }, { stalled: true, suffix: ': pending renderer evaluation is bounded' },
  { stalled: 'parent-stall', suffix: ': parent observation and owned cleanup are bounded' },
  { stalled: 'held-connection', suffix: ': held idle fixture connection is cleaned up' }]) test('actual sandboxed Electron window enforces local-frame IPC and direct request credential boundaries' + suffix, { timeout: 40_000 }, async () => {
  let settled = false
  const parentStall = stalled === 'parent-stall'
  const root = await mkdtemp(path.join(tmpdir(), 'crabot-electron-boundary-'))
  try {
    const env = { ...process.env, CRABOT_BOUNDARY_ROOT: root,
      CRABOT_BOUNDARY_HOLD_CONNECTION: stalled === 'held-connection' ? '1' : '0',
      CRABOT_BOUNDARY_STALLED_EVALUATION: stalled === true ? '1' : '0', CRABOT_BOUNDARY_PARENT_STALL: parentStall ? '1' : '0' }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [fileURLToPath(new URL('./electron-boundary.cjs', import.meta.url))], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', timer, expected
    const append = data => { output = (output + data).slice(-65536) }
    child.stdout.on('data', append); child.stderr.on('data', append)
    try {
      const closed = new Promise(resolve => {
        child.once('error', error => resolve({ error })); child.once('close', (code, signal) => resolve({ code, signal, termination_requested: false }))
      })
      const deadline = Date.now() + 2000
      while (!expected && Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
        if (Number.isInteger(child.pid)) expected = identity.inspectProcess(child.pid)
        if (!expected) await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert.ok(expected && expected.owner === identity.inspectProcess(process.pid).owner, 'private child identity could not be established')
      const result = await Promise.race([closed, new Promise(resolve => {
        timer = setTimeout(() => resolve({ termination_requested: true }), parentStall ? 10000 : 30000)
      })])
      if (result.error) throw result.error
      if (result.termination_requested) {
        const phase = output.split('\n').filter(line => line.startsWith('CRABOT_BOUNDARY_PHASE ')).at(-1) ?? 'no fixture phase received'
        console.log('CRABOT_BOUNDARY_PARENT_DEADLINE ' + phase)
        await stopKnownProcessScope([expected], { timeoutMs: 1, onObserved: () => {}, graceful: async () => {} })
        settled = true
        if (parentStall) { assert.match(output, /parent-stall-ready/); return }
      } else settled = true
      result.output = output
      assert.equal(parentStall, false, 'the intentionally stalled fixture must require bounded cleanup')
      assert.equal(result.termination_requested, false, JSON.stringify({ code: result.code, signal: result.signal, termination_requested: result.termination_requested }) + '\n' + result.output)
      if (stalled === true) {
        assert.equal(result.code, 1, result.output)
        assert.match(result.output, /CRABOT_BOUNDARY_PHASE .*cleanup-complete-1/)
        assert.match(result.output, /React condition 1 renderer execution exceeded its original 5000ms budget/)
        assert.doesNotMatch(result.output, /CRABOT_ELECTRON_BOUNDARY /)
        return
      }
      assert.match(result.output, /CRABOT_BOUNDARY_PHASE .*cleanup-complete-0/)
      assert.equal(result.code, 0, JSON.stringify({ code: result.code, signal: result.signal, termination_requested: result.termination_requested }) + '\n' + result.output)
      const line = result.output.split('\n').find(line => line.startsWith('CRABOT_ELECTRON_BOUNDARY '))
      assert.ok(line, result.output)
      assert.equal(JSON.parse(line.slice('CRABOT_ELECTRON_BOUNDARY '.length)).direct_http_header, true)
      console.log(line)
    } finally { clearTimeout(timer); child.stdout.destroy(); child.stderr.destroy(); child.unref() }
  } finally { if (settled) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})
