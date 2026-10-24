import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

test('disposable Windows user retains actual StartupApproved bytes across a native login retarget', {
  skip: process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true', timeout: 90000,
}, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'Crabot 启动 验收 ')))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const require = createRequire(import.meta.url), env = { ...process.env }
  for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'DATA_DIR', 'CRABOT_HOME', 'CRABOT_DEV']) delete env[name]
  const result = await promisify(execFile)(require('electron'), [fileURLToPath(new URL('./login-startup-native.cjs', import.meta.url)), root],
    { env, timeout: 80000, maxBuffer: 32768, windowsHide: true })
  assert.match(result.stdout, /"approval_bytes_preserved":true/)
  console.log(result.stdout.trim())
})
