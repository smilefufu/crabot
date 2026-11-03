import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

test('real Electron profile re-selection does not reuse the first directory or cookies', { skip: process.platform === 'win32', timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'crabot-ubuntu-profile-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const env = { ...process.env, CRABOT_UBUNTU_PROFILE_TEST_ROOT: root }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key]
  const { stdout } = await promisify(execFile)(createRequire(import.meta.url)('electron'), [fileURLToPath(new URL('ubuntu-profile.cjs', import.meta.url))], { env, timeout: 20000, maxBuffer: 65536 })
  const line = stdout.split('\n').find(line => line.startsWith('CRABOT_UBUNTU_PROFILE '))
  assert.ok(line, stdout)
  assert.deepEqual(JSON.parse(line.slice('CRABOT_UBUNTU_PROFILE '.length)), { actual_electron: true, old_partition_cache_reproduced: true,
    selected_profile_path: true, cookies_isolated: true, sandbox_preserved: true, business_mm_started: false })
})
