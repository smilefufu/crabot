import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

test('actual Electron keeps complete-root and candidate updates outside the legacy installer', { timeout: 35_000 }, async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'Crabot paired gate '))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const require = createRequire(import.meta.url), env = { ...process.env }
  for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'DATA_DIR', 'CRABOT_HOME', 'CRABOT_DEV']) delete env[name]
  const result = await promisify(execFile)(require('electron'), [fileURLToPath(new URL('./paired-update-gate.cjs', import.meta.url)), root],
    { env, timeout: 30000, maxBuffer: 32768 })
  assert.match(result.stdout, /"complete_root_no_legacy":true/)
  console.log(result.stdout.trim())
})
